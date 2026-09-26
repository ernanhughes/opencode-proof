import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofEngine } from "../src/engine";
import {
  deriveEvidenceId,
  recomputeEvidenceHash,
  type EvidenceRecord,
} from "../src/evidence-contract";
import { normalizeObligation } from "../src/obligation";
import {
  recomputeReceiptIdentity,
  type VerificationReceipt,
} from "../src/verify-contract";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

export function loadFixture(name: "evidence-example.json" | "receipt-example.json"): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

export function fixtureEvidence(): EvidenceRecord {
  return loadFixture("evidence-example.json") as EvidenceRecord;
}

export function fixtureReceipt(): VerificationReceipt {
  return loadFixture("receipt-example.json") as VerificationReceipt;
}

export function tempEngine(): ProofEngine {
  return new ProofEngine(mkdtempSync(join(tmpdir(), "pf-t-proj-")), {
    store_dir: mkdtempSync(join(tmpdir(), "pf-t-store-")),
  });
}

/**
 * Derive an evidence variant through the pinned upstream hash math:
 * replace the observation, recompute content_hash + evidence_id.
 * Used to build FAIL/INCONCLUSIVE worlds without re-running upstream code.
 */
export function evidenceVariant(base: EvidenceRecord, observation: unknown): EvidenceRecord {
  const draft = { ...base, observation };
  const content_hash = recomputeEvidenceHash(draft);
  return { ...draft, content_hash, evidence_id: deriveEvidenceId(content_hash) };
}

/**
 * Derive a receipt variant through the pinned upstream identity math:
 * override fields, recompute verification_id + content_hash.
 */
export function receiptVariant(
  base: VerificationReceipt,
  overrides: Partial<{
    verdict: VerificationReceipt["verdict"];
    result: "TRUE" | "FALSE" | "UNKNOWN";
    reason_code: string;
    evidence_ids: string[];
    evidence_hashes: Record<string, string>;
    claim: VerificationReceipt["claim"];
    criterion: VerificationReceipt["criterion"];
  }>,
): VerificationReceipt {
  const draft: VerificationReceipt = {
    ...base,
    ...(overrides.verdict !== undefined ? { verdict: overrides.verdict } : {}),
    evaluation: {
      ...base.evaluation,
      ...(overrides.result !== undefined ? { result: overrides.result } : {}),
      ...(overrides.reason_code !== undefined ? { reason_code: overrides.reason_code } : {}),
    },
    ...(overrides.evidence_ids !== undefined ? { evidence_ids: overrides.evidence_ids } : {}),
    ...(overrides.evidence_hashes !== undefined ? { evidence_hashes: overrides.evidence_hashes } : {}),
    ...(overrides.claim !== undefined ? { claim: overrides.claim } : {}),
    ...(overrides.criterion !== undefined ? { criterion: overrides.criterion } : {}),
  };
  const recomputed = recomputeReceiptIdentity(draft);
  return { ...draft, verification_id: recomputed.verification_id, content_hash: recomputed.content_hash };
}

/** Build a normalized obligation binding the fixture receipt's world. */
export function fixtureObligation(
  description: string,
  receipt: VerificationReceipt,
  opts: { required?: boolean; claim_id?: string; criterion?: unknown; evidence_ids?: string[] } = {},
) {
  const normalized = normalizeObligation({
    description,
    claim_id: opts.claim_id ?? receipt.claim.claim_id,
    criterion: opts.criterion ?? receipt.criterion,
    evidence_ids: opts.evidence_ids ?? receipt.evidence_ids,
    verification_id: receipt.verification_id,
    ...(opts.required !== undefined ? { required: opts.required } : {}),
  });
  if (!normalized.ok) throw new Error(`bad test obligation: ${normalized.message}`);
  return normalized.obligation;
}
