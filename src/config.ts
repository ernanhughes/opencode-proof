import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex } from "./canonical";

export type ProofConfig = {
  store_dir?: string;
  evidence_store_dir?: string;
  verification_store_dir?: string;
};

/**
 * Storage decision (v0.1), same philosophy as the siblings:
 * per-project user-data space by default, explicit opt-in for anything
 * else via OPENCODE_PROOF_DIR or <project>/.opencode/proof.json.
 * Proof artifacts never share a directory with evidence or receipts.
 */
export function defaultStoreDir(projectDir: string): string {
  const canonical = resolve(projectDir).replace(/\\/g, "/").toLowerCase();
  const slug = sha256Hex(canonical).slice(0, 12);
  return join(userDataDir(), "opencode-proof", "projects", `pf-${slug}`);
}

function userDataDir(): string {
  if (process.platform === "win32") {
    return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
}

export function loadFileConfig(projectDir: string): ProofConfig {
  const path = join(resolve(projectDir), ".opencode", "proof.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`PROOF_CONFIG_INVALID: ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`PROOF_CONFIG_INVALID: ${path} must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;
  const out: ProofConfig = {};
  for (const key of ["store_dir", "evidence_store_dir", "verification_store_dir"] as const) {
    if (cfg[key] !== undefined) {
      if (typeof cfg[key] !== "string") {
        throw new Error(`PROOF_CONFIG_INVALID: ${key} must be a string`);
      }
      if ((cfg[key] as string).length > 0) out[key] = cfg[key] as string;
    }
  }
  return out;
}

export function resolveStoreDir(projectDir: string, overrides: ProofConfig = {}): string {
  const env = process.env["OPENCODE_PROOF_DIR"];
  if (env && env.length > 0) return resolve(env);
  const fileCfg = loadFileConfig(projectDir);
  const configured = overrides.store_dir ?? fileCfg.store_dir;
  if (configured && configured.length > 0) return resolve(projectDir, configured);
  return defaultStoreDir(projectDir);
}

function resolveUpstreamDir(
  projectDir: string,
  perCall: string | undefined,
  envName: string,
  configKey: "evidence_store_dir" | "verification_store_dir",
  overrides: ProofConfig,
): string | undefined {
  if (perCall && perCall.length > 0) return resolve(projectDir, perCall);
  const env = process.env[envName];
  if (env && env.length > 0) return resolve(env);
  const fileCfg = loadFileConfig(projectDir);
  const configured = overrides[configKey] ?? fileCfg[configKey];
  if (configured && configured.length > 0) return resolve(projectDir, configured);
  return undefined;
}

export function resolveEvidenceStoreDir(
  projectDir: string,
  overrides: ProofConfig = {},
  perCall?: string,
): string | undefined {
  return resolveUpstreamDir(projectDir, perCall, "OPENCODE_EVIDENCE_DIR", "evidence_store_dir", overrides);
}

export function resolveVerificationStoreDir(
  projectDir: string,
  overrides: ProofConfig = {},
  perCall?: string,
): string | undefined {
  return resolveUpstreamDir(projectDir, perCall, "OPENCODE_VERIFY_DIR", "verification_store_dir", overrides);
}
