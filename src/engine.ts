import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildArtifact,
  checkArtifactIntegrity,
  type EvidenceRef,
  type ProofArtifact,
  type ProofStatus,
  type VerificationRef,
} from "./artifact";
import { canonicalize } from "./canonical";
import {
  resolveEvidenceStoreDir,
  resolveStoreDir,
  resolveVerificationStoreDir,
  type ProofConfig,
} from "./config";
import { checkEvidenceIntegrity, validateEvidenceRecord, type EvidenceRecord } from "./evidence-contract";
import { normalizeObligation, statusForVerdict, type ObligationStatus, type ProofObligation } from "./obligation";
import {
  FileEvidenceResolver,
  FileVerificationResolver,
  MapEvidenceResolver,
  MapVerificationResolver,
  ResolveError,
  type EvidenceResolver,
  type VerificationResolver,
} from "./resolver";
import { ProofStore } from "./store";
import { normalizeClaim, type Claim } from "./verify-contract";
import {
  BUILDABLE_PROOF_CLASSES,
  EVIDENCE_CONTRACT_REF,
  PLUGIN_ID,
  PLUGIN_VERSION,
  PROOF_SCHEMA,
  SUPPORTED_EVIDENCE_SCHEMAS,
  SUPPORTED_PROOF_CLASSES,
  SUPPORTED_VERIFICATION_SCHEMAS,
  VERIFY_CONTRACT_REF,
} from "./version";
import { checkReceiptIntegrity, validateReceipt, type VerificationReceipt } from "./verify-contract";

export type { Claim, ProofArtifact, ProofObligation };

export class ProofError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export type EvidenceInput = EvidenceRecord | { evidence_id: string };
export type VerificationInput = VerificationReceipt | { verification_id: string };

export type BuildInput = {
  claim: unknown;
  proof_class?: unknown;
  obligations: unknown[];
  evidence: EvidenceInput[];
  verifications: VerificationInput[];
  evidence_store_dir?: string;
  verification_store_dir?: string;
  assembled_at?: string;
};

export type ObligationOutcome = {
  obligation_id: string;
  description: string;
  required: boolean;
  verification_id: string;
  verdict: VerificationReceipt["verdict"];
  status: ObligationStatus;
};

function isFullRecord(item: EvidenceInput): item is EvidenceRecord {
  const r = item as Record<string, unknown>;
  return typeof r["evidence_id"] === "string" && r["observation"] !== undefined;
}

function isFullReceipt(item: VerificationInput): item is VerificationReceipt {
  const r = item as Record<string, unknown>;
  return typeof r["verification_id"] === "string" && typeof r["verdict"] === "string";
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

export type ReplayInput = {
  proof_id: string;
  evidence?: EvidenceInput[];
  verifications?: VerificationInput[];
  evidence_store_dir?: string;
  verification_store_dir?: string;
};

export type ReplayResult = {
  replay:
    | "REPLAY_MATCH"
    | "MISSING_DEPENDENCY"
    | "PROOF_INTEGRITY_FAILURE"
    | "EVIDENCE_INTEGRITY_FAILURE"
    | "VERIFICATION_INTEGRITY_FAILURE"
    | "PROOF_BINDING_MISMATCH"
    | "STATUS_MISMATCH";
  proof_id: string;
  stored_status?: ProofStatus;
  derived_status?: ProofStatus;
  failures: string[];
  missing?: string[];
};

export class ProofEngine {
  readonly store: ProofStore;
  readonly storeDir: string;
  private readonly config: ProofConfig;
  private readonly extraEvidenceResolvers: EvidenceResolver[];
  private readonly extraVerificationResolvers: VerificationResolver[];

  constructor(
    readonly projectDir: string,
    overrides: ProofConfig = {},
    extraEvidenceResolvers: EvidenceResolver[] = [],
    extraVerificationResolvers: VerificationResolver[] = [],
  ) {
    this.config = overrides;
    this.storeDir = resolveStoreDir(projectDir, overrides);
    this.store = new ProofStore(this.storeDir);
    this.extraEvidenceResolvers = extraEvidenceResolvers;
    this.extraVerificationResolvers = extraVerificationResolvers;
  }

  private resolveEvidence(
    id: string,
    inline: EvidenceRecord[],
    perCallDir?: string,
  ): EvidenceRecord {
    const inlineHit = inline.find((r) => r.evidence_id === id);
    if (inlineHit) return inlineHit;
    const resolvers: EvidenceResolver[] = [...this.extraEvidenceResolvers];
    const dir = perCallDir ?? resolveEvidenceStoreDir(this.projectDir, this.config);
    if (dir) resolvers.push(new FileEvidenceResolver(dir));
    for (const resolver of resolvers) {
      try {
        const hit = resolver.resolve(id);
        if (hit) return hit;
      } catch (error) {
        if (error instanceof ResolveError) throw new ProofError(error.code, error.message);
        throw error;
      }
    }
    throw new ProofError(
      "MISSING_DEPENDENCY",
      `unresolvable evidence ${id} (supply the record or set evidence_store_dir)`,
    );
  }

  private takeEvidence(record: EvidenceRecord): EvidenceRecord {
    const structural = validateEvidenceRecord(record);
    if (!structural.ok) throw new ProofError(structural.code, structural.message);
    const integrity = checkEvidenceIntegrity(structural.record);
    if (!integrity.ok) throw new ProofError(integrity.code, integrity.message);
    return structural.record;
  }

  private takeVerification(receipt: VerificationReceipt): VerificationReceipt {
    const structural = validateReceipt(receipt);
    if (!structural.ok) throw new ProofError(structural.code, structural.message);
    const integrity = checkReceiptIntegrity(structural.receipt);
    if (!integrity.ok) throw new ProofError(integrity.code, integrity.message);
    return structural.receipt;
  }

  /**
   * Assemble a ProofArtifact. Validates everything, binds obligations to
   * receipts, derives statuses. Generates no conclusions: every claim,
   * criterion, record, and receipt arrives from the caller.
   */
  build(input: BuildInput): {
    artifact: ProofArtifact;
    path: string;
    duplicate: boolean;
    obligation_statuses: ObligationOutcome[];
  } {
    const proof_class = input.proof_class ?? "EMPIRICAL";
    if (typeof proof_class !== "string" || !SUPPORTED_PROOF_CLASSES.includes(proof_class)) {
      throw new ProofError("PROOF_CLASS_UNSUPPORTED", `unknown proof class "${String(proof_class)}"`);
    }
    if (!BUILDABLE_PROOF_CLASSES.includes(proof_class)) {
      throw new ProofError(
        "PROOF_CLASS_UNSUPPORTED",
        `proof class "${proof_class}" is reserved but not buildable in v0.1 (only EMPIRICAL)`,
      );
    }
    const claim = normalizeClaim(input.claim);
    if (!claim.ok) throw new ProofError(claim.code, claim.message);
    if (!Array.isArray(input.obligations) || input.obligations.length === 0) {
      throw new ProofError("INVALID_OBLIGATION", "obligations must be a non-empty array");
    }
    if (!Array.isArray(input.evidence)) {
      throw new ProofError("INVALID_EVIDENCE", "evidence must be an array of records or {evidence_id} refs");
    }
    if (!Array.isArray(input.verifications)) {
      throw new ProofError("INVALID_VERIFICATION", "verifications must be an array of receipts or {verification_id} refs");
    }

    // Normalize obligations (dedupe identical bindings by derived id).
    const seenObligations = new Map<string, ProofObligation>();
    input.obligations.forEach((raw, i) => {
      const normalized = normalizeObligation(raw, `obligations[${i}]`);
      if (!normalized.ok) throw new ProofError(normalized.code, normalized.message);
      seenObligations.set(normalized.obligation.obligation_id, normalized.obligation);
    });
    const obligations = [...seenObligations.values()].sort((a, b) =>
      a.obligation_id < b.obligation_id ? -1 : 1,
    );

    for (const o of obligations) {
      if (o.claim_id !== claim.claim.claim_id) {
        throw new ProofError(
          "PROOF_BINDING_MISMATCH",
          `obligation ${o.obligation_id} binds claim ${o.claim_id} but artifact claim is ${claim.claim.claim_id}`,
        );
      }
    }

    // Partition + resolve verifications.
    const inlineReceipts: VerificationReceipt[] = [];
    const receiptRefs: string[] = [];
    for (const item of input.verifications) {
      if (typeof item !== "object" || item === null) {
        throw new ProofError("INVALID_VERIFICATION", "each verification must be a receipt or {verification_id}");
      }
      if (isFullReceipt(item)) inlineReceipts.push(item);
      else if (typeof (item as { verification_id?: unknown }).verification_id === "string") {
        receiptRefs.push((item as { verification_id: string }).verification_id);
      } else {
        throw new ProofError("INVALID_VERIFICATION", "each verification must be a receipt or {verification_id}");
      }
    }
    const inlineRecords: EvidenceRecord[] = [];
    const recordRefs: string[] = [];
    for (const item of input.evidence) {
      if (typeof item !== "object" || item === null) {
        throw new ProofError("INVALID_EVIDENCE", "each evidence item must be a record or {evidence_id}");
      }
      if (isFullRecord(item)) inlineRecords.push(item);
      else if (typeof (item as { evidence_id?: unknown }).evidence_id === "string") {
        recordRefs.push((item as { evidence_id: string }).evidence_id);
      } else {
        throw new ProofError("INVALID_EVIDENCE", "each evidence item must be a record or {evidence_id}");
      }
    }

    const evDir = input.evidence_store_dir;
    const vrDir = input.verification_store_dir;
    const receiptsById = new Map<string, VerificationReceipt>();
    const needReceiptIds = [...new Set(obligations.map((o) => o.verification_id))];
    for (const id of needReceiptIds) {
      let raw: VerificationReceipt;
      const fromInline = inlineReceipts.find((r) => r.verification_id === id);
      if (fromInline) raw = fromInline;
      else if (receiptRefs.includes(id)) {
        const resolvers: VerificationResolver[] = [...this.extraVerificationResolvers];
        const map = new MapVerificationResolver(inlineReceipts);
        const mapped = map.resolve(id);
        if (mapped) raw = mapped;
        else {
          const dir = vrDir ?? resolveVerificationStoreDir(this.projectDir, this.config);
          if (dir) resolvers.push(new FileVerificationResolver(dir));
          let hit: VerificationReceipt | null = null;
          for (const resolver of resolvers) {
            try {
              hit = resolver.resolve(id);
            } catch (error) {
              if (error instanceof ResolveError) throw new ProofError(error.code, error.message);
              throw error;
            }
            if (hit) break;
          }
          if (!hit) {
            throw new ProofError(
              "MISSING_DEPENDENCY",
              `unresolvable verification ${id} (supply the receipt or set verification_store_dir)`,
            );
          }
          raw = hit;
        }
      } else {
        throw new ProofError("MISSING_DEPENDENCY", `obligation requires verification ${id}, which was not supplied`);
      }
      receiptsById.set(id, this.takeVerification(raw));
    }

    // Cross-bindings: obligation <-> receipt.
    const artifactClaimCanon = canonicalize(claim.claim);
    for (const o of obligations) {
      const receipt = receiptsById.get(o.verification_id);
      if (!receipt) throw new ProofError("MISSING_DEPENDENCY", `missing receipt ${o.verification_id}`);
      if (canonicalize(receipt.claim) !== artifactClaimCanon) {
        throw new ProofError(
          "PROOF_BINDING_MISMATCH",
          `obligation ${o.obligation_id}: receipt ${receipt.verification_id} claims ${receipt.claim.claim_id}, artifact claims ${claim.claim.claim_id}`,
        );
      }
      if (canonicalize(o.criterion) !== canonicalize(receipt.criterion)) {
        throw new ProofError(
          "PROOF_BINDING_MISMATCH",
          `obligation ${o.obligation_id}: criterion differs from receipt ${receipt.verification_id} criterion`,
        );
      }
      if (!sameSet([...o.evidence_ids].sort(), [...receipt.evidence_ids].sort())) {
        throw new ProofError(
          "PROOF_BINDING_MISMATCH",
          `obligation ${o.obligation_id}: evidence set differs from receipt ${receipt.verification_id} evidence set`,
        );
      }
      const hashKeys = Object.keys(receipt.evidence_hashes).sort();
      if (!sameSet(hashKeys, [...receipt.evidence_ids].sort())) {
        throw new ProofError(
          "PROOF_BINDING_MISMATCH",
          `receipt ${receipt.verification_id}: evidence_hashes keys do not cover evidence_ids`,
        );
      }
    }

    // Resolve + validate every referenced evidence record; bind hashes.
    const recordsById = new Map<string, EvidenceRecord>();
    const needRecordIds = [...new Set(obligations.flatMap((o) => o.evidence_ids))].sort();
    const inlineMap = new MapEvidenceResolver(inlineRecords);
    for (const id of needRecordIds) {
      let raw: EvidenceRecord | null = inlineMap.resolve(id);
      if (!raw && recordRefs.includes(id)) raw = this.resolveEvidence(id, inlineRecords, evDir);
      if (!raw) {
        throw new ProofError("MISSING_DEPENDENCY", `obligation evidence ${id} was not supplied`);
      }
      recordsById.set(id, this.takeEvidence(raw));
    }
    for (const o of obligations) {
      const receipt = receiptsById.get(o.verification_id);
      if (!receipt) continue;
      for (const id of o.evidence_ids) {
        const record = recordsById.get(id);
        const bound = receipt.evidence_hashes[id];
        if (!record || record.content_hash !== bound) {
          throw new ProofError(
            "PROOF_BINDING_MISMATCH",
            `obligation ${o.obligation_id}: evidence ${id} hash ${record?.content_hash ?? "missing"} != receipt-bound ${String(bound)}`,
          );
        }
      }
    }

    // Derive statuses. No evaluation happens here — verdicts are read.
    const obligation_statuses: ObligationOutcome[] = obligations.map((o) => {
      const receipt = receiptsById.get(o.verification_id);
      if (!receipt) throw new ProofError("MISSING_DEPENDENCY", `missing receipt ${o.verification_id}`);
      return {
        obligation_id: o.obligation_id,
        description: o.description,
        required: o.required,
        verification_id: o.verification_id,
        verdict: receipt.verdict,
        status: statusForVerdict(receipt.verdict),
      };
    });
    const required = obligation_statuses.filter((s) => s.required);
    const satisfied = required.filter((s) => s.status === "SATISFIED").length;
    const violated = required.filter((s) => s.status === "VIOLATED").length;
    const unresolved = required.filter((s) => s.status === "UNRESOLVED").length;
    const status: ProofStatus = violated > 0 ? "FAILED" : unresolved > 0 ? "INCOMPLETE" : "COMPLETE";

    const evidence: EvidenceRef[] = needRecordIds.map((id) => {
      const record = recordsById.get(id);
      if (!record) throw new ProofError("MISSING_DEPENDENCY", `missing evidence ${id}`);
      return { evidence_id: id, content_hash: record.content_hash };
    });
    const verifications: VerificationRef[] = [...receiptsById.values()]
      .sort((a, b) => (a.verification_id < b.verification_id ? -1 : 1))
      .map((r) => ({ verification_id: r.verification_id, content_hash: r.content_hash }));

    const artifact = buildArtifact({
      claim: claim.claim,
      obligations,
      evidence,
      verifications,
      status,
      summary: { required: required.length, satisfied, violated, unresolved },
      ...(input.assembled_at !== undefined ? { assembled_at: input.assembled_at } : {}),
    });

    // Idempotent re-build: same proof_id already recorded -> stored wins.
    try {
      const existing = this.store.get(artifact.proof_id);
      const integrity = checkArtifactIntegrity(existing);
      if (!integrity.ok) throw new ProofError(integrity.code, `${integrity.message} (stored artifact)`);
      return {
        artifact: existing,
        path: this.store.proofPath(artifact.proof_id),
        duplicate: true,
        obligation_statuses,
      };
    } catch (error) {
      if (error instanceof ProofError) throw error;
    }
    const stored = this.store.put(artifact);
    return { artifact, path: stored.path, duplicate: stored.duplicate, obligation_statuses };
  }

  get(proof_id: string): ProofArtifact {
    return this.store.get(proof_id);
  }

  /**
   * Deterministic rendering of the stored argument. Generated from stored
   * data only — no model, no new judgment.
   */
  explain(proof_id: string): Record<string, unknown> {
    const artifact = this.store.get(proof_id);
    const integrity = checkArtifactIntegrity(artifact);
    const obligations = artifact.obligations.map((o) => ({
      obligation_id: o.obligation_id,
      description: o.description,
      required: o.required,
      claim_id: o.claim_id,
      criterion: o.criterion,
      evidence_ids: o.evidence_ids,
      verification_id: o.verification_id,
    }));
    return {
      proof_id: artifact.proof_id,
      proof_class: artifact.proof_class,
      claim: artifact.claim,
      status: artifact.status,
      summary: artifact.summary,
      obligations,
      evidence: artifact.evidence,
      verifications: artifact.verifications,
      assembled_at: artifact.assembled_at,
      producer: artifact.producer,
      integrity: integrity.ok
        ? { stored_bytes_match: true }
        : { stored_bytes_match: false, code: integrity.code, message: integrity.message },
      does_not_establish: [
        "whether the claim is universally true (COMPLETE = declared obligations satisfied);",
        "whether the declared obligations fully capture the requester's intent (specification gap);",
        "whether evidence sources were trustworthy;",
        "whether the human's task is complete;",
        "whether any action is permitted (proof != authority);",
        "that the world still matches the proof (replayability != freshness).",
      ],
    };
  }

  /**
   * Artifact replay: re-establish that the stored artifact remains
   * structurally valid against the exact referenced bytes. Checks proof
   * integrity, resolves every ref, re-validates upstream integrity, binds
   * hashes, re-checks obligation bindings, re-derives statuses, and compares
   * the derived status/summary with the stored declaration.
   *
   * Replay NEVER executes tools, re-runs tests, re-evaluates criteria, or
   * calls models. Why no re-evaluation: the receipt's content_hash already
   * binds verdict + reason + evidence_hashes, so a receipt that passes
   * integrity cannot disagree with its own evaluation. Re-running the
   * evaluator would be world re-verification — Verify's job, not Proof's.
   * Consequence, stated plainly: REPLAY_MATCH means the historical argument
   * is intact, never that the world still matches it (replayability !=
   * freshness).
   */
  replay(input: ReplayInput): ReplayResult {
    const artifact = this.store.get(input.proof_id);
    const failures: string[] = [];
    const missing: string[] = [];

    const artifactIntegrity = checkArtifactIntegrity(artifact);
    if (!artifactIntegrity.ok) {
      return {
        replay: "PROOF_INTEGRITY_FAILURE",
        proof_id: artifact.proof_id,
        failures: [`${artifactIntegrity.code}: ${artifactIntegrity.message}`],
      };
    }

    const inlineRecords: EvidenceRecord[] = [];
    const inlineReceipts: VerificationReceipt[] = [];
    for (const item of input.evidence ?? []) {
      if (isFullRecord(item)) inlineRecords.push(item);
    }
    for (const item of input.verifications ?? []) {
      if (isFullReceipt(item)) inlineReceipts.push(item);
    }

    // Resolve + integrity-check every referenced verification receipt.
    // Resolver throws are collected per-ref: replay reports, never throws.
    const receiptsById = new Map<string, VerificationReceipt>();
    const verificationFailures: string[] = [];
    const evidenceFailures: string[] = [];
    const bindingFailures: string[] = [];
    for (const ref of artifact.verifications) {
      let raw: VerificationReceipt | null =
        inlineReceipts.find((r) => r.verification_id === ref.verification_id) ?? null;
      if (!raw) {
        const resolvers: VerificationResolver[] = [...this.extraVerificationResolvers];
        const dir = input.verification_store_dir ?? resolveVerificationStoreDir(this.projectDir, this.config);
        if (dir) resolvers.push(new FileVerificationResolver(dir));
        let resolveFailed = false;
        for (const resolver of resolvers) {
          try {
            raw = resolver.resolve(ref.verification_id);
          } catch (error) {
            verificationFailures.push(
              `${error instanceof ResolveError ? error.code : "RESOLVER_ERROR"}: ${error instanceof Error ? error.message : String(error)}`,
            );
            raw = null;
            resolveFailed = true;
            break;
          }
          if (raw) break;
        }
        if (resolveFailed) continue;
      }
      if (!raw) {
        missing.push(ref.verification_id);
        continue;
      }
      const structural = validateReceipt(raw);
      if (!structural.ok) {
        verificationFailures.push(`${structural.code}: ${structural.message} (${ref.verification_id})`);
        continue;
      }
      const integrity = checkReceiptIntegrity(structural.receipt);
      if (!integrity.ok) {
        verificationFailures.push(`${integrity.code}: ${integrity.message} (${ref.verification_id})`);
        continue;
      }
      if (structural.receipt.content_hash !== ref.content_hash) {
        bindingFailures.push(
          `PROOF_BINDING_MISMATCH: verification ${ref.verification_id} content changed since assembly`,
        );
        continue;
      }
      receiptsById.set(ref.verification_id, structural.receipt);
    }

    // Resolve + integrity-check every referenced evidence record.
    const recordsById = new Map<string, EvidenceRecord>();
    for (const ref of artifact.evidence) {
      let raw: EvidenceRecord | null =
        inlineRecords.find((r) => r.evidence_id === ref.evidence_id) ?? null;
      if (!raw) {
        const resolvers: EvidenceResolver[] = [...this.extraEvidenceResolvers];
        const dir = input.evidence_store_dir ?? resolveEvidenceStoreDir(this.projectDir, this.config);
        if (dir) resolvers.push(new FileEvidenceResolver(dir));
        let resolveFailed = false;
        for (const resolver of resolvers) {
          try {
            raw = resolver.resolve(ref.evidence_id);
          } catch (error) {
            evidenceFailures.push(
              `${error instanceof ResolveError ? error.code : "RESOLVER_ERROR"}: ${error instanceof Error ? error.message : String(error)}`,
            );
            raw = null;
            resolveFailed = true;
            break;
          }
          if (raw) break;
        }
        if (resolveFailed) continue;
      }
      if (!raw) {
        missing.push(ref.evidence_id);
        continue;
      }
      const structural = validateEvidenceRecord(raw);
      if (!structural.ok) {
        evidenceFailures.push(`${structural.code}: ${structural.message} (${ref.evidence_id})`);
        continue;
      }
      const integrity = checkEvidenceIntegrity(structural.record);
      if (!integrity.ok) {
        evidenceFailures.push(`${integrity.code}: ${integrity.message} (${ref.evidence_id})`);
        continue;
      }
      if (structural.record.content_hash !== ref.content_hash) {
        bindingFailures.push(
          `PROOF_BINDING_MISMATCH: evidence ${ref.evidence_id} content changed since assembly`,
        );
        continue;
      }
      recordsById.set(ref.evidence_id, structural.record);
    }

    if (missing.length > 0) {
      return { replay: "MISSING_DEPENDENCY", proof_id: artifact.proof_id, stored_status: artifact.status, failures, missing };
    }
    if (evidenceFailures.length > 0) {
      return { replay: "EVIDENCE_INTEGRITY_FAILURE", proof_id: artifact.proof_id, stored_status: artifact.status, failures: evidenceFailures };
    }
    if (verificationFailures.length > 0) {
      return { replay: "VERIFICATION_INTEGRITY_FAILURE", proof_id: artifact.proof_id, stored_status: artifact.status, failures: verificationFailures };
    }
    if (bindingFailures.length > 0) {
      return { replay: "PROOF_BINDING_MISMATCH", proof_id: artifact.proof_id, stored_status: artifact.status, failures: bindingFailures };
    }

    // Re-check obligation bindings against resolved material.
    const artifactClaimCanon = canonicalize(artifact.claim);
    for (const o of artifact.obligations) {
      const receipt = receiptsById.get(o.verification_id);
      if (!receipt) {
        return { replay: "MISSING_DEPENDENCY", proof_id: artifact.proof_id, stored_status: artifact.status, failures, missing: [o.verification_id] };
      }
      if (o.claim_id !== artifact.claim.claim_id || canonicalize(receipt.claim) !== artifactClaimCanon) {
        failures.push(`PROOF_BINDING_MISMATCH: obligation ${o.obligation_id} claim binding broken`);
      }
      if (canonicalize(o.criterion) !== canonicalize(receipt.criterion)) {
        failures.push(`PROOF_BINDING_MISMATCH: obligation ${o.obligation_id} criterion binding broken`);
      }
      if (!sameSet([...o.evidence_ids].sort(), [...receipt.evidence_ids].sort())) {
        failures.push(`PROOF_BINDING_MISMATCH: obligation ${o.obligation_id} evidence set binding broken`);
      }
      for (const id of o.evidence_ids) {
        const record = recordsById.get(id);
        if (!record || record.content_hash !== receipt.evidence_hashes[id]) {
          failures.push(`PROOF_BINDING_MISMATCH: obligation ${o.obligation_id} evidence ${id} hash binding broken`);
        }
      }
    }
    if (failures.length > 0) {
      return { replay: "PROOF_BINDING_MISMATCH", proof_id: artifact.proof_id, stored_status: artifact.status, failures };
    }

    // Re-derive statuses; any drift from the stored declaration mismatches.
    // (Unreachable when the same code wrote and replays the artifact — it
    // fires if derivation semantics ever change between versions.)
    const required = artifact.obligations.filter((o) => o.required);
    const derived = required.map((o) => statusForVerdict((receiptsById.get(o.verification_id) as VerificationReceipt).verdict));
    const satisfied = derived.filter((s) => s === "SATISFIED").length;
    const violated = derived.filter((s) => s === "VIOLATED").length;
    const unresolved = derived.filter((s) => s === "UNRESOLVED").length;
    const derivedStatus: ProofStatus = violated > 0 ? "FAILED" : unresolved > 0 ? "INCOMPLETE" : "COMPLETE";
    const summaryMatches =
      artifact.summary.required === required.length &&
      artifact.summary.satisfied === satisfied &&
      artifact.summary.violated === violated &&
      artifact.summary.unresolved === unresolved;
    if (derivedStatus !== artifact.status || !summaryMatches) {
      return {
        replay: "STATUS_MISMATCH",
        proof_id: artifact.proof_id,
        stored_status: artifact.status,
        derived_status: derivedStatus,
        failures: [
          `STATUS_MISMATCH: stored ${artifact.status} ${JSON.stringify(artifact.summary)} != derived ${derivedStatus} ${JSON.stringify({ required: required.length, satisfied, violated, unresolved })}`,
        ],
      };
    }
    return {
      replay: "REPLAY_MATCH",
      proof_id: artifact.proof_id,
      stored_status: artifact.status,
      derived_status: derivedStatus,
      failures: [],
    };
  }

  doctor(): Record<string, unknown> {
    let store_writable = false;
    let message: string | undefined;
    try {
      mkdirSync(join(this.storeDir, "proofs"), { recursive: true });
      const probe = join(this.storeDir, "proofs", ".write-probe");
      writeFileSync(probe, "ok", "utf8");
      unlinkSync(probe);
      store_writable = true;
    } catch (error) {
      message = `store not writable: ${String(error).slice(0, 200)}`;
    }
    return {
      ok: store_writable,
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      schema: PROOF_SCHEMA,
      proof_classes: [...SUPPORTED_PROOF_CLASSES],
      buildable_classes: [...BUILDABLE_PROOF_CLASSES],
      supported_evidence_schemas: [...SUPPORTED_EVIDENCE_SCHEMAS],
      supported_verification_schemas: [...SUPPORTED_VERIFICATION_SCHEMAS],
      evidence_contract: EVIDENCE_CONTRACT_REF,
      verification_contract: VERIFY_CONTRACT_REF,
      store_dir: this.storeDir,
      store_writable,
      model_inference: "none",
      network: "none",
      node: process.version,
      ...(message !== undefined ? { message } : {}),
    };
  }
}
