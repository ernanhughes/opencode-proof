/** Developer CLI: health, load, smoke. No model inference, no network. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkArtifactIntegrity } from "./artifact";
import { checkEvidenceIntegrity, validateEvidenceRecord } from "./evidence-contract";
import { ProofEngine } from "./engine";
import { checkReceiptIntegrity, normalizeClaim, validateReceipt } from "./verify-contract";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function check(cond: boolean, message: string): void {
  if (!cond) fail(message);
  console.log(`ok: ${message}`);
}

function tempEngine(): ProofEngine {
  return new ProofEngine(mkdtempSync(join(tmpdir(), "pf-proj-")), {
    store_dir: mkdtempSync(join(tmpdir(), "pf-store-")),
  });
}

function upstreamRepo(envName: string, sibling: string, marker: string): string | null {
  const candidates = [process.env[envName], resolve(join(process.cwd(), "..", sibling))].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const repo of candidates) {
    if (existsSync(join(repo, marker))) return repo;
  }
  return null;
}

async function cmdHealth(projectDir: string): Promise<void> {
  console.log(JSON.stringify(new ProofEngine(projectDir).doctor(), null, 2));
}

async function cmdLoad(projectDir: string): Promise<void> {
  const mod = await import("./plugin");
  check(typeof mod.default === "object" && mod.default !== null, "plugin module loads with default export");
  const plugin = mod.default as { setup: (ctx: unknown) => Promise<void> };
  check(typeof plugin.setup === "function", "plugin exposes setup()");
  const added: string[] = [];
  await plugin.setup({
    location: { directory: projectDir },
    tool: {
      transform: async (fn: (editor: { add: (t: { name: string }) => void }) => void) => {
        fn({ add: (t) => void added.push(t.name) });
      },
    },
    session: { hook: async () => {} },
  });
  const expected = ["proof_build", "proof_get", "proof_explain", "proof_replay", "proof_health"];
  check(JSON.stringify(added) === JSON.stringify(expected), `tools registered: ${added.join(", ")}`);
  const health = new ProofEngine(projectDir).doctor() as { model_inference: string; network: string };
  check(health.model_inference === "none", "health reports model_inference=none");
  check(health.network === "none", "health reports network=none");
  console.log(JSON.stringify({ load: "PASS", tools: added }, null, 2));
}

type EvidenceFns = {
  normalizeCommandResult: (i: Record<string, unknown>) => Record<string, unknown>;
  buildRecord: (i: Record<string, unknown>) => Record<string, unknown>;
};

/** Real three-project chain using actual upstream code (no vendored authorship). */
async function smokeRealChain(evRepo: string, vrRepo: string): Promise<void> {
  const engine = tempEngine();
  const evCapture = (await import(join(evRepo, "src", "capture.ts"))) as unknown as EvidenceFns;
  const vrMod = (await import(join(vrRepo, "src", "engine.ts"))) as {
    VerificationEngine: new (dir: string, overrides?: Record<string, string>) => {
      check: (i: Record<string, unknown>) => { receipt: Record<string, unknown> };
    };
  };

  // 1. Real observations: run commands, capture exit codes.
  const runs = [
    { name: "bun-version", cmd: "bun", args: ["--version"] },
    { name: "node-version", cmd: "node", args: ["--version"] },
  ].map(({ name, cmd, args }) => {
    const stdout = execFileSync(cmd, args, { encoding: "utf8" }).trim();
    return { name, cmd: `${cmd} ${args.join(" ")}`, stdout };
  });
  check(runs.every((r) => r.stdout.length > 0), "observed real command output (exit 0)");

  // 2. Real evidence records via upstream opencode-evidence code.
  const records = runs.map((r) =>
    evCapture.buildRecord(
      evCapture.normalizeCommandResult({
        command: r.cmd,
        exit_code: 0,
        stdout: r.stdout,
        subject: r.name,
      }),
    ),
  );
  for (const record of records) {
    const v = validateEvidenceRecord(record);
    check(v.ok, `proof-vendored validation accepts live record ${(record["evidence_id"] as string) ?? "?"}`);
    if (v.ok) check(checkEvidenceIntegrity(v.record).ok, "live record integrity recomputes");
  }

  // 3. Real verification receipts via upstream opencode-verify code.
  const vrEngine = new vrMod.VerificationEngine(mkdtempSync(join(tmpdir(), "pf-vrproj-")), {
    store_dir: mkdtempSync(join(tmpdir(), "pf-vrstore-")),
  });
  const claim = { statement: "The declared build gate is satisfied.", subject: "build-gate" };
  const receipts = runs.map((r, i) =>
    vrEngine.check({
      claim,
      criterion: {
        kind: "evidence_field",
        evidence_kind: "command_result",
        subject: r.name,
        path: "observation.exit_code",
        operator: "EQUALS",
        expected: 0,
      },
      evidence: [records[i]],
    }).receipt,
  );
  check(
    receipts.every((r) => r["verdict"] === "PASS"),
    "upstream verify evaluated PASS/PASS on live evidence",
  );
  for (const receipt of receipts) {
    const v = validateReceipt(receipt);
    check(v.ok, `proof-vendored validation accepts live receipt ${(receipt["verification_id"] as string) ?? "?"}`);
    if (v.ok) check(checkReceiptIntegrity(v.receipt).ok, "live receipt integrity recomputes");
  }

  // 4. Proof assembly over the real chain.
  const normalized = normalizeClaim(claim);
  if (!normalized.ok) fail("smoke claim invalid");
  const built = engine.build({
    claim,
    obligations: runs.map((r, i) => ({
      description: `${r.cmd} exits 0`,
      claim_id: (normalized.ok && normalized.claim.claim_id) || "",
      criterion: {
        kind: "evidence_field",
        evidence_kind: "command_result",
        subject: r.name,
        path: "observation.exit_code",
        operator: "EQUALS",
        expected: 0,
      },
      evidence_ids: [(records[i] as { evidence_id: string })["evidence_id"]],
      verification_id: [(receipts[i] as { verification_id: string })["verification_id"]][0],
    })),
    evidence: records as never[],
    verifications: receipts as never[],
  });
  check(built.artifact.status === "COMPLETE", `live chain assembles COMPLETE (${built.artifact.proof_id})`);
  check(
    built.obligation_statuses.every((o) => o.status === "SATISFIED"),
    "O1/O2 SATISFIED",
  );

  // 5. FAILED + INCOMPLETE variants via real upstream evaluation.
  const failReceipt = vrEngine.check({
    claim,
    criterion: {
      kind: "evidence_field",
      evidence_kind: "command_result",
      subject: "bun-version",
      path: "observation.exit_code",
      operator: "EQUALS",
      expected: 99,
    },
    evidence: [records[0]],
  }).receipt;
  const failed = engine.build({
    claim,
    obligations: [
      {
        description: "bun exits 0",
        claim_id: (normalized.ok && normalized.claim.claim_id) || "",
        criterion: {
          kind: "evidence_field",
          evidence_kind: "command_result",
          subject: "bun-version",
          path: "observation.exit_code",
          operator: "EQUALS",
          expected: 0,
        },
        evidence_ids: [(records[0] as { evidence_id: string })["evidence_id"]],
        verification_id: [(receipts[0] as { verification_id: string })["verification_id"]][0],
      },
      {
        description: "bun exits 99 (impossible)",
        claim_id: (normalized.ok && normalized.claim.claim_id) || "",
        criterion: {
          kind: "evidence_field",
          evidence_kind: "command_result",
          subject: "bun-version",
          path: "observation.exit_code",
          operator: "EQUALS",
          expected: 99,
        },
        evidence_ids: [(records[0] as { evidence_id: string })["evidence_id"]],
        verification_id: [(failReceipt as { verification_id: string })["verification_id"]][0],
      },
    ],
    evidence: records as never[],
    verifications: [...receipts, failReceipt] as never[],
  });
  check(failed.artifact.status === "FAILED", "violated obligation derives FAILED");

  const unknownReceipt = vrEngine.check({
    claim,
    criterion: {
      kind: "evidence_field",
      evidence_kind: "command_result",
      subject: "bun-version",
      path: "observation.nonexistent",
      operator: "EQUALS",
      expected: 1,
    },
    evidence: [records[0]],
  }).receipt;
  const incomplete = engine.build({
    claim,
    obligations: [
      {
        description: "bun exits 0",
        claim_id: (normalized.ok && normalized.claim.claim_id) || "",
        criterion: {
          kind: "evidence_field",
          evidence_kind: "command_result",
          subject: "bun-version",
          path: "observation.exit_code",
          operator: "EQUALS",
          expected: 0,
        },
        evidence_ids: [(records[0] as { evidence_id: string })["evidence_id"]],
        verification_id: [(receipts[0] as { verification_id: string })["verification_id"]][0],
      },
      {
        description: "missing field check",
        claim_id: (normalized.ok && normalized.claim.claim_id) || "",
        criterion: {
          kind: "evidence_field",
          evidence_kind: "command_result",
          subject: "bun-version",
          path: "observation.nonexistent",
          operator: "EQUALS",
          expected: 1,
        },
        evidence_ids: [(records[0] as { evidence_id: string })["evidence_id"]],
        verification_id: [(unknownReceipt as { verification_id: string })["verification_id"]][0],
      },
    ],
    evidence: records as never[],
    verifications: [...receipts, unknownReceipt] as never[],
  });
  check(incomplete.artifact.status === "INCOMPLETE", "unresolved obligation derives INCOMPLETE");

  // 6. Retrieval, explanation, replay of the COMPLETE artifact.
  const fetched = engine.get(built.artifact.proof_id);
  check(fetched.proof_id === built.artifact.proof_id, "proof_get retrieves artifact");
  check(checkArtifactIntegrity(fetched).ok, "artifact integrity revalidates");
  const explanation = engine.explain(built.artifact.proof_id) as { status: string };
  check(explanation.status === "COMPLETE", "proof_explain reports COMPLETE");
  const replayed = engine.replay({
    proof_id: built.artifact.proof_id,
    evidence: records as never[],
    verifications: receipts as never[],
  });
  check(replayed.replay === "REPLAY_MATCH", "proof_replay returns REPLAY_MATCH");
  console.log("note: COMPLETE establishes declared obligations only — not correctness, intent, or authority.");
  console.log("SMOKE PASS (real upstream chain)");
}

/** Fixture chain from real upstream artifacts (no live upstream code needed). */
async function smokeFixtureChain(): Promise<void> {
  const engine = tempEngine();
  const { readFileSync } = await import("node:fs");
  const dir = join(process.cwd(), "tests", "fixtures");
  const record = JSON.parse(readFileSync(join(dir, "evidence-example.json"), "utf8"));
  const receipt = JSON.parse(readFileSync(join(dir, "receipt-example.json"), "utf8"));
  check(validateEvidenceRecord(record).ok, "fixture evidence validates");
  check(validateReceipt(receipt).ok, "fixture receipt validates");
  const built = engine.build({
    claim: (receipt as { claim: unknown })["claim"],
    obligations: [
      {
        description: "test command exit_code equals 0",
        claim_id: ((receipt as { claim: { claim_id: string } })["claim"]).claim_id,
        criterion: (receipt as { criterion: unknown })["criterion"],
        evidence_ids: (receipt as { evidence_ids: string[] })["evidence_ids"],
        verification_id: (receipt as { verification_id: string })["verification_id"],
      },
    ],
    evidence: [record],
    verifications: [receipt],
  });
  check(built.artifact.status === "COMPLETE", `fixture chain assembles COMPLETE (${built.artifact.proof_id})`);
  check(checkArtifactIntegrity(engine.get(built.artifact.proof_id)).ok, "artifact integrity revalidates");
  const replayed = engine.replay({
    proof_id: built.artifact.proof_id,
    evidence: [record],
    verifications: [receipt],
  });
  check(replayed.replay === "REPLAY_MATCH", "proof_replay returns REPLAY_MATCH");
  console.log("SMOKE PASS (pinned fixtures)");
}

async function cmdSmoke(): Promise<void> {
  const evRepo = upstreamRepo("OPENCODE_EVIDENCE_REPO", "opencode-evidence", join("src", "capture.ts"));
  const vrRepo = upstreamRepo("OPENCODE_VERIFY_REPO", "opencode-verify", join("src", "engine.ts"));
  if (evRepo && vrRepo) {
    console.log(`upstream interop: evidence=${evRepo} verify=${vrRepo}`);
    await smokeRealChain(evRepo, vrRepo);
  } else {
    console.log("upstream interop: checkouts not adjacent; using pinned real fixtures");
    await smokeFixtureChain();
  }
}

const [, , cmd] = process.argv;
const projectDir = process.cwd();
if (cmd === "health") await cmdHealth(projectDir);
else if (cmd === "load") await cmdLoad(projectDir);
else if (cmd === "smoke") await cmdSmoke();
else {
  console.error("usage: dev-cli.ts <health|load|smoke>");
  process.exit(2);
}
