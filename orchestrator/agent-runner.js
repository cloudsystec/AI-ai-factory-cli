import { runCursorAgent } from "./cursor-agent-runner.js";
import { runLunaAgent } from "./luna-agent-runner.js";
import { resolveWorkerAiProvider } from "./luna-model-router.js";

/**
 * Facade: Cursor ou Luna por rota (job/agent) ou AI_FACTORY_BOT_MODE.
 * @param {Parameters<typeof runCursorAgent>[0] & { aiProvider?: string }} opts
 */
export async function runAgent(opts) {
  const envOverride = String(process.env.AI_FACTORY_JOB_AI_PROVIDER || "").trim();
  const resolved =
    opts?.aiProvider
      ? { provider: String(opts.aiProvider).toLowerCase() }
      : envOverride
        ? { provider: envOverride.toLowerCase() }
        : resolveWorkerAiProvider({
            agentName: opts?.agentName,
            agentFile: opts?.agentFile,
            jobKind: process.env.AI_FACTORY_JOB_KIND,
          });

  if (resolved.provider === "luna") return /** @type {Promise<string|undefined>} */ (runLunaAgent(opts));
  return runCursorAgent(opts);
}

export { runCursorAgent, runLunaAgent };
