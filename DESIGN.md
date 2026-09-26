# DESIGN.md — opencode-proof v0.1

## Responsibility

Assemble claims, proof obligations, evidence records, and verification
receipts into inspectable, replayable `ProofArtifact`s. Validate
everything; bind obligations to receipts; derive statuses; persist.
Generate no conclusions.

## Non-responsibilities

Inventing claims/criteria/obligations; discovering evidence; executing
commands or tests; evaluating criteria (Verify); authorizing action
(Authority); accepting work (Work); formal checking (future FORMAL
adapters); model inference of any kind.

Non-goals: LLM judge, proof search, theorem proving, Lean integration,
probabilistic confidence, generic policy engine, remote services, signing
infrastructure, databases.

## ProofClass

`"EMPIRICAL" | "FORMAL" | "COMPOSITE"`. Only EMPIRICAL builds in v0.1;
anything else is `PROOF_CLASS_UNSUPPORTED` at both validation and build.
FORMAL reservation (for later): specification, assumptions, proof
source/artifact, checker + version, checker output evidence, source hashes
— e.g. "Lean accepted theorem T under assumptions A with toolchain V for
source hash H". COMPOSITE reservation: mixed-class obligations (note: an
authority approval, if ever represented, must be a distinct obligation kind
— authority is not proof of truth). Empirical verification is never called
formal proof; the artifact carries no formal-shaped fields (banned words
pinned by tests).

## ProofObligation

`{obligation_id, description, claim_id, criterion, evidence_ids[],
verification_id, required=true}`. `obligation_id = ob_ +
sha256({description, claim_id, criterion, evidence_ids sorted,
verification_id, required})[0:32]`; caller-supplied ids must equal the
derivation or fail (`INVALID_OBLIGATION`). Criteria normalize through the
byte-identical vendored Verify validation so canonical comparison with
receipt criteria is exact. Unknown fields fail closed. A claim needs ≥1
obligation — no vacuous COMPLETE.

## Status semantics

`PASS→SATISFIED, FAIL→VIOLATED, INCONCLUSIVE→UNRESOLVED` (table lookup, no
evaluation). Over required obligations: any VIOLATED → FAILED; else any
UNRESOLVED → INCOMPLETE; else COMPLETE. Summary `{required, satisfied,
violated, unresolved}` counts required only; optional obligations are
reported in `obligation_statuses` without affecting status.

## Specification gap (first-class principle)

COMPLETE is relative to declared obligations. The artifact cannot know
undeclared intent and must not pretend otherwise: `proof_explain` states
the gap on every artifact, and tests pin a COMPLETE proof that is silent
on an obvious-but-undeclared requirement. `representation != intent !=
permission`.

## ProofArtifact

`opencode.proof.v1`: `proof_id`, `proof_class`, `claim`, `obligations[]`
(sorted by id), `evidence[]` (`{evidence_id, content_hash}`, sorted),
`verifications[]` (`{verification_id, content_hash}`, sorted), `status`,
`summary`, `assembled_at`, `producer{plugin, version}`, `content_hash`.
References only — no embedded upstream bytes. Forbidden fields span task,
authority, truth, intent, confidence, and formal-proof vocabulary
(`PROOF_FORBIDDEN_FIELD`); there is no free-form metadata field to smuggle
them through.

## Upstream validation

Every record: structure + `opencode.evidence.v1` membership + producer pin
+ hash/id recompute. Every receipt: structure + `opencode.verification.v1`
membership + verifier pin + id/hash recompute + verdict/result consistency.
No runtime deps: vendored read-only contracts pinned to
`opencode-evidence@88cc2e6` / `opencode-verify@a341298`, drift-detected by
byte-identical fixtures and live smoke cross-checks. One deliberate
adaptation: `UNSUPPORTED_*_SCHEMA` distinct from malformed (behaviorally
identical on genuine v1 bytes). Proof authors no upstream bytes — only
validates them.

## Binding rules (all-or-error)

For each obligation: `obligation.claim_id == artifact claim_id`;
`canonical(receipt.claim) == canonical(artifact claim)`;
`canonical(obligation.criterion) == canonical(receipt.criterion)`;
`obligation.evidence_ids` set-equals `receipt.evidence_ids`;
`receipt.evidence_hashes` keys cover `evidence_ids`; each resolved record's
`content_hash` equals the receipt-bound hash. Any violation →
`PROOF_BINDING_MISMATCH`. Corrupt inputs are errors, never statuses
(`INVALID_*`, `*_INTEGRITY_FAILURE`, `MISSING_DEPENDENCY`).

## Identity / integrity

`proof_id = pf_ + sha256({schema, class, claim, obligations, evidence refs,
verification refs, status, summary, producer})` — full 64 hex; producer
version participates (assembly semantics can change); `assembled_at` and
path excluded. `content_hash` covers the same decision inputs minus itself
and `assembled_at` (annotation-only tampering undetectable — stated
plainly, same convention as siblings). Engine re-build is idempotent
first-write-wins (stored copy integrity-checked); the store stays byte-exact
and collision-loud (`PROOF_ID_COLLISION`).

## Replay

Re-resolve refs (inline → engine resolvers → per-call store dirs), re-check
all integrity, compare resolved hashes to bound refs, re-check bindings,
re-derive status/summary, compare to stored declaration. Outcomes:
`REPLAY_MATCH | MISSING_DEPENDENCY | PROOF_INTEGRITY_FAILURE |
EVIDENCE_INTEGRITY_FAILURE | VERIFICATION_INTEGRITY_FAILURE |
PROOF_BINDING_MISMATCH | STATUS_MISMATCH`. No criteria re-evaluation (receipt
hashes already bind verdicts to evidence — re-running the evaluator is
world re-verification, Verify's job). `STATUS_MISMATCH` is primarily a
cross-version derivation guard. `replayability != freshness`, documented on
every explanation.

## Storage

`ProofStore`: `<storeDir>/proofs/<pf_…>.json`, pretty-canonical JSON, tmp +
rename, 1 MiB cap, read-only get. Default per-project user-data space
(`pf-<hash12>`); overrides via `OPENCODE_PROOF_DIR` /
`.opencode/proof.json` (+ per-call upstream store dirs). Never mixed with
evidence or receipts.

## Resolvers

`EvidenceResolver` / `VerificationResolver` (map + read-only file-layout
implementations). Core takes artifacts; only the edge resolves ids. No
network resolver in v0.1. Resolver failures are typed (`ResolveError`) so
build maps them to `ProofError` codes and replay collects them per-side.

## Boundaries

Authority (permission), Work (acceptance), Evidence (observation), Verify
(evaluation) are separate. `proof_explain` renders; it judges nothing new.
