export const PLUGIN_ID = "opencode-proof" as const;
export const PLUGIN_VERSION = "0.1.0" as const;
export const PROOF_SCHEMA = "opencode.proof.v1" as const;

/**
 * Upstream contracts this component was built and tested against.
 * There are no runtime dependencies on either upstream package (both are
 * local-only with no registry presence); instead src/evidence-contract.ts
 * and src/verify-contract.ts vendor pinned read-only copies of the
 * validation + integrity + normalization rules. Drift is detected by
 * byte-identical real fixtures (tests/fixtures/) plus optional smoke-time
 * cross-checks against adjacent checkouts.
 */
export const EVIDENCE_CONTRACT_REF = "opencode-evidence@88cc2e6" as const;
export const VERIFY_CONTRACT_REF = "opencode-verify@a341298" as const;
export const SUPPORTED_EVIDENCE_SCHEMAS: readonly string[] = ["opencode.evidence.v1"];
export const SUPPORTED_VERIFICATION_SCHEMAS: readonly string[] = ["opencode.verification.v1"];

/** Reserved union. Only EMPIRICAL is buildable in v0.1. */
export const SUPPORTED_PROOF_CLASSES: readonly string[] = ["EMPIRICAL", "FORMAL", "COMPOSITE"];
export const BUILDABLE_PROOF_CLASSES: readonly string[] = ["EMPIRICAL"];
