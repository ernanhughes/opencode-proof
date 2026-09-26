import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureEvidence, fixtureReceipt, tempEngine } from "./helpers";

const BANNED_ARTIFACT_WORDS = [
  "task_complete",
  "task_completed",
  "authorized",
  "allowed",
  "truth",
  "universally_true",
  "intent_satisfied",
  "confidence",
  "deployment_allowed",
];

describe("semantic boundaries", () => {
  test("COMPLETE artifact contains no authority/completion/truth/confidence semantics", () => {
    const engine = tempEngine();
    const rxPass = fixtureReceipt();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [
        {
          description: "tests pass",
          claim_id: rxPass.claim.claim_id,
          criterion: rxPass.criterion,
          evidence_ids: rxPass.evidence_ids,
          verification_id: rxPass.verification_id,
        },
      ],
      evidence: [fixtureEvidence()],
      verifications: [rxPass],
    });
    expect(built.artifact.status).toBe("COMPLETE");
    const serialized = JSON.stringify(built.artifact);
    for (const word of BANNED_ARTIFACT_WORDS) {
      expect(serialized.includes(`"${word}"`), `artifact carries "${word}"`).toBe(false);
    }
  });

  test("empirical proof never labels itself formal", () => {
    const engine = tempEngine();
    const rxPass = fixtureReceipt();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [
        {
          description: "tests pass",
          claim_id: rxPass.claim.claim_id,
          criterion: rxPass.criterion,
          evidence_ids: rxPass.evidence_ids,
          verification_id: rxPass.verification_id,
        },
      ],
      evidence: [fixtureEvidence()],
      verifications: [rxPass],
    });
    expect(built.artifact.proof_class).toBe("EMPIRICAL");
    const serialized = JSON.stringify(built.artifact).toLowerCase();
    for (const word of ["formal", "theorem", "qed", "lean", "tactic"]) {
      expect(serialized.includes(`"${word}"`), `artifact mentions "${word}"`).toBe(false);
    }
  });

  test("explanation states the specification gap explicitly", () => {
    const engine = tempEngine();
    const rxPass = fixtureReceipt();
    const built = engine.build({
      claim: rxPass.claim,
      obligations: [
        {
          description: "tests pass",
          claim_id: rxPass.claim.claim_id,
          criterion: rxPass.criterion,
          evidence_ids: rxPass.evidence_ids,
          verification_id: rxPass.verification_id,
        },
      ],
      evidence: [fixtureEvidence()],
      verifications: [rxPass],
    });
    const ex = engine.explain(built.artifact.proof_id) as {
      does_not_establish: string[];
    };
    const joined = ex.does_not_establish.join(" ");
    expect(joined.includes("specification gap")).toBe(true);
    expect(joined.includes("freshness")).toBe(true);
    expect(joined.includes("authority")).toBe(true);
  });

  test("no model inference, no network anywhere in src", () => {
    const srcFiles = readdirSync(join(import.meta.dir, "..", "src")).filter((f) => f.endsWith(".ts"));
    const banned = [
      /from\s+["']node:https?["']/,
      /from\s+["']node:net["']/,
      /(^|[^A-Za-z_.])fetch\s*\(/,
      /openai|anthropic|llm|inference\s*\(|embeddings?/i,
    ];
    for (const file of srcFiles) {
      const content = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      for (const pattern of banned) {
        expect(pattern.test(content), `${file} matches banned pattern ${String(pattern)}`).toBe(false);
      }
    }
    const health = tempEngine().doctor() as Record<string, unknown>;
    expect(health["model_inference"]).toBe("none");
    expect(health["network"]).toBe("none");
  });
});
