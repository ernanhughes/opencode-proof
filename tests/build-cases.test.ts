import { describe, expect, test } from "bun:test";
import { ProofError } from "../src/engine";
import {
  evidenceVariant,
  fixtureEvidence,
  fixtureObligation,
  fixtureReceipt,
  receiptVariant,
  tempEngine,
} from "./helpers";

function world() {
  const engine = tempEngine();
  const evPass = fixtureEvidence();
  const rxPass = fixtureReceipt();
  // FAIL world: exit_code 1 evidence + FAIL receipt bound to it.
  const evFail = evidenceVariant(evPass, { command: "bun test", exit_code: 1 });
  const rxFail = receiptVariant(rxPass, {
    verdict: "FAIL",
    result: "FALSE",
    reason_code: "CRITERION_VIOLATED",
    evidence_ids: [evFail.evidence_id],
    evidence_hashes: { [evFail.evidence_id]: evFail.content_hash },
  });
  // UNRESOLVED world: record without exit_code + INCONCLUSIVE receipt.
  const evUnknown = evidenceVariant(evPass, { command: "bun test" });
  const rxUnknown = receiptVariant(rxPass, {
    verdict: "INCONCLUSIVE",
    result: "UNKNOWN",
    reason_code: "EVIDENCE_FIELD_MISSING",
    evidence_ids: [evUnknown.evidence_id],
    evidence_hashes: { [evUnknown.evidence_id]: evUnknown.content_hash },
  });
  return { engine, evPass, rxPass, evFail, rxFail, evUnknown, rxUnknown };
}

function obligationFor(description: string, receipt: { claim: { claim_id: string }; criterion: unknown; evidence_ids: string[]; verification_id: string }, opts: { required?: boolean } = {}) {
  return {
    description,
    claim_id: receipt.claim.claim_id,
    criterion: receipt.criterion,
    evidence_ids: receipt.evidence_ids,
    verification_id: receipt.verification_id,
    ...(opts.required !== undefined ? { required: opts.required } : {}),
  };
}

describe("proof status derivation", () => {
  test("A: all required PASS -> COMPLETE", () => {
    const { engine, evPass, rxPass } = world();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [obligationFor("tests pass", rxPass), obligationFor("tests pass again", rxPass)],
      evidence: [evPass],
      verifications: [rxPass],
    });
    expect(built.artifact.status).toBe("COMPLETE");
    expect(built.artifact.summary).toEqual({ required: 2, satisfied: 2, violated: 0, unresolved: 0 });
    expect(built.obligation_statuses.every((o) => o.status === "SATISFIED")).toBe(true);
    expect(built.artifact.proof_class).toBe("EMPIRICAL");
  });

  test("B: one required FAIL -> FAILED", () => {
    const { engine, evPass, rxPass, evFail, rxFail } = world();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [obligationFor("tests pass", rxPass), obligationFor("alt world fails", rxFail)],
      evidence: [evPass, evFail],
      verifications: [rxPass, rxFail],
    });
    expect(built.artifact.status).toBe("FAILED");
    expect(built.artifact.summary).toEqual({ required: 2, satisfied: 1, violated: 1, unresolved: 0 });
  });

  test("C: unresolved, none violated -> INCOMPLETE", () => {
    const { engine, evPass, rxPass, evUnknown, rxUnknown } = world();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [obligationFor("tests pass", rxPass), obligationFor("unknown field", rxUnknown)],
      evidence: [evPass, evUnknown],
      verifications: [rxPass, rxUnknown],
    });
    expect(built.artifact.status).toBe("INCOMPLETE");
    expect(built.artifact.summary).toEqual({ required: 2, satisfied: 1, violated: 0, unresolved: 1 });
  });

  test("optional obligations do not affect status", () => {
    const { engine, evPass, rxPass, evFail, rxFail } = world();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [
        obligationFor("tests pass", rxPass),
        obligationFor("optional failure", rxFail, { required: false }),
      ],
      evidence: [evPass, evFail],
      verifications: [rxPass, rxFail],
    });
    expect(built.artifact.status).toBe("COMPLETE");
    expect(built.artifact.summary).toEqual({ required: 1, satisfied: 1, violated: 0, unresolved: 0 });
    expect(built.obligation_statuses.find((o) => !o.required)?.status).toBe("VIOLATED");
  });

  test("specification gap: COMPLETE over declared obligations, silent on undeclared intent", () => {
    // The proof is COMPLETE over what was declared — and contains no trace
    // of the undeclared requirement (backward compatibility). This pins the
    // gap as correct behavior: no future change may silently "fix" it by
    // inventing obligations.
    const { engine, evPass, rxPass } = world();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [obligationFor("tests pass", rxPass)],
      evidence: [evPass],
      verifications: [rxPass],
    });
    expect(built.artifact.status).toBe("COMPLETE");
    const serialized = JSON.stringify(built.artifact).toLowerCase();
    expect(serialized.includes("backward")).toBe(false);
    expect(serialized.includes("compat")).toBe(false);
    expect(built.artifact.obligations).toHaveLength(1);
  });
});

describe("build errors (invalid construction is ERROR, never status)", () => {
  test("D: tampered evidence -> ERROR", () => {
    const { engine, evPass, rxPass } = world();
    const tampered = { ...evPass, observation: { exit_code: 0, injected: true } };
    try {
      engine.build({
        claim: rxPass.claim,
        obligations: [obligationFor("tests pass", rxPass)],
        evidence: [tampered],
        verifications: [rxPass],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProofError);
      expect((error as ProofError).code).toBe("EVIDENCE_INTEGRITY_FAILURE");
    }
  });

  test("E: tampered verification -> ERROR", () => {
    const { engine, evPass, rxPass } = world();
    const tampered = { ...rxPass, evaluation: { ...rxPass.evaluation, reason_code: "EDITED" } };
    try {
      engine.build({
        claim: rxPass.claim,
        obligations: [obligationFor("tests pass", rxPass)],
        evidence: [evPass],
        verifications: [tampered],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProofError);
      const code = (error as ProofError).code;
      expect(["RECEIPT_ID_MISMATCH", "RECEIPT_HASH_MISMATCH"].includes(code)).toBe(true);
    }
  });

  test("empty obligations fail closed (no vacuous COMPLETE)", () => {
    const { engine, evPass, rxPass } = world();
    try {
      engine.build({ claim: rxPass.claim, obligations: [], evidence: [evPass], verifications: [rxPass] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("INVALID_OBLIGATION");
    }
  });

  test("missing receipt / evidence for an obligation -> MISSING_DEPENDENCY", () => {
    const { engine, evPass, rxPass } = world();
    try {
      engine.build({
        claim: rxPass.claim,
        obligations: [obligationFor("tests pass", rxPass)],
        evidence: [evPass],
        verifications: [],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("MISSING_DEPENDENCY");
    }
    try {
      engine.build({
        claim: rxPass.claim,
        obligations: [obligationFor("tests pass", rxPass)],
        evidence: [],
        verifications: [rxPass],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("MISSING_DEPENDENCY");
    }
  });

  test("FORMAL / COMPOSITE / unknown classes fail clearly", () => {
    const { engine, evPass, rxPass } = world();
    for (const proof_class of ["FORMAL", "COMPOSITE", "MATHEMATICAL"]) {
      try {
        engine.build({
          claim: rxPass.claim,
          proof_class,
          obligations: [obligationFor("tests pass", rxPass)],
          evidence: [evPass],
          verifications: [rxPass],
        });
        expect.unreachable();
      } catch (error) {
        expect((error as ProofError).code).toBe("PROOF_CLASS_UNSUPPORTED");
      }
    }
  });

  test("fixture obligation helper binds the real fixture world", () => {
    const o = fixtureObligation("tests pass", fixtureReceipt());
    expect(o.claim_id).toBe(fixtureReceipt().claim.claim_id);
  });
});
