import { canonicalize, sha256Hex } from "./canonical";
import type { ProofObligation } from "./obligation";
import type { Claim } from "./verify-contract";
import { PLUGIN_ID, PLUGIN_VERSION, PROOF_SCHEMA } from "./version";

export type ProofClass = "EMPIRICAL" | "FORMAL" | "COMPOSITE";
export type ProofStatus = "COMPLETE" | "FAILED" | "INCOMPLETE";

export const PROOF_STATUSES: readonly string[] = ["COMPLETE", "FAILED", "INCOMPLETE"];

export type EvidenceRef = { evidence_id: string; content_hash: string };
export type VerificationRef = { verification_id: string; content_hash: string };

export type ProofArtifact = {
  schema: typeof PROOF_SCHEMA;
  proof_id: string;
  proof_class: "EMPIRICAL";
  claim: Claim;
  obligations: ProofObligation[];
  evidence: EvidenceRef[];
  verifications: VerificationRef[];
  status: ProofStatus;
  summary: {
    required: number;
    satisfied: number;
    violated: number;
    unresolved: number;
  };
  assembled_at: string;
  producer: {
    plugin: typeof PLUGIN_ID;
    version: string;
  };
  content_hash: string;
};

/**
 * Artifact-level prohibited fields. The artifact reports obligation status;
 * task completion, authority, truth, intent, and confidence belong to other
 * components or to no deterministic component. Metadata cannot smuggle them
 * in: there is no free-form metadata field on the artifact at all.
 */
const FORBIDDEN_PROOF_FIELDS: readonly string[] = [
  "task_complete",
  "task_completed",
  "task_success",
  "work_complete",
  "authorized",
  "allowed",
  "denied",
  "deploy_allowed",
  "deployment_allowed",
  "truth",
  "universally_true",
  "intent_satisfied",
  "confidence",
  "trust_score",
  "formal_proof",
  "theorem",
  "qed",
];

export const PROOF_ID_PATTERN = /^pf_[0-9a-f]{64}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Proof identity (v0.1):
 * proof_id = "pf_" + sha256(canonical({
 *   schema, proof_class, claim, obligations(sorted by obligation_id),
 *   evidence refs(sorted by evidence_id), verification refs(sorted),
 *   status, summary, producer{plugin, version}
 * }))
 *
 * Note: full 64-hex (not truncated): proofs aggregate many dependencies and
 * long truncation aids nothing here. Included: everything that determines
 * what the artifact declares. Excluded: assembled_at (annotation,
 * first-write-wins like the family convention) and storage path.
 *
 * content_hash covers the same decision inputs minus content_hash itself
 * and minus assembled_at. assembled_at-only tampering is therefore not
 * hash-detectable — annotation, not argument (same convention as Evidence
 * observed_at and Verify evaluated_at).
 */
export function proofIdentityInput(input: {
  claim: Claim;
  obligations: ProofObligation[];
  evidence: EvidenceRef[];
  verifications: VerificationRef[];
  status: ProofStatus;
  summary: ProofArtifact["summary"];
  producerVersion: string;
}): Record<string, unknown> {
  const normObligation = (o: ProofObligation) => ({
    claim_id: o.claim_id,
    criterion: o.criterion,
    description: o.description,
    evidence_ids: [...o.evidence_ids].sort(),
    obligation_id: o.obligation_id,
    required: o.required,
    verification_id: o.verification_id,
  });
  return {
    claim: {
      claim_id: input.claim.claim_id,
      scope: input.claim.scope ?? null,
      statement: input.claim.statement,
      subject: input.claim.subject ?? null,
    },
    evidence: [...input.evidence]
      .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : 1))
      .map((e) => ({ content_hash: e.content_hash, evidence_id: e.evidence_id })),
    obligations: [...input.obligations]
      .sort((a, b) => (a.obligation_id < b.obligation_id ? -1 : 1))
      .map(normObligation),
    producer: { plugin: PLUGIN_ID, version: input.producerVersion },
    proof_class: "EMPIRICAL",
    schema: PROOF_SCHEMA,
    status: input.status,
    summary: {
      required: input.summary.required,
      satisfied: input.summary.satisfied,
      unresolved: input.summary.unresolved,
      violated: input.summary.violated,
    },
    verifications: [...input.verifications]
      .sort((a, b) => (a.verification_id < b.verification_id ? -1 : 1))
      .map((v) => ({ content_hash: v.content_hash, verification_id: v.verification_id })),
  };
}

export function deriveProofId(identityInput: Record<string, unknown>): string {
  return `pf_${sha256Hex(canonicalize(identityInput))}`;
}

function proofBodyHash(artifact: Record<string, unknown>): string {
  const { content_hash: _hashOmitted, assembled_at: _timeOmitted, ...body } = artifact;
  return sha256Hex(canonicalize(body));
}

export function buildArtifact(input: {
  claim: Claim;
  obligations: ProofObligation[];
  evidence: EvidenceRef[];
  verifications: VerificationRef[];
  status: ProofStatus;
  summary: ProofArtifact["summary"];
  assembled_at?: string;
  producerVersion?: string;
}): ProofArtifact {
  const producerVersion = input.producerVersion ?? PLUGIN_VERSION;
  const identity = proofIdentityInput({
    claim: input.claim,
    obligations: input.obligations,
    evidence: input.evidence,
    verifications: input.verifications,
    status: input.status,
    summary: input.summary,
    producerVersion,
  });
  const assembled_at = input.assembled_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(assembled_at))) {
    throw new Error("INVALID_PROOF_TIME: assembled_at must be a parseable timestamp string");
  }
  const artifact: ProofArtifact = {
    schema: PROOF_SCHEMA,
    proof_id: deriveProofId(identity),
    proof_class: "EMPIRICAL",
    claim: input.claim,
    obligations: [...input.obligations].sort((a, b) =>
      a.obligation_id < b.obligation_id ? -1 : 1,
    ),
    evidence: [...input.evidence].sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : 1)),
    verifications: [...input.verifications].sort((a, b) =>
      a.verification_id < b.verification_id ? -1 : 1,
    ),
    status: input.status,
    summary: { ...input.summary },
    assembled_at,
    producer: { plugin: PLUGIN_ID, version: producerVersion },
    content_hash: "",
  };
  artifact.content_hash = proofBodyHash(artifact as unknown as Record<string, unknown>);
  return artifact;
}

export type ArtifactValidation =
  | { ok: true; artifact: ProofArtifact }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): ArtifactValidation {
  return { ok: false, code, message };
}

/** Structural validation of a parsed artifact. Never judges its status. */
export function validateArtifact(parsed: unknown): ArtifactValidation {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("PROOF_MALFORMED", "artifact must be a JSON object");
  }
  const a = parsed as Record<string, unknown>;
  for (const field of FORBIDDEN_PROOF_FIELDS) {
    if (a[field] !== undefined) {
      return fail("PROOF_FORBIDDEN_FIELD", `artifact must not carry "${field}"`);
    }
  }
  if (a["schema"] !== PROOF_SCHEMA) {
    return fail("PROOF_SCHEMA_MISMATCH", `artifact schema must be "${PROOF_SCHEMA}"`);
  }
  if (typeof a["proof_id"] !== "string" || !PROOF_ID_PATTERN.test(a["proof_id"])) {
    return fail("PROOF_BAD_ID", "proof_id must match /^pf_[0-9a-f]{64}$/");
  }
  if (a["proof_class"] !== "EMPIRICAL") {
    return fail(
      "PROOF_CLASS_UNSUPPORTED",
      `proof_class "${String(a["proof_class"])}" is reserved but not buildable in v0.1 (only EMPIRICAL)`,
    );
  }
  if (typeof a["claim"] !== "object" || a["claim"] === null) {
    return fail("PROOF_BAD_CLAIM", "claim must be an object");
  }
  if (!Array.isArray(a["obligations"]) || a["obligations"].length === 0) {
    return fail("PROOF_BAD_OBLIGATIONS", "obligations must be a non-empty array");
  }
  if (!Array.isArray(a["evidence"])) {
    return fail("PROOF_BAD_EVIDENCE", "evidence must be an array of {evidence_id, content_hash}");
  }
  for (const ref of a["evidence"] as unknown[]) {
    if (
      typeof ref !== "object" ||
      ref === null ||
      typeof (ref as Record<string, unknown>)["evidence_id"] !== "string" ||
      typeof (ref as Record<string, unknown>)["content_hash"] !== "string"
    ) {
      return fail("PROOF_BAD_EVIDENCE", "each evidence ref must carry evidence_id and content_hash strings");
    }
  }
  if (!Array.isArray(a["verifications"])) {
    return fail("PROOF_BAD_VERIFICATIONS", "verifications must be an array of {verification_id, content_hash}");
  }
  for (const ref of a["verifications"] as unknown[]) {
    if (
      typeof ref !== "object" ||
      ref === null ||
      typeof (ref as Record<string, unknown>)["verification_id"] !== "string" ||
      typeof (ref as Record<string, unknown>)["content_hash"] !== "string"
    ) {
      return fail("PROOF_BAD_VERIFICATIONS", "each verification ref must carry verification_id and content_hash strings");
    }
  }
  if (typeof a["status"] !== "string" || !PROOF_STATUSES.includes(a["status"])) {
    return fail("PROOF_BAD_STATUS", "status must be one of COMPLETE, FAILED, INCOMPLETE");
  }
  const summary = a["summary"];
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
    return fail("PROOF_BAD_SUMMARY", "summary must be an object");
  }
  for (const key of ["required", "satisfied", "violated", "unresolved"] as const) {
    if (typeof (summary as Record<string, unknown>)[key] !== "number") {
      return fail("PROOF_BAD_SUMMARY", `summary.${key} must be a number`);
    }
  }
  if (typeof a["assembled_at"] !== "string" || Number.isNaN(Date.parse(a["assembled_at"]))) {
    return fail("PROOF_BAD_TIME", "assembled_at must be a parseable timestamp string");
  }
  const producer = a["producer"];
  if (typeof producer !== "object" || producer === null || Array.isArray(producer)) {
    return fail("PROOF_BAD_PRODUCER", "producer must be an object");
  }
  const pp = producer as Record<string, unknown>;
  if (pp["plugin"] !== PLUGIN_ID) {
    return fail("PROOF_BAD_PRODUCER", `producer.plugin must be "${PLUGIN_ID}"`);
  }
  if (typeof pp["version"] !== "string" || pp["version"].length === 0) {
    return fail("PROOF_BAD_PRODUCER", "producer.version must be a non-empty string");
  }
  if (typeof a["content_hash"] !== "string" || !CONTENT_HASH_PATTERN.test(a["content_hash"])) {
    return fail("PROOF_BAD_HASH", "content_hash must be 64 lowercase hex chars");
  }
  return { ok: true, artifact: parsed as ProofArtifact };
}

export type ArtifactIntegrity =
  | { ok: true; recomputed_id: string; recomputed_hash: string }
  | { ok: false; code: string; message: string };

/**
 * Recompute proof_id + content_hash from fields (the v0.1 proof math).
 * Exported so tests derive tamper variants through the real algorithm.
 */
export function recomputeProofIdentity(artifact: ProofArtifact): {
  proof_id: string;
  content_hash: string;
} {
  const identity = proofIdentityInput({
    claim: artifact.claim,
    obligations: artifact.obligations,
    evidence: artifact.evidence,
    verifications: artifact.verifications,
    status: artifact.status,
    summary: artifact.summary,
    producerVersion: artifact.producer.version,
  });
  // Order matters: the body hash covers proof_id — derived id goes in first.
  const proof_id = deriveProofId(identity);
  const content_hash = proofBodyHash({ ...artifact, proof_id } as unknown as Record<string, unknown>);
  return { proof_id, content_hash };
}

/** Recompute proof_id and content_hash; any mismatch is tampering. */
export function checkArtifactIntegrity(artifact: ProofArtifact): ArtifactIntegrity {
  const structural = validateArtifact(artifact);
  if (!structural.ok) {
    return { ok: false, code: structural.code, message: structural.message };
  }
  const recomputed = recomputeProofIdentity(artifact);
  if (recomputed.proof_id !== artifact.proof_id) {
    return {
      ok: false,
      code: "PROOF_ID_MISMATCH",
      message: `stored proof_id ${artifact.proof_id} != recomputed ${recomputed.proof_id}`,
    };
  }
  if (recomputed.content_hash !== artifact.content_hash) {
    return {
      ok: false,
      code: "PROOF_HASH_MISMATCH",
      message: "stored content_hash does not match artifact body",
    };
  }
  return { ok: true, recomputed_id: recomputed.proof_id, recomputed_hash: recomputed.content_hash };
}
