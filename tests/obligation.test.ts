import { describe, expect, test } from "bun:test";
import { normalizeObligation, statusForVerdict } from "../src/obligation";
import { fixtureObligation, fixtureReceipt } from "./helpers";

describe("obligations", () => {
  test("valid obligation normalizes with derived id, sorted evidence, required default", () => {
    const receipt = fixtureReceipt();
    const o = fixtureObligation("tests pass", receipt);
    expect(o.obligation_id).toMatch(/^ob_[0-9a-f]{32}$/);
    expect(o.required).toBe(true);
    expect(o.evidence_ids).toEqual([...receipt.evidence_ids].sort());
    expect(o.claim_id).toBe(receipt.claim.claim_id);
  });

  test("identical bindings derive identical ids (deterministic)", () => {
    const receipt = fixtureReceipt();
    const a = fixtureObligation("same", receipt);
    const b = fixtureObligation("same", receipt);
    expect(a.obligation_id).toBe(b.obligation_id);
  });

  test("supplied obligation_id must match derived bindings", () => {
    const receipt = fixtureReceipt();
    const good = fixtureObligation("x", receipt);
    const kept = normalizeObligation({ ...good, criterion: receipt.criterion });
    expect(kept.ok).toBe(true);
    const forged = normalizeObligation({ ...good, obligation_id: `ob_${"0".repeat(32)}` });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("INVALID_OBLIGATION");
  });

  test("validation fails closed", () => {
    const receipt = fixtureReceipt();
    const base = {
      description: "d",
      claim_id: receipt.claim.claim_id,
      criterion: receipt.criterion,
      evidence_ids: receipt.evidence_ids,
      verification_id: receipt.verification_id,
    };
    expect(normalizeObligation(null).ok).toBe(false);
    expect(normalizeObligation({ ...base, description: "" }).ok).toBe(false);
    expect(normalizeObligation({ ...base, evidence_ids: [] }).ok).toBe(false);
    expect(normalizeObligation({ ...base, criterion: { kind: "vibes" } }).ok).toBe(false);
    expect(normalizeObligation({ ...base, required: "yes" }).ok).toBe(false);
    expect(normalizeObligation({ ...base, extra: 1 }).ok).toBe(false);
    expect(normalizeObligation({ ...base, claim_id: "" }).ok).toBe(false);
  });

  test("verdict mapping PASS->SATISFIED FAIL->VIOLATED INCONCLUSIVE->UNRESOLVED", () => {
    expect(statusForVerdict("PASS")).toBe("SATISFIED");
    expect(statusForVerdict("FAIL")).toBe("VIOLATED");
    expect(statusForVerdict("INCONCLUSIVE")).toBe("UNRESOLVED");
  });
});
