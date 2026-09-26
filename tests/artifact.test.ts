import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArtifact,
  checkArtifactIntegrity,
  recomputeProofIdentity,
  validateArtifact,
} from "../src/artifact";
import { ProofStore } from "../src/store";
import { normalizeClaim } from "../src/verify-contract";
import { fixtureEvidence, fixtureObligation, fixtureReceipt, tempEngine } from "./helpers";

function sampleArtifact() {
  const receipt = fixtureReceipt();
  const claim = normalizeClaim(receipt.claim);
  if (!claim.ok) throw new Error("bad fixture claim");
  const obligation = fixtureObligation("tests pass", receipt);
  return buildArtifact({
    claim: claim.claim,
    obligations: [obligation],
    evidence: [{ evidence_id: receipt.evidence_ids[0] as string, content_hash: receipt.evidence_hashes[receipt.evidence_ids[0] as string] as string }],
    verifications: [{ verification_id: receipt.verification_id, content_hash: receipt.content_hash }],
    status: "COMPLETE",
    summary: { required: 1, satisfied: 1, violated: 0, unresolved: 0 },
    assembled_at: "2026-09-27T00:00:00.000Z",
  });
}

describe("artifact identity and integrity", () => {
  test("same inputs -> same proof_id even at different assembly times", () => {
    const a = sampleArtifact();
    expect(a.proof_id).toMatch(/^pf_[0-9a-f]{64}$/);
    expect(checkArtifactIntegrity(a).ok).toBe(true);
    expect(recomputeProofIdentity(a).proof_id).toBe(a.proof_id);
    expect(recomputeProofIdentity(a).content_hash).toBe(a.content_hash);
  });

  test("assembled_at alone is annotation (mirrors family convention)", () => {
    const a = sampleArtifact();
    const retimed = { ...a, assembled_at: "2030-01-01T00:00:00.000Z" };
    expect(checkArtifactIntegrity(retimed as never).ok).toBe(true);
    const tampered = { ...a, status: "FAILED" };
    expect(checkArtifactIntegrity(tampered as never).ok).toBe(false);
  });

  test("forbidden fields rejected (task/authority/truth/intent/confidence/formal)", () => {
    const a = sampleArtifact();
    for (const field of [
      "task_complete",
      "task_completed",
      "authorized",
      "allowed",
      "truth",
      "universally_true",
      "intent_satisfied",
      "confidence",
      "deployment_allowed",
      "formal_proof",
      "theorem",
      "qed",
    ]) {
      const bad = { ...a, [field]: true };
      const v = validateArtifact(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("PROOF_FORBIDDEN_FIELD");
    }
  });

  test("non-EMPIRICAL classes validate as reserved-but-unbuildable", () => {
    const a = sampleArtifact();
    for (const cls of ["FORMAL", "COMPOSITE", "VIBES"]) {
      const v = validateArtifact({ ...a, proof_class: cls });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("PROOF_CLASS_UNSUPPORTED");
    }
  });

  test("bad status/summary/producer rejected", () => {
    const a = sampleArtifact();
    expect(validateArtifact({ ...a, status: "TRUE" }).ok).toBe(false);
    expect(validateArtifact({ ...a, summary: { ...a.summary, satisfied: "many" } }).ok).toBe(false);
    expect(validateArtifact({ ...a, obligations: [] }).ok).toBe(false);
    expect(validateArtifact({ ...a, proof_id: "pf_short" }).ok).toBe(false);
  });

  test("store round-trip, idempotent re-store, collision-loud, read-only get", () => {
    const store = new ProofStore(mkdtempSync(join(tmpdir(), "pf-rs-")));
    const a = sampleArtifact();
    const put = store.put(a);
    expect(put.duplicate).toBe(false);
    expect(store.get(a.proof_id)).toEqual(a);
    expect(store.put(a).duplicate).toBe(true);
    const path = store.proofPath(a.proof_id);
    const before = statSync(path).mtimeMs;
    store.get(a.proof_id);
    expect(statSync(path).mtimeMs).toBe(before);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.status = "FAILED";
    writeFileSync(path, JSON.stringify(parsed), "utf8");
    expect(() => store.put(a)).toThrow("PROOF_ID_COLLISION");
    expect(() => store.get(`pf_${"f".repeat(64)}`)).toThrow("PROOF_NOT_FOUND");
    expect(() => store.get("bogus")).toThrow("PROOF_BAD_ID");
  });

  test("engine re-build is idempotent first-write-wins", () => {
    const engine = tempEngine();
    const receipt = fixtureReceipt();
    const base = {
      claim: receipt.claim,
      obligations: [
        {
          description: "tests pass",
          claim_id: receipt.claim.claim_id,
          criterion: receipt.criterion,
          evidence_ids: receipt.evidence_ids,
          verification_id: receipt.verification_id,
        },
      ],
      evidence: [fixtureEvidence()],
      verifications: [receipt],
    };
    const first = engine.build({ ...base, assembled_at: "2026-01-01T00:00:00.000Z" });
    const second = engine.build({ ...base, assembled_at: "2026-09-27T00:00:00.000Z" });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.artifact).toEqual(first.artifact);
  });
});
