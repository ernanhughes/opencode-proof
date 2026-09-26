# AGENTS.md — working rules for opencode-proof

This repo assembles arguments. It must never generate conclusions. Every
rule below is a review gate.

## Hard boundaries

1. **Never invent missing proof obligations.** Empty obligation lists fail
   closed. "Helpful" obligation synthesis is a different component and a
   different risk class.
2. **Never infer human intent from a COMPLETE proof.** COMPLETE is relative
   to declared obligations. The specification gap is pinned by tests — keep
   it pinned.
3. **Never turn COMPLETE into task completion.** No `task_complete`-shaped
   fields, outputs, or helpers. The forbidden-field list is enforced —
   extend, never shrink, without review.
4. **Never turn COMPLETE into authority.** No allow/deny/permit semantics,
   no deployment gates, no effectful advice. Ever.
5. **Never call empirical verification formal proof.** FORMAL/COMPOSITE are
   reserved words, not capabilities. No `theorem/qed/lean` vocabulary on
   empirical artifacts.
6. **Never use LLM confidence as proof.** No confidence fields, no model
   agreement, no semantic similarity as a binding.
7. **Never silently accept tampered dependencies.** Integrity failures and
   binding mismatches are errors/failure outcomes, never statuses, never
   skipped entries.
8. **Never rebuild upstream Evidence or Verify semantics differently.**
   Vendored contracts are pinned read-only copies. If upstream changes,
   update the pin + fixtures + contract ref together, with a recorded
   reason. Never "improve" vendored validation unilaterally.
9. **Never execute tools during artifact replay.** No commands, no tests, no
   criteria re-evaluation, no network, no models. Replay is structural.
10. **Never equate replayability with freshness.** A REPLAY_MATCH on old
    bytes says nothing about the current world.
11. **Never introduce model inference into the deterministic proof core
    without an explicit new proof class and architectural review.** The
    `src/` scan test bans model/network code — keep it green.

## Determinism and purity

- Status derivation is a table lookup over receipt verdicts. If you find
  yourself re-running evaluation, stop: that is Verify's job.
- Binding comparisons are canonical-equality on normalized structures.
  Criterion normalization must stay byte-identical to upstream Verify;
  any drift becomes false PROOF_BINDING_MISMATCH (loud, by design).
- Identity inputs are frozen (schema, class, claim, obligations, refs,
  status, summary, producer). `assembled_at` stays annotation. Changing
  identity orphans stored artifacts — document and review.
- `ProofStore.get` stays read-only; puts stay atomic; re-builds stay
  idempotent-first-write-wins; true divergence stays collision-loud.
- Keep dependencies boring: no model SDKs, no network, no embeddings.

## Privacy and size

- Detail/excerpt caps with flags where values are rendered; silent
  truncation is a bug.
- Default storage stays outside repos; proofs, receipts, and evidence
  never share a directory.
- Never fetch dependencies from anywhere the caller did not point at.

## Tests must pin boundaries, not only paths

- Every status needs its adversarial twin: tampered bytes, rebound hashes,
  forged receipts, flipped stored statuses, poisoned stores, missing deps,
  substituted obligations (wrong claim/criterion/evidence set).
- The spec-gap test must keep passing: COMPLETE and silent on undeclared
  intent is correct behavior, not a bug to fix.
- Gate: `bun run check` green before commit.

## Siblings

Evidence owns observation (`EVIDENCE_CONTRACT_REF`), Verify owns evaluation
(`VERIFY_CONTRACT_REF`). Proof owns neither. Do not implement their
responsibilities here "temporarily" — not validation logic drift, not
evaluation, not authorship of upstream bytes.
