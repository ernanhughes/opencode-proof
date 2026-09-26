import { canonicalize, sha256Hex } from "./canonical";
import { SUPPORTED_EVIDENCE_SCHEMAS } from "./version";

/**
 * Read-only Evidence contract, pinned to opencode-evidence@88cc2e6.
 * Vendored validation + integrity rules. Proof NEVER writes, mutates, or
 * authors evidence records — it validates supplied bytes and recomputes
 * hashes. Anything failing is a build/replay error, never proof content.
 */

export type EvidenceKind =
  | "command_result"
  | "file_observation"
  | "test_result"
  | "http_observation"
  | "git_observation"
  | "structured_observation"
  | "other";

export const EVIDENCE_KINDS: readonly string[] = [
  "command_result",
  "file_observation",
  "test_result",
  "http_observation",
  "git_observation",
  "structured_observation",
  "other",
];

export type EvidenceRecord = {
  schema: string;
  evidence_id: string;
  kind: EvidenceKind;
  subject?: string;
  observation: unknown;
  source: { kind: string; locator?: string; version?: string };
  observed_at: string;
  content_hash: string;
  producer: { plugin: string; version: string };
  metadata?: Record<string, unknown>;
};

const FORBIDDEN_TOP_LEVEL_FIELDS: readonly string[] = [
  "verified",
  "verdict",
  "confidence",
  "trust_score",
  "claim_verified",
  "task_verified",
  "task_success",
  "proves",
  "proof",
  "valid",
  "success",
];

export const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{32}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type EvidenceValidation =
  | { ok: true; record: EvidenceRecord }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): EvidenceValidation {
  return { ok: false, code, message };
}

export function validateEvidenceRecord(parsed: unknown): EvidenceValidation {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("INVALID_EVIDENCE", "evidence record must be a JSON object");
  }
  const rec = parsed as Record<string, unknown>;
  for (const field of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (rec[field] !== undefined) {
      return fail("INVALID_EVIDENCE", `evidence record must not carry top-level verdict field "${field}"`);
    }
  }
  if (typeof rec["schema"] !== "string") {
    return fail("INVALID_EVIDENCE", "evidence record schema must be a string");
  }
  if (!SUPPORTED_EVIDENCE_SCHEMAS.includes(rec["schema"])) {
    return fail(
      "UNSUPPORTED_EVIDENCE_SCHEMA",
      `unsupported evidence schema "${String(rec["schema"])}" (supported: ${SUPPORTED_EVIDENCE_SCHEMAS.join(", ")})`,
    );
  }
  if (typeof rec["evidence_id"] !== "string" || !EVIDENCE_ID_PATTERN.test(rec["evidence_id"])) {
    return fail("INVALID_EVIDENCE", "evidence_id must match /^ev_[0-9a-f]{32}$/");
  }
  if (typeof rec["kind"] !== "string" || !EVIDENCE_KINDS.includes(rec["kind"])) {
    return fail("INVALID_EVIDENCE", `kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
  }
  if (rec["subject"] !== undefined && typeof rec["subject"] !== "string") {
    return fail("INVALID_EVIDENCE", "subject must be a string when present");
  }
  if (rec["observation"] === undefined) {
    return fail("INVALID_EVIDENCE", "observation must be present");
  }
  const source = rec["source"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return fail("INVALID_EVIDENCE", "source must be an object");
  }
  const src = source as Record<string, unknown>;
  if (typeof src["kind"] !== "string" || src["kind"].length === 0) {
    return fail("INVALID_EVIDENCE", "source.kind must be a non-empty string");
  }
  if (src["locator"] !== undefined && typeof src["locator"] !== "string") {
    return fail("INVALID_EVIDENCE", "source.locator must be a string when present");
  }
  if (src["version"] !== undefined && typeof src["version"] !== "string") {
    return fail("INVALID_EVIDENCE", "source.version must be a string when present");
  }
  if (typeof rec["observed_at"] !== "string" || Number.isNaN(Date.parse(rec["observed_at"]))) {
    return fail("INVALID_EVIDENCE", "observed_at must be a parseable timestamp string");
  }
  if (typeof rec["content_hash"] !== "string" || !CONTENT_HASH_PATTERN.test(rec["content_hash"])) {
    return fail("INVALID_EVIDENCE", "content_hash must be 64 lowercase hex chars");
  }
  const producer = rec["producer"];
  if (typeof producer !== "object" || producer === null || Array.isArray(producer)) {
    return fail("INVALID_EVIDENCE", "producer must be an object");
  }
  const prod = producer as Record<string, unknown>;
  if (prod["plugin"] !== "opencode-evidence") {
    return fail("INVALID_EVIDENCE", `producer.plugin must be "opencode-evidence"`);
  }
  if (typeof prod["version"] !== "string" || prod["version"].length === 0) {
    return fail("INVALID_EVIDENCE", "producer.version must be a non-empty string");
  }
  if (
    rec["metadata"] !== undefined &&
    (typeof rec["metadata"] !== "object" || rec["metadata"] === null || Array.isArray(rec["metadata"]))
  ) {
    return fail("INVALID_EVIDENCE", "metadata must be an object when present");
  }
  return { ok: true, record: parsed as EvidenceRecord };
}

export function evidenceIdentityInput(record: EvidenceRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    observation: record.observation,
    source: {
      kind: record.source.kind,
      locator: record.source.locator ?? null,
      version: record.source.version ?? null,
    },
    subject: record.subject ?? null,
  };
}

export function recomputeEvidenceHash(record: EvidenceRecord): string {
  return sha256Hex(canonicalize(evidenceIdentityInput(record)));
}

export function deriveEvidenceId(contentHash: string): string {
  return `ev_${contentHash.slice(0, 32)}`;
}

export type EvidenceIntegrity =
  | { ok: true; recomputed_hash: string }
  | { ok: false; code: string; message: string };

export function checkEvidenceIntegrity(record: EvidenceRecord): EvidenceIntegrity {
  const structural = validateEvidenceRecord(record);
  if (!structural.ok) {
    return { ok: false, code: structural.code, message: structural.message };
  }
  const recomputed_hash = recomputeEvidenceHash(record);
  if (recomputed_hash !== record.content_hash) {
    return {
      ok: false,
      code: "EVIDENCE_INTEGRITY_FAILURE",
      message: `stored content_hash ${record.content_hash} != recomputed ${recomputed_hash}`,
    };
  }
  if (`ev_${recomputed_hash.slice(0, 32)}` !== record.evidence_id) {
    return {
      ok: false,
      code: "EVIDENCE_INTEGRITY_FAILURE",
      message: `stored evidence_id ${record.evidence_id} does not derive from content_hash`,
    };
  }
  return { ok: true, recomputed_hash };
}
