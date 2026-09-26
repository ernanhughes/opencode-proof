# opencode-proof

**One job:** package an argument — claims, obligations, evidence, and
verification — so another system can inspect and replay it.

```text
Evidence:  "What was observed?"
Verify:    "Did the supplied evidence satisfy this criterion?"
Proof:     "What exact argument supports this claim,           ← this repo
            and can that argument be inspected/replayed?"
```

Proof assembles proof-carrying work. It generates no conclusions: every
claim, criterion, record, and receipt arrives from the caller. The core
pipeline is validate → bind → derive → persist, with zero model inference
and zero network.

## Proof classes

```text
EMPIRICAL   evidence + deterministic verification      (v0.1: implemented)
FORMAL      formal artifact + checker/toolchain result (v0.1: reserved)
COMPOSITE   multiple obligations / proof classes       (v0.1: reserved)
```

Building a non-EMPIRICAL proof fails loudly (`PROOF_CLASS_UNSUPPORTED`).
Ordinary verification receipts are never labeled formal proof:

```text
empirically verified != formally proved
formally proved under assumptions != preserved human intent
```

## Obligations and status

A claim declares one or more `ProofObligation`s, each binding an exact
claim + criterion + evidence set + verification receipt. Statuses derive
deterministically from receipt verdicts — read, never re-evaluated:

```text
PASS         → SATISFIED
FAIL         → VIOLATED
INCONCLUSIVE → UNRESOLVED
```

Over required obligations: any `VIOLATED` → `FAILED`; else any
`UNRESOLVED` → `INCOMPLETE`; else `COMPLETE`. Optional obligations
(`required: false`) are reported without affecting status.

## What COMPLETE means — and does not

COMPLETE means exactly this:

> All required proof obligations explicitly declared in this artifact are
> backed by integrity-valid verification receipts whose exact evidence and
> criteria produced PASS under the recorded verifier semantics.

It does **not** mean:

```text
COMPLETE != universal truth
COMPLETE != complete specification
COMPLETE != human intent satisfied
COMPLETE != task complete
COMPLETE != authority to act
COMPLETE artifact replayable != world still matches
```

The sharpest of these is the **specification gap**: proof completeness is
relative to declared obligations. Tests pass + typecheck passes can be
structurally COMPLETE while an undeclared requirement (say, backward
compatibility) stands unexamined. Proof cannot discover missing intent:

```text
representation != intent != permission
```

## References, not copies

The artifact stores immutable refs — `{evidence_id, content_hash}` and
`{verification_id, content_hash}` — never duplicate upstream bytes. Before
assembly, every record validates against `opencode.evidence.v1` and every
receipt against `opencode.verification.v1`, both integrity-recomputed; then
cross-bindings are enforced (receipt claim ≡ artifact claim, obligation
criterion ≡ receipt criterion, evidence sets equal, per-record hashes equal
the receipt-bound hashes). Mismatches are `PROOF_BINDING_MISMATCH` errors,
never statuses.

## Replay (not re-verification)

`proof_replay` re-establishes structural validity against the exact
referenced bytes: artifact/evidence/receipt integrity, ref hashes,
bindings, re-derived statuses vs the stored declaration → `REPLAY_MATCH` or
a named failure (`PROOF_INTEGRITY_FAILURE`, `EVIDENCE_INTEGRITY_FAILURE`,
`VERIFICATION_INTEGRITY_FAILURE`, `PROOF_BINDING_MISMATCH`,
`STATUS_MISMATCH`, `MISSING_DEPENDENCY`). It never executes tools, tests,
criteria, or models — receipt hashes already bind verdicts to evidence, so
re-running the evaluator would be world re-verification (Verify's job).
`REPLAY_MATCH` means the historical argument is intact, never that it is
fresh: yesterday's passing tests replay fine after today's breaking change.

## Example

```text
Claim:  "The declared build gate is satisfied."
O1: bun --version exits 0 ... Evidence ev_85f1… Verification vr_6407… PASS → SATISFIED
O2: node --version exits 0 ... Evidence ev_973c… Verification vr_64e2… PASS → SATISFIED
Status: COMPLETE (2/2 required satisfied)
```

See `proof.example.json` for the full `opencode.proof.v1` shape.

## Upstream integration (no runtime dependencies)

Both upstreams are local-only packages, so Proof vendors pinned read-only
contracts (`src/evidence-contract.ts` @ `opencode-evidence@88cc2e6`,
`src/verify-contract.ts` @ `opencode-verify@a341298`): validation,
integrity, and normalization only — never evaluation, never authorship.
Drift is detected by byte-identical real fixtures plus live cross-checks:
the smoke chain builds records with upstream Evidence code and receipts
with upstream Verify code, and Proof's vendored validators accept every
live byte. One deliberate adaptation: schema gates distinguish
`UNSUPPORTED_*_SCHEMA` from malformed input (upstream authors its own
schema, so it never needed the distinction; identical behavior on genuine
v1 artifacts).

## Install

```sh
bun install
bun run check   # typecheck + tests
bun run build
```

```json
{ "plugins": ["file:///absolute/path/to/opencode-proof"] }
```

## Tools (five)

| Tool | Purpose |
|---|---|
| `proof_build` | Assemble + persist a `ProofArtifact` from claim, obligations, evidence, receipts. Binding/integrity failures return `ok:false` + `error_code`. |
| `proof_get` | Retrieve by id. Read-only. |
| `proof_explain` | Deterministic rendering incl. the specification-gap disclaimer. |
| `proof_replay` | Structural replay → `REPLAY_MATCH` or named failure. |
| `proof_health` | Versions, classes, upstream schemas, store, `model_inference: none`, `network: none`. |

## Checks

```sh
bun run typecheck
bun test            # 56 tests, 240 assertions, 9 files
bun run build
bun src/dev-cli.ts load    # module loads, 5 tools register, health clean
bun src/dev-cli.ts smoke   # real 3-project chain (or pinned fixtures if upstreams absent)
```

Live OpenCode-runtime integration is **UNVERIFIED**; offline load proves
everything provable without inference.

## Identity

`proof_id = pf_ + sha256({schema, class, claim, obligations, refs, status,
summary, producer})` (full 64-hex). `assembled_at` is annotation
(first-write-wins; re-builds idempotent), excluded from identity and hash —
same family convention as Evidence `observed_at` and Verify `evaluated_at`.
