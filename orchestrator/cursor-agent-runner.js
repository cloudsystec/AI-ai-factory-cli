import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cursorAgentArgv, cursorCommand } from "./cursor-agent-cli.js";
import {
  recordAiCallStart,
  recordAiCallEnd,
  settleAiCall,
} from "../src/ai-call-billing.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("agent");

/**
 * Executa o Cursor CLI com registo de billing por chamada.
 * @param {{
 *   agentFile: string,
 *   agentName?: string,
 *   prompt: string,
 *   skipAgents?: boolean,
 *   debugPromptDir?: string,
 *   meta?: { project?: string, task?: string, step?: string },
 * }} opts
 */
export function runCursorAgent(opts) {
  const {
    agentFile,
    agentName,
    prompt,
    skipAgents = false,
    debugPromptDir,
    meta = {},
  } = opts;

  const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 300_000);
  const label = agentName || agentFile;

  const callId = recordAiCallStart({
    agentFile,
    agentName,
    skipped: skipAgents,
    meta,
  });

  if (skipAgents) {
    log.debug(`Agente ignorado (SKIP_AGENTS)`, { agent: label, file: agentFile });
    if (process.env.AI_FACTORY_DEBUG_PROMPT === "1" && debugPromptDir) {
      fs.mkdirSync(debugPromptDir, { recursive: true });
      const safeName = agentFile.replace(/[/\\]/g, "-").replace(/\.md$/, "");
      const out = path.join(debugPromptDir, `${Date.now()}-${safeName}.prompt.txt`);
      fs.writeFileSync(out, prompt, "utf-8");
      log.debug(`Prompt gravado`, { path: out });
    }
    recordAiCallEnd(callId);
    settleAiCall(callId);
    return;
  }

  log.debug(`Chamada IA iniciada`, {
    agent: label,
    file: agentFile,
    timeoutMs: AGENT_TIMEOUT_MS,
    promptLen: prompt.length,
  });
  const startMs = Date.now();

  try {
    execFileSync(cursorCommand(), cursorAgentArgv(), {
      input: prompt,
      stdio: ["pipe", "inherit", "inherit"],
      cwd: process.cwd(),
      shell: true,
      env: process.env,
      timeout: AGENT_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startMs;
    log.debug(`Chamada IA concluída`, {
      agent: label,
      elapsedMs,
      elapsedSec: `${(elapsedMs / 1000).toFixed(1)}s`,
    });
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    log.warn(`Chamada IA falhou`, {
      agent: label,
      elapsedMs,
      elapsedSec: `${(elapsedMs / 1000).toFixed(1)}s`,
      error: err.message?.slice(0, 120),
    });
    throw err;
  } finally {
    recordAiCallEnd(callId);
    settleAiCall(callId);
  }
}
