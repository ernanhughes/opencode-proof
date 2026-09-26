import { describe, expect, test } from "bun:test";
import {
  checkEvidenceIntegrity,
  recomputeEvidenceHash,
  validateEvidenceRecord,
} from "../src/evidence-contract";
import {
  checkReceiptIntegrity,
  normalizeClaim,
  recomputeReceiptIdentity,
  validateCriterion,
  validateReceipt,
} from "../src/verify-contract";
import { canonicalize } from "../src/canonical";
import { evidenceVariant, fixtureEvidence, fixtureReceipt, receiptVariant } from "./helpers";

/**
 * Fixtures are byte-identical to the real upstream artifacts:
 * - tests/fixtures/evidence-example.json == opencode-evidence@88cc2e6 evidence.example.json
 * - tests/fixtures/receipt-example.json == opencode-verify@a341298 receipt.example.json
 * If vendored contracts drift, these fail.
 */
describe("upstream Evidence compatibility", () => {
  test("real upstream record validates + hash/id reproduce byte-exactly", () => {
    const v = validateEvidenceRecord(fixtureEvidence());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(recomputeEvidenceHash(v.record)).toBe(v.record.content_hash);
    expect(v.record.evidence_id).toBe("ev_e2da7b2f71a12f38894de2350ab5373a");
    expect(checkEvidenceIntegrity(v.record).ok).toBe(true);
  });

  test("tampered observation fails integrity; wrong schema fails clearly", () => {
    const tampered = { ...fixtureEvidence(), observation: { exit_code: 999 } };
    const v = validateEvidenceRecord(tampered);
    expect(v.ok).toBe(true);
    if (v.ok) expect(checkEvidenceIntegrity(v.record).ok).toBe(false);
    const wrongSchema = { ...fixtureEvidence(), schema: "opencode.evidence.v9" };
    const w = validateEvidenceRecord(wrongSchema);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.code).toBe("UNSUPPORTED_EVIDENCE_SCHEMA");
  });

  test("variant derivation preserves integrity (pinned math is self-consistent)", () => {
    const variant = evidenceVariant(fixtureEvidence(), { command: "tsc --noEmit", exit_code: 0 });
    expect(variant.evidence_id).not.toBe(fixtureEvidence().evidence_id);
    expect(checkEvidenceIntegrity(variant).ok).toBe(true);
  });
});

describe("upstream Verify compatibility", () => {
  test("real upstream receipt validates + id/hash reproduce byte-exactly", () => {
    const v = validateReceipt(fixtureReceipt());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const recomputed = recomputeReceiptIdentity(v.receipt);
    expect(recomputed.verification_id).toBe("vr_bf0cbcf250f3dd2d9317e951ab96ef50");
    expect(recomputed.verification_id).toBe(v.receipt.verification_id);
    expect(recomputed.content_hash).toBe(v.receipt.content_hash);
    expect(checkReceiptIntegrity(v.receipt).ok).toBe(true);
  });

  test("receipt binds the evidence fixture (cross-artifact chain is real)", () => {
    const receipt = fixtureReceipt();
    expect(receipt.evidence_ids).toEqual([fixtureEvidence().evidence_id]);
    expect(receipt.evidence_hashes[fixtureEvidence().evidence_id]).toBe(
      fixtureEvidence().content_hash,
    );
    expect(receipt.verdict).toBe("PASS");
  });

  test("tampered verdict fails; wrong schema fails clearly", () => {
    const tampered = { ...fixtureReceipt(), verdict: "FAIL" };
    const v = validateReceipt(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("RECEIPT_VERDICT_MISMATCH");
    const wrongSchema = { ...fixtureReceipt(), schema: "opencode.verification.v9" };
    const w = validateReceipt(wrongSchema);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.code).toBe("UNSUPPORTED_VERIFICATION_SCHEMA");
  });

  test("claim normalization + criterion normalization match receipt bytes", () => {
    const receipt = fixtureReceipt();
    const claim = normalizeClaim(receipt.claim);
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(canonicalize(claim.claim)).toBe(canonicalize(receipt.claim));
    const criterion = validateCriterion(receipt.criterion);
    expect(criterion.ok).toBe(true);
    if (criterion.ok) {
      // Normalized obligation criteria must canonical-match receipt criteria.
      expect(canonicalize(criterion.criterion)).toBe(canonicalize(receipt.criterion));
    }
  });

  test("receipt variant derivation preserves integrity", () => {
    const fail = receiptVariant(fixtureReceipt(), {
      verdict: "FAIL",
      result: "FALSE",
      reason_code: "CRITERION_VIOLATED",
    });
    expect(fail.verification_id).not.toBe(fixtureReceipt().verification_id);
    expect(checkReceiptIntegrity(fail).ok).toBe(true);
  });
});
