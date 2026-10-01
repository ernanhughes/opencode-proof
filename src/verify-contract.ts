import { canonicalize, sha256Hex } from "./canonical";
import { SUPPORTED_VERIFICATION_SCHEMAS } from "./version";

/**
 * Read-only Verify contract, pinned to opencode-verify@a341298.
 * Vendored claim normalization, criterion validation/normalization, and
 * receipt validation + integrity. Proof NEVER evaluates criteria, NEVER
 * authors receipts — it checks bindings between caller-supplied obligations
 * and integrity-valid receipts. Criterion normalization below must stay
 * byte-identical to upstream: obligation criteria are canonical-compared
 * against receipt criteria, so any normalization drift becomes a false
 * PROOF_BINDING_MISMATCH (loud, not silent).
 */

// ---- Claim (mirrors upstream normalizeClaim) ----

// Keep proof-side claim validation aligned with opencode-verify and Worker.
export const MAX_CLAIM_STATEMENT_CHARS = 4096;
export const MAX_CLAIM_SCOPE_BYTES = 16_384;
export const CLAIM_ID_PATTERN = /^cl_[0-9a-f]{32}$/;

export type Claim = {
  claim_id: string;
  statement: string;
  subject?: string;
  scope?: Record<string, unknown>;
};

export type ClaimValidation =
  | { ok: true; claim: Claim }
  | { ok: false; code: string; message: string };

function claimFail(code: string, message: string): ClaimValidation {
  return { ok: false, code, message };
}

export function deriveClaimId(input: {
  statement: string;
  subject?: string;
  scope?: Record<string, unknown>;
}): string {
  return `cl_${sha256Hex(canonicalize({ statement: input.statement, subject: input.subject ?? null, scope: input.scope ?? null })).slice(0, 32)}`;
}

export function normalizeClaim(input: unknown): ClaimValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return claimFail("INVALID_CLAIM", "claim must be a JSON object");
  }
  const c = input as Record<string, unknown>;
  if (typeof c["statement"] !== "string" || c["statement"].length === 0) {
    return claimFail("INVALID_CLAIM", "claim.statement must be a non-empty string");
  }
  if (c["statement"].length > MAX_CLAIM_STATEMENT_CHARS) {
    return claimFail(
      "INVALID_CLAIM",
      `claim.statement is ${c["statement"].length} chars (cap ${MAX_CLAIM_STATEMENT_CHARS})`,
    );
  }
  if (c["subject"] !== undefined && typeof c["subject"] !== "string") {
    return claimFail("INVALID_CLAIM", "claim.subject must be a string when present");
  }
  let scope: Record<string, unknown> | undefined;
  if (c["scope"] !== undefined) {
    if (typeof c["scope"] !== "object" || c["scope"] === null || Array.isArray(c["scope"])) {
      return claimFail("INVALID_CLAIM", "claim.scope must be an object when present");
    }
    scope = c["scope"] as Record<string, unknown>;
    let bytes: number;
    try {
      bytes = canonicalize(scope).length;
    } catch {
      return claimFail("INVALID_CLAIM", "claim.scope must be canonicalizable JSON");
    }
    if (bytes > MAX_CLAIM_SCOPE_BYTES) {
      return claimFail("INVALID_CLAIM", `claim.scope is ${bytes} bytes (cap ${MAX_CLAIM_SCOPE_BYTES})`);
    }
  }
  const claim: Claim = {
    claim_id: "",
    statement: c["statement"],
    ...(typeof c["subject"] === "string" ? { subject: c["subject"] } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
  if (c["claim_id"] !== undefined) {
    if (typeof c["claim_id"] !== "string" || !CLAIM_ID_PATTERN.test(c["claim_id"])) {
      return claimFail("INVALID_CLAIM", "claim.claim_id must match /^cl_[0-9a-f]{32}$/ when supplied");
    }
    claim.claim_id = c["claim_id"];
  } else {
    claim.claim_id = deriveClaimId(claim);
  }
  return { ok: true, claim };
}

// ---- Criterion (mirrors upstream validateCriterion, incl. normalization) ----

export type LeafOperator =
  | "EQUALS"
  | "NOT_EQUALS"
  | "CONTAINS"
  | "MATCHES"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "EXISTS";

export const LEAF_OPERATORS: readonly string[] = [
  "EQUALS",
  "NOT_EQUALS",
  "CONTAINS",
  "MATCHES",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "EXISTS",
];

export type EvidenceFieldCriterion = {
  kind: "evidence_field";
  path: string;
  operator: LeafOperator;
  expected?: unknown;
  evidence_kind?: string;
  evidence_id?: string;
  subject?: string;
  source_kind?: string;
  min_observed_at?: string;
};

export type CompositeCriterion = {
  kind: "all" | "any" | "not";
  criteria?: VerificationCriterion[];
  criterion?: VerificationCriterion;
};

export type VerificationCriterion = EvidenceFieldCriterion | CompositeCriterion;

export type CriterionValidation =
  | { ok: true; criterion: VerificationCriterion }
  | { ok: false; code: string; message: string };

function criterionFail(code: string, message: string): CriterionValidation {
  return { ok: false, code, message };
}

function validateLeaf(c: Record<string, unknown>, where: string): CriterionValidation {
  if (typeof c["path"] !== "string" || c["path"].length === 0) {
    return criterionFail("INVALID_CRITERION", `${where}: evidence_field.path must be a non-empty string`);
  }
  if (typeof c["operator"] !== "string" || !LEAF_OPERATORS.includes(c["operator"])) {
    return criterionFail("UNSUPPORTED_OPERATOR", `${where}: operator must be one of ${LEAF_OPERATORS.join(", ")}`);
  }
  const operator = c["operator"] as LeafOperator;
  const hasExpected = c["expected"] !== undefined;
  if (operator === "EXISTS") {
    if (hasExpected) {
      return criterionFail("INVALID_CRITERION", `${where}: EXISTS must not carry expected`);
    }
  } else if (!hasExpected) {
    return criterionFail("INVALID_CRITERION", `${where}: ${operator} requires expected`);
  }
  if (
    (operator === "GT" || operator === "GTE" || operator === "LT" || operator === "LTE") &&
    typeof c["expected"] !== "number"
  ) {
    return criterionFail("INVALID_CRITERION", `${where}: ${operator} requires a numeric expected`);
  }
  if (operator === "MATCHES") {
    if (typeof c["expected"] !== "string") {
      return criterionFail("INVALID_CRITERION", `${where}: MATCHES requires a string regex in expected`);
    }
    try {
      new RegExp(c["expected"]);
    } catch {
      return criterionFail("INVALID_CRITERION", `${where}: MATCHES expected is not a valid regex`);
    }
  }
  for (const sel of ["evidence_kind", "evidence_id", "subject", "source_kind"] as const) {
    if (c[sel] !== undefined && typeof c[sel] !== "string") {
      return criterionFail("INVALID_CRITERION", `${where}: ${sel} selector must be a string when present`);
    }
  }
  if (c["min_observed_at"] !== undefined) {
    if (typeof c["min_observed_at"] !== "string" || Number.isNaN(Date.parse(c["min_observed_at"]))) {
      return criterionFail("INVALID_CRITERION", `${where}: min_observed_at must be a parseable timestamp`);
    }
  }
  const allowed = new Set([
    "kind",
    "path",
    "operator",
    "expected",
    "evidence_kind",
    "evidence_id",
    "subject",
    "source_kind",
    "min_observed_at",
  ]);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) {
      return criterionFail("INVALID_CRITERION", `${where}: unknown field "${key}"`);
    }
  }
  return { ok: true, criterion: c as unknown as VerificationCriterion };
}

export function validateCriterion(input: unknown, where = "criterion"): CriterionValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return criterionFail("INVALID_CRITERION", `${where}: criterion must be a JSON object`);
  }
  const c = input as Record<string, unknown>;
  if (c["kind"] === "evidence_field") return validateLeaf(c, where);
  if (c["kind"] === "all" || c["kind"] === "any") {
    if (!Array.isArray(c["criteria"]) || c["criteria"].length === 0) {
      return criterionFail("INVALID_CRITERION", `${where}: ${String(c["kind"])} requires a non-empty criteria array`);
    }
    const criteria: VerificationCriterion[] = [];
    for (let i = 0; i < c["criteria"].length; i++) {
      const sub = validateCriterion(c["criteria"][i], `${where}.${String(c["kind"])}[${i}]`);
      if (!sub.ok) return sub;
      criteria.push(sub.criterion);
    }
    return { ok: true, criterion: { kind: c["kind"], criteria } };
  }
  if (c["kind"] === "not") {
    if (c["criterion"] === undefined) {
      return criterionFail("INVALID_CRITERION", `${where}: not requires a single criterion`);
    }
    const sub = validateCriterion(c["criterion"], `${where}.not`);
    if (!sub.ok) return sub;
    return { ok: true, criterion: { kind: "not", criterion: sub.criterion } };
  }
  return criterionFail("INVALID_CRITERION", `${where}: kind must be one of evidence_field, all, any, not`);
}

// ---- Receipt (mirrors upstream validateReceipt + checkReceiptIntegrity) ----

export type VerificationVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

const VERDICTS: readonly string[] = ["PASS", "FAIL", "INCONCLUSIVE"];

const FORBIDDEN_RECEIPT_FIELDS: readonly string[] = [
  "task_complete",
  "task_completed",
  "task_success",
  "authorized",
  "allowed",
  "denied",
  "proof",
  "confidence",
  "trust_score",
];

export const VERIFICATION_ID_PATTERN = /^vr_[0-9a-f]{32}$/;
const RECEIPT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type VerificationReceipt = {
  schema: string;
  verification_id: string;
  claim: Claim;
  criterion: VerificationCriterion;
  evidence_ids: string[];
  evidence_hashes: Record<string, string>;
  verdict: VerificationVerdict;
  evaluation: {
    result: "TRUE" | "FALSE" | "UNKNOWN";
    reason_code: string;
    details: unknown;
  };
  evaluated_at: string;
  verifier: { plugin: string; version: string };
  content_hash: string;
};

export type ReceiptValidation =
  | { ok: true; receipt: VerificationReceipt }
  | { ok: false; code: string; message: string };

function receiptFail(code: string, message: string): ReceiptValidation {
  return { ok: false, code, message };
}

export function validateReceipt(parsed: unknown): ReceiptValidation {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return receiptFail("RECEIPT_MALFORMED", "receipt must be a JSON object");
  }
  const rec = parsed as Record<string, unknown>;
  for (const field of FORBIDDEN_RECEIPT_FIELDS) {
    if (rec[field] !== undefined) {
      return receiptFail("RECEIPT_FORBIDDEN_FIELD", `receipt must not carry "${field}" (belongs to Work/Authority/Proof)`);
    }
  }
  if (typeof rec["schema"] !== "string") {
    return receiptFail("RECEIPT_MALFORMED", "receipt schema must be a string");
  }
  if (!SUPPORTED_VERIFICATION_SCHEMAS.includes(rec["schema"])) {
    return receiptFail(
      "UNSUPPORTED_VERIFICATION_SCHEMA",
      `unsupported verification schema "${String(rec["schema"])}"`,
    );
  }
  if (typeof rec["verification_id"] !== "string" || !VERIFICATION_ID_PATTERN.test(rec["verification_id"])) {
    return receiptFail("RECEIPT_BAD_ID", "verification_id must match /^vr_[0-9a-f]{32}$/");
  }
  if (typeof rec["claim"] !== "object" || rec["claim"] === null) {
    return receiptFail("RECEIPT_BAD_CLAIM", "claim must be an object");
  }
  if (typeof rec["criterion"] !== "object" || rec["criterion"] === null) {
    return receiptFail("RECEIPT_BAD_CRITERION", "criterion must be an object");
  }
  if (!Array.isArray(rec["evidence_ids"]) || !rec["evidence_ids"].every((id) => typeof id === "string")) {
    return receiptFail("RECEIPT_BAD_EVIDENCE", "evidence_ids must be an array of strings");
  }
  if (
    typeof rec["evidence_hashes"] !== "object" ||
    rec["evidence_hashes"] === null ||
    Array.isArray(rec["evidence_hashes"])
  ) {
    return receiptFail("RECEIPT_BAD_EVIDENCE", "evidence_hashes must be an object");
  }
  if (typeof rec["verdict"] !== "string" || !VERDICTS.includes(rec["verdict"])) {
    return receiptFail("RECEIPT_BAD_VERDICT", "verdict must be one of PASS, FAIL, INCONCLUSIVE");
  }
  const evaluation = rec["evaluation"];
  if (typeof evaluation !== "object" || evaluation === null || Array.isArray(evaluation)) {
    return receiptFail("RECEIPT_BAD_EVALUATION", "evaluation must be an object");
  }
  const ev = evaluation as Record<string, unknown>;
  if (ev["result"] !== "TRUE" && ev["result"] !== "FALSE" && ev["result"] !== "UNKNOWN") {
    return receiptFail("RECEIPT_BAD_EVALUATION", "evaluation.result must be TRUE, FALSE, or UNKNOWN");
  }
  if (typeof ev["reason_code"] !== "string" || ev["reason_code"].length === 0) {
    return receiptFail("RECEIPT_BAD_EVALUATION", "evaluation.reason_code must be a non-empty string");
  }
  if (ev["details"] === undefined) {
    return receiptFail("RECEIPT_BAD_EVALUATION", "evaluation.details must be present");
  }
  const verdictMatches =
    (ev["result"] === "TRUE" && rec["verdict"] === "PASS") ||
    (ev["result"] === "FALSE" && rec["verdict"] === "FAIL") ||
    (ev["result"] === "UNKNOWN" && rec["verdict"] === "INCONCLUSIVE");
  if (!verdictMatches) {
    return receiptFail(
      "RECEIPT_VERDICT_MISMATCH",
      "verdict must match evaluation.result (TRUE->PASS, FALSE->FAIL, UNKNOWN->INCONCLUSIVE)",
    );
  }
  if (typeof rec["evaluated_at"] !== "string" || Number.isNaN(Date.parse(rec["evaluated_at"]))) {
    return receiptFail("RECEIPT_BAD_TIME", "evaluated_at must be a parseable timestamp string");
  }
  const verifier = rec["verifier"];
  if (typeof verifier !== "object" || verifier === null || Array.isArray(verifier)) {
    return receiptFail("RECEIPT_BAD_VERIFIER", "verifier must be an object");
  }
  const vv = verifier as Record<string, unknown>;
  if (vv["plugin"] !== "opencode-verify") {
    return receiptFail("RECEIPT_BAD_VERIFIER", `verifier.plugin must be "opencode-verify"`);
  }
  if (typeof vv["version"] !== "string" || vv["version"].length === 0) {
    return receiptFail("RECEIPT_BAD_VERIFIER", "verifier.version must be a non-empty string");
  }
  if (typeof rec["content_hash"] !== "string" || !RECEIPT_HASH_PATTERN.test(rec["content_hash"])) {
    return receiptFail("RECEIPT_BAD_HASH", "content_hash must be 64 lowercase hex chars");
  }
  return { ok: true, receipt: parsed as VerificationReceipt };
}

export function receiptIdentityInput(input: {
  claim: Claim;
  criterion: VerificationCriterion;
  evidence_ids: string[];
  evidence_hashes: Record<string, string>;
  verdict: VerificationVerdict;
  result: string;
  reason_code: string;
  verifierVersion: string;
}): Record<string, unknown> {
  return {
    criterion: input.criterion,
    claim: {
      claim_id: input.claim.claim_id,
      scope: input.claim.scope ?? null,
      statement: input.claim.statement,
      subject: input.claim.subject ?? null,
    },
    evidence_hashes: input.evidence_hashes,
    evidence_ids: [...input.evidence_ids].sort(),
    reason_code: input.reason_code,
    result: input.result,
    schema: "opencode.verification.v1",
    verdict: input.verdict,
    verifier: { plugin: "opencode-verify", version: input.verifierVersion },
  };
}

export function deriveVerificationId(identityInput: Record<string, unknown>): string {
  return `vr_${sha256Hex(canonicalize(identityInput)).slice(0, 32)}`;
}

function receiptBodyHash(receipt: Record<string, unknown>): string {
  const { content_hash: _hashOmitted, evaluated_at: _timeOmitted, ...body } = receipt;
  return sha256Hex(canonicalize(body));
}

export type ReceiptIntegrity =
  | { ok: true; recomputed_id: string; recomputed_hash: string }
  | { ok: false; code: string; message: string };

/**
 * Recompute verification_id + content_hash from fields (the pinned upstream
 * math). Exported so tests can derive tamper variants through the real
 * algorithm rather than hand-waving bytes.
 */
export function recomputeReceiptIdentity(receipt: VerificationReceipt): {
  verification_id: string;
  content_hash: string;
} {
  const identity = receiptIdentityInput({
    claim: receipt.claim,
    criterion: receipt.criterion,
    evidence_ids: receipt.evidence_ids,
    evidence_hashes: receipt.evidence_hashes,
    verdict: receipt.verdict,
    result: receipt.evaluation.result,
    reason_code: receipt.evaluation.reason_code,
    verifierVersion: receipt.verifier.version,
  });
  // Order matters: the body hash covers verification_id, so the derived id
  // must be placed first — same order as upstream buildReceipt. For valid
  // stored receipts the derived id equals the stored one (no-op).
  const verification_id = deriveVerificationId(identity);
  const content_hash = receiptBodyHash({ ...receipt, verification_id } as unknown as Record<string, unknown>);
  return { verification_id, content_hash };
}

export function checkReceiptIntegrity(receipt: VerificationReceipt): ReceiptIntegrity {
  const structural = validateReceipt(receipt);
  if (!structural.ok) {
    return { ok: false, code: structural.code, message: structural.message };
  }
  const recomputed = recomputeReceiptIdentity(receipt);
  if (recomputed.verification_id !== receipt.verification_id) {
    return {
      ok: false,
      code: "RECEIPT_ID_MISMATCH",
      message: `stored verification_id ${receipt.verification_id} != recomputed ${recomputed.verification_id}`,
    };
  }
  if (recomputed.content_hash !== receipt.content_hash) {
    return {
      ok: false,
      code: "RECEIPT_HASH_MISMATCH",
      message: "stored content_hash does not match receipt body",
    };
  }
  return { ok: true, recomputed_id: recomputed.verification_id, recomputed_hash: recomputed.content_hash };
}
