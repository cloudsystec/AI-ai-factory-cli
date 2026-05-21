import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cursorAgentArgv, cursorCommand } from "./cursor-agent-cli.js";
import {
  recordAiCallStart,
  recordAiCallEnd,
} from "../src/ai-call-billing.js";

/**
 * Executa o Cursor CLI com registo de billing por chamada.
 * @param {{
 *   agentFile: string,
 *   agentName?: string,
 *   prompt: string,
 *   skipAgents?: boolean,
 *   debugPromptDir?: string,
 * }} opts
 */
export function runCursorAgent(opts) {
  const {
    agentFile,
    agentName,
    prompt,
    skipAgents = false,
    debugPromptDir,
  } = opts;

  const callId = recordAiCallStart({
    agentFile,
    agentName,
    skipped: skipAgents,
  });

  if (skipAgents) {
    console.log(`\n[AI_FACTORY_SKIP_AGENTS] Agente ignorado: ${agentFile}\n`);
    if (process.env.AI_FACTORY_DEBUG_PROMPT === "1" && debugPromptDir) {
      fs.mkdirSync(debugPromptDir, { recursive: true });
      const safeName = agentFile.replace(/[/\\]/g, "-").replace(/\.md$/, "");
      const out = path.join(debugPromptDir, `${Date.now()}-${safeName}.prompt.txt`);
      fs.writeFileSync(out, prompt, "utf-8");
      console.log(`  Prompt gravado em: ${out}\n`);
    }
    recordAiCallEnd(callId);
    return;
  }

  try {
    execFileSync(cursorCommand(), cursorAgentArgv(), {
      input: prompt,
      stdio: ["pipe", "inherit", "inherit"],
      cwd: process.cwd(),
      shell: true,
      env: process.env,
    });
  } finally {
    recordAiCallEnd(callId);
  }
}
