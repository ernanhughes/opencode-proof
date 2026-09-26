import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { ProofError, type ProofEngine } from "./engine";

function text(result: unknown): { content: string } {
  return { content: JSON.stringify(result, null, 2) };
}

function failure(error: unknown): { content: string } {
  if (error instanceof ProofError) {
    return text({ ok: false, error_code: error.code, error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return text({ ok: false, error_code: "PROOF_INTERNAL", error: message });
}

const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    claim_id: { type: "string" },
    statement: { type: "string" },
    subject: { type: "string" },
    scope: { type: "object" },
  },
  required: ["statement"],
  additionalProperties: false,
};

export function ProofBuildTool(engine: ProofEngine): ToolInfo {
  return {
    name: "proof_build",
    description:
      "Assemble an EMPIRICAL ProofArtifact from a claim, explicit obligations, evidence records, " +
      "and verification receipts. Validates every dependency, enforces claim/criterion/evidence " +
      "bindings, and derives COMPLETE | FAILED | INCOMPLETE from receipt verdicts. Assembles the " +
      "argument only: invents no obligations, infers no intent, authorizes nothing, completes no " +
      "task. COMPLETE means all declared required obligations are satisfied — not universal truth, " +
      "not full specification, not fresh. No model inference, no network.",
    input: {
      type: "object",
      properties: {
        claim: CLAIM_SCHEMA,
        proof_class: { type: "string" },
        obligations: { type: "array" },
        evidence: { type: "array" },
        verifications: { type: "array" },
        evidence_store_dir: { type: "string" },
        verification_store_dir: { type: "string" },
      },
      required: ["claim", "obligations", "evidence", "verifications"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as {
          claim: unknown;
          proof_class?: unknown;
          obligations: never[];
          evidence: never[];
          verifications: never[];
          evidence_store_dir?: string;
          verification_store_dir?: string;
        };
        const result = engine.build({
          claim: args.claim,
          ...(args.proof_class !== undefined ? { proof_class: args.proof_class } : {}),
          obligations: args.obligations,
          evidence: args.evidence,
          verifications: args.verifications,
          ...(args.evidence_store_dir !== undefined ? { evidence_store_dir: args.evidence_store_dir } : {}),
          ...(args.verification_store_dir !== undefined
            ? { verification_store_dir: args.verification_store_dir }
            : {}),
        });
        return text({ ok: true, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function ProofGetTool(engine: ProofEngine): ToolInfo {
  return {
    name: "proof_get",
    description: "Retrieve a stored ProofArtifact by id. Read-only.",
    input: {
      type: "object",
      properties: {
        proof_id: { type: "string", minLength: 1 },
      },
      required: ["proof_id"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as { proof_id: string };
        return text({ ok: true, artifact: engine.get(args.proof_id) });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function ProofExplainTool(engine: ProofEngine): ToolInfo {
  return {
    name: "proof_explain",
    description:
      "Render an artifact's deterministic explanation: claim, class, obligations with evidence " +
      "and verification bindings, status, summary, and what COMPLETE does NOT establish " +
      "(universal truth, full specification, intent, task completion, authority, freshness). " +
      "Data rendering only; never a new judgment.",
    input: {
      type: "object",
      properties: {
        proof_id: { type: "string", minLength: 1 },
      },
      required: ["proof_id"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as { proof_id: string };
        return text({ ok: true, explanation: engine.explain(args.proof_id) });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function ProofReplayTool(engine: ProofEngine): ToolInfo {
  return {
    name: "proof_replay",
    description:
      "Replay a ProofArtifact against its referenced evidence and receipts: re-validates artifact, " +
      "evidence, and receipt integrity, re-checks cross-bindings, re-derives statuses, and compares " +
      "with the stored declaration (REPLAY_MATCH or a named failure). Never executes tools, tests, " +
      "criteria, or models. REPLAY_MATCH means the historical argument is intact — not that the " +
      "world still matches it.",
    input: {
      type: "object",
      properties: {
        proof_id: { type: "string", minLength: 1 },
        evidence: { type: "array" },
        verifications: { type: "array" },
        evidence_store_dir: { type: "string" },
        verification_store_dir: { type: "string" },
      },
      required: ["proof_id"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as {
          proof_id: string;
          evidence?: never[];
          verifications?: never[];
          evidence_store_dir?: string;
          verification_store_dir?: string;
        };
        return text({
          ok: true,
          ...engine.replay({
            proof_id: args.proof_id,
            ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
            ...(args.verifications !== undefined ? { verifications: args.verifications } : {}),
            ...(args.evidence_store_dir !== undefined ? { evidence_store_dir: args.evidence_store_dir } : {}),
            ...(args.verification_store_dir !== undefined
              ? { verification_store_dir: args.verification_store_dir }
              : {}),
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function ProofHealthTool(engine: ProofEngine): ToolInfo {
  return {
    name: "proof_health",
    description:
      "Report prover readiness: plugin/schema versions, proof classes (buildable vs reserved), " +
      "supported upstream schemas, store writability. Runtime checks only; no model inference, no network.",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return text(engine.doctor());
    },
  };
}

export const PROOF_TOOL_NAMES = [
  "proof_build",
  "proof_get",
  "proof_explain",
  "proof_replay",
  "proof_health",
] as const;
