import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prettyCanonical } from "./canonical";
import {
  checkArtifactIntegrity,
  PROOF_ID_PATTERN,
  validateArtifact,
  type ProofArtifact,
} from "./artifact";

export const MAX_ARTIFACT_BYTES = 1_048_576;

/**
 * Local artifact persistence, physically separate from evidence records
 * and verification receipts: <storeDir>/proofs/<pf_…>.json.
 * Atomic put (tmp + rename), idempotent-at-engine, collision-loud-at-store,
 * read-only get. Same philosophy as the siblings, no shared code (yet).
 */
export class ProofStore {
  constructor(readonly dir: string) {}

  proofsDir(): string {
    return join(this.dir, "proofs");
  }

  proofPath(proof_id: string): string {
    if (!PROOF_ID_PATTERN.test(proof_id)) {
      throw new Error("PROOF_BAD_ID: proof_id must match /^pf_[0-9a-f]{64}$/");
    }
    return join(this.proofsDir(), `${proof_id}.json`);
  }

  put(artifact: ProofArtifact): { proof_id: string; path: string; duplicate: boolean } {
    const structural = validateArtifact(artifact);
    if (!structural.ok) {
      throw new Error(`${structural.code}: ${structural.message}`);
    }
    const integrity = checkArtifactIntegrity(artifact);
    if (!integrity.ok) {
      throw new Error(`${integrity.code}: ${integrity.message}`);
    }
    const serialized = prettyCanonical(artifact);
    if (serialized.length > MAX_ARTIFACT_BYTES) {
      throw new Error(`PROOF_TOO_LARGE: artifact is ${serialized.length} bytes (cap ${MAX_ARTIFACT_BYTES})`);
    }
    mkdirSync(this.proofsDir(), { recursive: true });
    const dest = this.proofPath(artifact.proof_id);
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(dest);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (existing.toString("utf8") === serialized) {
        return { proof_id: artifact.proof_id, path: dest, duplicate: true };
      }
      throw new Error(
        `PROOF_ID_COLLISION: ${dest} already holds a different artifact under ${artifact.proof_id}`,
      );
    }
    const tmp = join(this.proofsDir(), `.tmp-${artifact.proof_id.slice(0, 16)}-${process.pid}-${Date.now()}.json`);
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, dest);
    return { proof_id: artifact.proof_id, path: dest, duplicate: false };
  }

  get(proof_id: string): ProofArtifact {
    const dest = this.proofPath(proof_id);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dest);
    } catch {
      throw new Error(`PROOF_NOT_FOUND: no artifact for ${proof_id}`);
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`PROOF_TOO_LARGE: stored file is ${stat.size} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(dest, "utf8"));
    } catch {
      throw new Error(`PROOF_MALFORMED: ${dest} is not valid JSON`);
    }
    const structural = validateArtifact(parsed);
    if (!structural.ok) {
      throw new Error(`${structural.code}: ${structural.message} (${dest})`);
    }
    return structural.artifact;
  }
}
