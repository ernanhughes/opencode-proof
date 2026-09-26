import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recomputeProofIdentity } from "../src/artifact";
import { fixtureEvidence, fixtureReceipt, receiptVariant, tempEngine } from "./helpers";

function completeWorld() {
  const engine = tempEngine();
  const evPass = fixtureEvidence();
  const rxPass = fixtureReceipt();
  const built = engine.build({
    claim: rxPass.claim,
    obligations: [
      {
        description: "tests pass",
        claim_id: rxPass.claim.claim_id,
        criterion: rxPass.criterion,
        evidence_ids: rxPass.evidence_ids,
        verification_id: rxPass.verification_id,
      },
    ],
    evidence: [evPass],
    verifications: [rxPass],
  });
  return { engine, evPass, rxPass, proof_id: built.artifact.proof_id };
}

describe("replay", () => {
  test("REPLAY_MATCH on intact artifact with resupplied dependencies", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    const r = engine.replay({ proof_id, evidence: [evPass], verifications: [rxPass] });
    expect(r.replay).toBe("REPLAY_MATCH");
    expect(r.stored_status).toBe("COMPLETE");
    expect(r.derived_status).toBe("COMPLETE");
  });

  test("REPLAY_MATCH via file-resolver store dirs (no inline supply)", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    const evDir = mkdtempSync(join(tmpdir(), "pf-ev-"));
    const vrDir = mkdtempSync(join(tmpdir(), "pf-vr-"));
    mkdirSync(join(evDir, "records"), { recursive: true });
    mkdirSync(join(vrDir, "receipts"), { recursive: true });
    writeFileSync(join(evDir, "records", `${evPass.evidence_id}.json`), JSON.stringify(evPass), "utf8");
    writeFileSync(join(vrDir, "receipts", `${rxPass.verification_id}.json`), JSON.stringify(rxPass), "utf8");
    const r = engine.replay({ proof_id, evidence_store_dir: evDir, verification_store_dir: vrDir });
    expect(r.replay).toBe("REPLAY_MATCH");
  });

  test("J: missing dependency -> MISSING_DEPENDENCY", () => {
    const { engine, proof_id } = completeWorld();
    const r = engine.replay({ proof_id });
    expect(r.replay).toBe("MISSING_DEPENDENCY");
    expect(r.missing?.length).toBeGreaterThan(0);
  });

  test("I: stored status flipped (hash recomputed) -> STATUS_MISMATCH", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    // Tamper that preserves artifact integrity math but contradicts derivation.
    const stored = engine.get(proof_id);
    const flipped = {
      ...stored,
      status: "INCOMPLETE",
      summary: { required: 1, satisfied: 0, violated: 0, unresolved: 1 },
    } as typeof stored;
    const recomputed = recomputeProofIdentity(flipped);
    const poisoned = { ...flipped, proof_id: recomputed.proof_id, content_hash: recomputed.content_hash };
    const engine2 = tempEngine();
    engine2.store.put(poisoned);
    const r = engine2.replay({
      proof_id: poisoned.proof_id,
      evidence: [evPass],
      verifications: [rxPass],
    });
    expect(r.replay).toBe("STATUS_MISMATCH");
    expect(r.stored_status).toBe("INCOMPLETE");
    expect(r.derived_status).toBe("COMPLETE");
  });

  test("stored status flipped without rehashing -> PROOF_INTEGRITY_FAILURE", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    const path = engine.store.proofPath(proof_id);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.status = "FAILED";
    writeFileSync(path, JSON.stringify(parsed), "utf8");
    const r = engine.replay({ proof_id, evidence: [evPass], verifications: [rxPass] });
    expect(r.replay).toBe("PROOF_INTEGRITY_FAILURE");
  });

  test("dependency bytes corrupted on disk -> EVIDENCE_INTEGRITY_FAILURE", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    // A *different but internally valid* record under... ids are content
    // addressed, so substitution means resolving a different id. Instead:
    // resolve the same id from a poisoned file store whose bytes still parse
    // but whose hash no longer matches the bound ref.
    const evDir = mkdtempSync(join(tmpdir(), "pf-evpois-"));
    mkdirSync(join(evDir, "records"), { recursive: true });
    const altered = { ...evPass, observation: { exit_code: 0, extra: "drift" } };
    // Keep the filename (id) but change bytes -> integrity failure on read.
    writeFileSync(join(evDir, "records", `${evPass.evidence_id}.json`), JSON.stringify(altered), "utf8");
    const r = engine.replay({
      proof_id,
      evidence_store_dir: evDir,
      verifications: [rxPass],
    });
    expect(r.replay).toBe("EVIDENCE_INTEGRITY_FAILURE");
  });

  test("tampered receipt dependency -> VERIFICATION_INTEGRITY_FAILURE", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    const vrDir = mkdtempSync(join(tmpdir(), "pf-vrpois-"));
    mkdirSync(join(vrDir, "receipts"), { recursive: true });
    const altered = { ...rxPass, evaluation: { ...rxPass.evaluation, reason_code: "EDITED" } };
    writeFileSync(join(vrDir, "receipts", `${rxPass.verification_id}.json`), JSON.stringify(altered), "utf8");
    const r = engine.replay({
      proof_id,
      evidence: [evPass],
      verification_store_dir: vrDir,
    });
    expect(r.replay).toBe("VERIFICATION_INTEGRITY_FAILURE");
  });

  test("receipt verdict flipped with rehashed receipt -> substitution fails closed", () => {
    const { engine, evPass, rxPass, proof_id } = completeWorld();
    // Attacker flips receipt verdict AND recomputes receipt hashes. The
    // forged receipt carries a NEW id, so it cannot substitute for the bound
    // one: replay reports the bound receipt missing. Fail-closed either way.
    const forged = receiptVariant(rxPass, {
      verdict: "INCONCLUSIVE",
      result: "UNKNOWN",
      reason_code: "EVIDENCE_FIELD_MISSING",
    });
    expect(forged.verification_id).not.toBe(rxPass.verification_id);
    const r = engine.replay({ proof_id, evidence: [evPass], verifications: [forged] });
    expect(r.replay).toBe("MISSING_DEPENDENCY");
    expect(r.missing).toContain(rxPass.verification_id);
  });

  test("unknown proof id throws (tool maps to ok:false)", () => {
    const { engine } = completeWorld();
    try {
      engine.replay({ proof_id: `pf_${"a".repeat(64)}` });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("PROOF_NOT_FOUND");
    }
  });
});
