import { describe, expect, test } from "bun:test";
import { ProofError } from "../src/engine";
import {
  evidenceVariant,
  fixtureEvidence,
  fixtureReceipt,
  receiptVariant,
  tempEngine,
} from "./helpers";

function baseInput() {
  const rxPass = fixtureReceipt();
  const evPass = fixtureEvidence();
  return {
    engine: tempEngine(),
    evPass,
    rxPass,
    claim: rxPass.claim,
    obligation: {
      description: "tests pass",
      claim_id: rxPass.claim.claim_id,
      criterion: rxPass.criterion,
      evidence_ids: rxPass.evidence_ids,
      verification_id: rxPass.verification_id,
    },
  };
}

describe("cross-bindings (F/G/H)", () => {
  test("F: obligation evidence set != receipt evidence set -> PROOF_BINDING_MISMATCH", () => {
    const { engine, claim, obligation, evPass, rxPass } = baseInput();
    const other = evidenceVariant(evPass, { command: "other", exit_code: 0 });
    try {
      engine.build({
        claim,
        obligations: [{ ...obligation, evidence_ids: [other.evidence_id] }],
        evidence: [evPass, other],
        verifications: [rxPass],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("PROOF_BINDING_MISMATCH");
    }
  });

  test("record hash != receipt-bound hash -> PROOF_BINDING_MISMATCH", () => {
    const { engine, claim, obligation, evPass, rxPass } = baseInput();
    // Same id, different bytes is impossible by content addressing; instead
    // bind a valid record the receipt never saw: receipt pins evPass's hash
    // for evPass's id, so swapping the receipt's hash map breaks the bind.
    const rebound = receiptVariant(rxPass, {
      evidence_hashes: { [evPass.evidence_id]: "0".repeat(64) },
    });
    try {
      engine.build({
        claim,
        obligations: [{ ...obligation, verification_id: rebound.verification_id }],
        evidence: [evPass],
        verifications: [rebound],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("PROOF_BINDING_MISMATCH");
    }
  });

  test("G: obligation criterion != receipt criterion -> PROOF_BINDING_MISMATCH", () => {
    const { engine, claim, obligation, evPass, rxPass } = baseInput();
    try {
      engine.build({
        claim,
        obligations: [
          {
            ...obligation,
            criterion: { ...rxPass.criterion, expected: 1 },
          },
        ],
        evidence: [evPass],
        verifications: [rxPass],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("PROOF_BINDING_MISMATCH");
    }
  });

  test("H: receipt claim != artifact claim -> PROOF_BINDING_MISMATCH", () => {
    const { engine, evPass, rxPass } = baseInput();
    const otherClaim = { statement: "Something else entirely.", subject: "other" };
    try {
      engine.build({
        claim: otherClaim,
        obligations: [
          {
            description: "tests pass",
            claim_id: "cl_00000000000000000000000000000000",
            criterion: rxPass.criterion,
            evidence_ids: rxPass.evidence_ids,
            verification_id: rxPass.verification_id,
          },
        ],
        evidence: [evPass],
        verifications: [rxPass],
      });
      expect.unreachable();
    } catch (error) {
      // Obligation claim_id already disagrees with the artifact claim...
      expect((error as ProofError).code).toBe("PROOF_BINDING_MISMATCH");
    }
    // ...and even with a matching claim_id, a divergent receipt claim fails.
    const rebound = receiptVariant(rxPass, {
      claim: { ...rxPass.claim, statement: "Rewritten claim." },
    });
    try {
      engine.build({
        claim: rxPass.claim,
        obligations: [{ ...baseObligation(rxPass), verification_id: rebound.verification_id }],
        evidence: [evPass],
        verifications: [rebound],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("PROOF_BINDING_MISMATCH");
    }
  });

  test("receipt evidence_hashes not covering evidence_ids -> PROOF_BINDING_MISMATCH", () => {
    const { engine, claim, obligation, evPass, rxPass } = baseInput();
    const slim = receiptVariant(rxPass, { evidence_hashes: {} });
    try {
      engine.build({
        claim,
        obligations: [{ ...obligation, verification_id: slim.verification_id }],
        evidence: [evPass],
        verifications: [slim],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofError).code).toBe("PROOF_BINDING_MISMATCH");
    }
  });
});

function baseObligation(rxPass: ReturnType<typeof fixtureReceipt>) {
  return {
    description: "tests pass",
    claim_id: rxPass.claim.claim_id,
    criterion: rxPass.criterion,
    evidence_ids: rxPass.evidence_ids,
    verification_id: rxPass.verification_id,
  };
}
