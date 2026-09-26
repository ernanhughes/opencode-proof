import { createHash } from "node:crypto";

/**
 * Deterministic canonical JSON serialization, rule-for-rule with the
 * sibling contracts (opencode-evidence@88cc2e6, opencode-verify@a341298).
 * Independent copy on purpose (no shared package yet); drift is caught by
 * fixture tests that reproduce upstream hashes byte-exactly.
 *
 * Rules: keys sorted in UTF-16 code-unit order; `undefined` object props
 * dropped, array holes -> null; non-finite numbers -> null; Date -> ISO;
 * bigint/function/symbol throw; no whitespace.
 */
export function canonicalize(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) return "null";
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") {
    throw new Error("PROOF_NON_JSON_VALUE: bigint has no canonical JSON form");
  }
  if (t === "function" || t === "symbol") {
    throw new Error(`PROOF_NON_JSON_VALUE: ${t} has no canonical JSON form`);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifyCanonical(obj[k])}`).join(",")}}`;
  }
  throw new Error(`PROOF_NON_JSON_VALUE: unsupported typeof ${t}`);
}

export function prettyCanonical(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalize(value)), null, 2)}\n`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
