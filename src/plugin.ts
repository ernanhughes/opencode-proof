import { Plugin } from "@opencode/plugin";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { ProofEngine } from "./engine";
import {
  ProofBuildTool,
  ProofExplainTool,
  ProofGetTool,
  ProofHealthTool,
  ProofReplayTool,
} from "./tools";

const ProofPlugin = Plugin.define({
  id: "opencode-proof",

  async setup(ctx) {
    const directory = ctx.location.directory;
    const engine = new ProofEngine(directory);

    try {
      const health = engine.doctor();
      if (!health["ok"]) {
        console.warn(
          `[opencode-proof] store not ready: ${String(health["message"] ?? "see proof_health")}`,
        );
      }
    } catch (error) {
      console.warn(`[opencode-proof] unavailable at startup: ${String(error).slice(0, 300)}`);
    }

    const tools: ToolInfo[] = [
      ProofBuildTool(engine),
      ProofGetTool(engine),
      ProofExplainTool(engine),
      ProofReplayTool(engine),
      ProofHealthTool(engine),
    ];

    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
  },
});

export default ProofPlugin;
