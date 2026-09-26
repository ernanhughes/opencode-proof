import { canonicalize, sha256Hex } from "./canonical";
import { validateCriterion, type VerificationCriterion } from "./verify-contract";
import type { VerificationVerdict } from "./verify-contract";

export type ObligationStatus = "SATISFIED" | "VIOLATED" | "UNRESOLVED";

export const OBLIGATION_ID_PATTERN = /^ob_[0-9a-f]{32}$/;
export const MAX_OBLIGATION_DESCRIPTION_CHARS = 1024;

export type ProofObligation = {
  obligation_id: string;
  description: string;
  claim_id: string;
  criterion: VerificationCriterion;
  evidence_ids: string[];
  verification_id: string;
  required: boolean;
};

/**
 * Deterministic verdict mapping. PASS -> SATISFIED, FAIL -> VIOLATED,
 * INCONCLUSIVE -> UNRESOLVED. No model, no judgment — a table lookup.
 */
export function statusForVerdict(verdict: VerificationVerdict): ObligationStatus {
  if (verdict === "PASS") return "SATISFIED";
  if (verdict === "FAIL") return "VIOLATED";
  return "UNRESOLVED";
}

export type ObligationInput = {
  description?: unknown;
  claim_id?: unknown;
  criterion?: unknown;
  evidence_ids?: unknown;
  verification_id?: unknown;
  required?: unknown;
};

export type ObligationValidation =
  | { ok: true; obligation: ProofObligation }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): ObligationValidation {
  return { ok: false, code, message };
}

function deriveObligationId(input: {
  description: string;
  claim_id: string;
  criterion: VerificationCriterion;
  evidence_ids: string[];
  verification_id: string;
  required: boolean;
}): string {
  return `ob_${sha256Hex(
    canonicalize({
      claim_id: input.claim_id,
      criterion: input.criterion,
      description: input.description,
      evidence_ids: [...input.evidence_ids].sort(),
      required: input.required,
      verification_id: input.verification_id,
    }),
  ).slice(0, 32)}`;
}

/**
 * Validate + normalize one obligation. The criterion is normalized with the
 * byte-identical vendored Verify validation so canonical comparison against
 * the receipt's stored criterion is exact. Missing obligations cannot be
 * invented here: every binding must be supplied by the caller.
 */
export function normalizeObligation(input: unknown, where = "obligation"): ObligationValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("INVALID_OBLIGATION", `${where}: obligation must be a JSON object`);
  }
  const o = input as Record<string, unknown>;
  if (typeof o["description"] !== "string" || o["description"].length === 0) {
    return fail("INVALID_OBLIGATION", `${where}: description must be a non-empty string`);
  }
  if (o["description"].length > MAX_OBLIGATION_DESCRIPTION_CHARS) {
    return fail("INVALID_OBLIGATION", `${where}: description exceeds ${MAX_OBLIGATION_DESCRIPTION_CHARS} chars`);
  }
  if (typeof o["claim_id"] !== "string" || o["claim_id"].length === 0) {
    return fail("INVALID_OBLIGATION", `${where}: claim_id must be a non-empty string`);
  }
  if (o["criterion"] === undefined) {
    return fail("INVALID_OBLIGATION", `${where}: criterion must be present`);
  }
  const criterion = validateCriterion(o["criterion"], `${where}.criterion`);
  if (!criterion.ok) return fail(criterion.code, criterion.message);
  if (!Array.isArray(o["evidence_ids"]) || o["evidence_ids"].length === 0) {
    return fail("INVALID_OBLIGATION", `${where}: evidence_ids must be a non-empty array of strings`);
  }
  if (!o["evidence_ids"].every((id) => typeof id === "string" && id.length > 0)) {
    return fail("INVALID_OBLIGATION", `${where}: evidence_ids must be a non-empty array of strings`);
  }
  if (typeof o["verification_id"] !== "string" || o["verification_id"].length === 0) {
    return fail("INVALID_OBLIGATION", `${where}: verification_id must be a non-empty string`);
  }
  let required = true;
  if (o["required"] !== undefined) {
    if (typeof o["required"] !== "boolean") {
      return fail("INVALID_OBLIGATION", `${where}: required must be a boolean when present`);
    }
    required = o["required"];
  }
  // Unknown keys fail closed: a misspelled binding must error, not vanish.
  const allowed = new Set([
    "obligation_id",
    "description",
    "claim_id",
    "criterion",
    "evidence_ids",
    "verification_id",
    "required",
  ]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      return fail("INVALID_OBLIGATION", `${where}: unknown field "${key}"`);
    }
  }
  const evidence_ids = [...new Set(o["evidence_ids"] as string[])].sort();
  const draft = {
    description: o["description"] as string,
    claim_id: o["claim_id"] as string,
    criterion: criterion.criterion,
    evidence_ids,
    verification_id: o["verification_id"] as string,
    required,
  };
  let obligation_id = deriveObligationId(draft);
  if (o["obligation_id"] !== undefined) {
    if (typeof o["obligation_id"] !== "string" || !OBLIGATION_ID_PATTERN.test(o["obligation_id"])) {
      return fail("INVALID_OBLIGATION", `${where}: obligation_id must match /^ob_[0-9a-f]{32}$/ when supplied`);
    }
    if (o["obligation_id"] !== obligation_id) {
      return fail(
        "INVALID_OBLIGATION",
        `${where}: supplied obligation_id does not match derived bindings (obligations must bind what they declare)`,
      );
    }
    obligation_id = o["obligation_id"];
  }
  return { ok: true, obligation: { obligation_id, ...draft } };
}
