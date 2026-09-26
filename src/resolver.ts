import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkEvidenceIntegrity,
  EVIDENCE_ID_PATTERN,
  validateEvidenceRecord,
  type EvidenceRecord,
} from "./evidence-contract";
import {
  checkReceiptIntegrity,
  VERIFICATION_ID_PATTERN,
  validateReceipt,
  type VerificationReceipt,
} from "./verify-contract";

export const MAX_UPSTREAM_FILE_BYTES = 1_048_576;

/** Typed resolution failure: carries a machine-readable code across the resolver seam. */
export class ResolveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Loose-coupling seams: the core takes artifacts; only the edge resolves ids. */
export interface EvidenceResolver {
  resolve(evidence_id: string): EvidenceRecord | null;
}

export interface VerificationResolver {
  resolve(verification_id: string): VerificationReceipt | null;
}

export class MapEvidenceResolver implements EvidenceResolver {
  private readonly byId = new Map<string, EvidenceRecord>();
  constructor(records: EvidenceRecord[]) {
    for (const r of records) this.byId.set(r.evidence_id, r);
  }
  resolve(evidence_id: string): EvidenceRecord | null {
    return this.byId.get(evidence_id) ?? null;
  }
}

export class MapVerificationResolver implements VerificationResolver {
  private readonly byId = new Map<string, VerificationReceipt>();
  constructor(receipts: VerificationReceipt[]) {
    for (const r of receipts) this.byId.set(r.verification_id, r);
  }
  resolve(verification_id: string): VerificationReceipt | null {
    return this.byId.get(verification_id) ?? null;
  }
}

function readJsonFile(path: string, code: string): unknown {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (stat.size > MAX_UPSTREAM_FILE_BYTES) {
    throw new ResolveError(code, `stored file exceeds size cap (${path})`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ResolveError(code, `stored file is not valid JSON (${path})`);
  }
}

/**
 * Read-only resolver over an opencode-evidence store layout
 * (<dir>/records/<ev_…>.json). Couples to the documented layout, never to
 * Evidence code. Validates structure + integrity on read.
 */
export class FileEvidenceResolver implements EvidenceResolver {
  constructor(readonly evidenceStoreDir: string) {}
  resolve(evidence_id: string): EvidenceRecord | null {
    if (!EVIDENCE_ID_PATTERN.test(evidence_id)) {
      throw new ResolveError("INVALID_EVIDENCE", `malformed evidence_id "${evidence_id}"`);
    }
    const parsed = readJsonFile(
      join(this.evidenceStoreDir, "records", `${evidence_id}.json`),
      "INVALID_EVIDENCE",
    );
    if (parsed === null) return null;
    const structural = validateEvidenceRecord(parsed);
    if (!structural.ok) throw new ResolveError(structural.code, structural.message);
    const integrity = checkEvidenceIntegrity(structural.record);
    if (!integrity.ok) throw new ResolveError(integrity.code, integrity.message);
    return structural.record;
  }
}

/**
 * Read-only resolver over an opencode-verify store layout
 * (<dir>/receipts/<vr_…>.json). Same terms as above.
 */
export class FileVerificationResolver implements VerificationResolver {
  constructor(readonly verificationStoreDir: string) {}
  resolve(verification_id: string): VerificationReceipt | null {
    if (!VERIFICATION_ID_PATTERN.test(verification_id)) {
      throw new ResolveError("INVALID_VERIFICATION", `malformed verification_id "${verification_id}"`);
    }
    const parsed = readJsonFile(
      join(this.verificationStoreDir, "receipts", `${verification_id}.json`),
      "INVALID_VERIFICATION",
    );
    if (parsed === null) return null;
    const structural = validateReceipt(parsed);
    if (!structural.ok) throw new ResolveError(structural.code, structural.message);
    const integrity = checkReceiptIntegrity(structural.receipt);
    if (!integrity.ok) throw new ResolveError(integrity.code, integrity.message);
    return structural.receipt;
  }
}
