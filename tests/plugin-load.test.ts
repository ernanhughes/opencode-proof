import { describe, expect, test } from "bun:test";
import plugin from "../src/plugin";
import {
  ProofBuildTool,
  ProofExplainTool,
  ProofGetTool,
  ProofHealthTool,
  ProofReplayTool,
  PROOF_TOOL_NAMES,
} from "../src/tools";
import { fixtureEvidence, fixtureReceipt, tempEngine } from "./helpers";

function buildArgs() {
  const rxPass = fixtureReceipt();
  return {
    rxPass,
    args: {
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
    },
  };
}

describe("plugin load", () => {
  test("setup registers exactly the five expected tools", async () => {
    const added: string[] = [];
    const fakeCtx = {
      location: { directory: tempEngine().projectDir },
      tool: {
        transform: async (fn: (editor: { add: (t: { name: string }) => void }) => void) => {
          fn({ add: (t) => void added.push(t.name) });
        },
      },
      session: { hook: async () => {} },
    };
    await (plugin as { setup: (ctx: unknown) => Promise<void> }).setup(fakeCtx);
    expect(added).toEqual([...PROOF_TOOL_NAMES]);
  });
});

describe("agent-facing tools", () => {
  test("proof_health reports readiness without inference or network", async () => {
    const out = JSON.parse(
      (await ProofHealthTool(tempEngine()).execute({}, {} as never))!.content as unknown as string,
    ) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(out["model_inference"]).toBe("none");
    expect(out["network"]).toBe("none");
    expect(out["schema"]).toBe("opencode.proof.v1");
    expect(out["buildable_classes"]).toEqual(["EMPIRICAL"]);
  });

  test("proof_build -> get -> explain -> replay round-trip", async () => {
    const engine = tempEngine();
    const { rxPass, args } = buildArgs();
    const created = JSON.parse(
      (await ProofBuildTool(engine).execute(args, {} as never))!.content as unknown as string,
    ) as { ok: boolean; artifact: { proof_id: string; status: string } };
    expect(created.ok).toBe(true);
    expect(created.artifact.status).toBe("COMPLETE");

    const fetched = JSON.parse(
      (await ProofGetTool(engine).execute({ proof_id: created.artifact.proof_id }, {} as never))!
        .content as unknown as string,
    ) as { ok: boolean; artifact: { proof_id: string } };
    expect(fetched.ok).toBe(true);

    const explained = JSON.parse(
      (await ProofExplainTool(engine).execute({ proof_id: created.artifact.proof_id }, {} as never))!
        .content as unknown as string,
    ) as { ok: boolean; explanation: { status: string; does_not_establish: string[] } };
    expect(explained.ok).toBe(true);
    expect(explained.explanation.status).toBe("COMPLETE");
    expect(explained.explanation.does_not_establish.length).toBeGreaterThan(0);

    const replayed = JSON.parse(
      (await ProofReplayTool(engine).execute(
        {
          proof_id: created.artifact.proof_id,
          evidence: [fixtureEvidence()],
          verifications: [rxPass],
        },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; replay: string };
    expect(replayed.ok).toBe(true);
    expect(replayed.replay).toBe("REPLAY_MATCH");
  });

  test("proof_build surfaces binding errors as ok:false payloads", async () => {
    const engine = tempEngine();
    const { args } = buildArgs();
    const out = JSON.parse(
      (await ProofBuildTool(engine).execute(
        { ...args, obligations: [{ ...args.obligations[0], evidence_ids: [`ev_${"9".repeat(32)}`] }] },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; error_code: string };
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("PROOF_BINDING_MISMATCH");
  });

  test("proof_get on unknown id returns ok:false, not a throw", async () => {
    const out = JSON.parse(
      (await ProofGetTool(tempEngine()).execute({ proof_id: `pf_${"d".repeat(64)}` }, {} as never))!
        .content as unknown as string,
    ) as { ok: boolean; error_code: string };
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("PROOF_INTERNAL");
  });
});
