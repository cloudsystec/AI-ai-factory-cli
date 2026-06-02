import { readGlobalRules, systemSecurityRules } from "./agent-prompts.js";
import { runCursorAgent } from "./cursor-agent-runner.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("error-recovery");

const MAX_ATTEMPTS = Number(process.env.MAX_ERROR_RECOVERY_ATTEMPTS ?? 1);

/**
 * @param {unknown} error
 */
export function isRecoverableError(error) {
  if (!error) return false;
  const code = String(error?.code || "").toUpperCase();
  const msg = String(error?.message || "").toLowerCase();

  if (code === "ETIMEDOUT" || code === "ESRCH") return true;
  if (msg.includes("etimedout") || msg.includes("spawnsync")) return true;
  if (msg.includes("agent exit")) return true;
  if (msg.includes("fetch failed") || msg.includes("econnreset")) return true;
  if (msg.includes("socket hang up")) return true;

  return false;
}

export function maxErrorRecoveryAttempts() {
  return Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS >= 0 ? MAX_ATTEMPTS : 1;
}

/**
 * Invoca agente de recuperação antes de re-tentar o passo original.
 * @param {{
 *   roleFile: string,
 *   agentName: string,
 *   error: Error,
 *   task: { id: string, title?: string },
 *   project: string,
 *   step?: string,
 *   reportRootPrompt: string,
 * }} opts
 */
export function attemptErrorRecovery(opts) {
  const { roleFile, agentName, error, task, project, step, reportRootPrompt } = opts;

  const prompt = `
Leia AGENTS.md e agents/error-recovery.md.

Conteúdo de AGENTS.md:
${readGlobalRules()}

Contexto da falha:
- Projeto: ${project}
- Task: ${task.id}${task.title ? ` — ${task.title}` : ""}
- Agente que falhou: ${agentName} (${roleFile})
- Passo do pipeline: ${step || "desconhecido"}
- Erro: ${error?.message || String(error)}
- Código: ${error?.code || "—"}

Diretório do projeto:
${reportRootPrompt}/

Grave o relatório em:
${reportRootPrompt}/reports/tasks/${task.id}-error-recovery.md

Objetivo: diagnosticar e corrigir o mínimo necessário para permitir retry do agente ${agentName}.

${systemSecurityRules()}
`;

  log.warn("Tentativa de recuperação IA", {
    task: task.id,
    agent: agentName,
    step: step || "—",
    error: error?.message?.slice(0, 120),
  });

  runCursorAgent({
    agentFile: "agents/error-recovery.md",
    agentName: "Error Recovery",
    prompt,
    skipAgents: process.env.AI_FACTORY_SKIP_AGENTS === "1" || process.env.AI_FACTORY_SKIP_AGENTS === "true",
    meta: { project, task: task.id, step, recoveryFor: agentName },
  });
}

/**
 * Executa fn; em erro recuperável tenta recovery + retry até maxErrorRecoveryAttempts().
 * @template T
 * @param {() => T} fn
 * @param {{
 *   roleFile: string,
 *   agentName: string,
 *   task: { id: string, title?: string },
 *   project: string,
 *   step?: string,
 *   reportRootPrompt: string,
 * }} ctx
 * @returns {T}
 */
export function runWithErrorRecovery(fn, ctx) {
  const max = maxErrorRecoveryAttempts();
  let lastError;

  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isRecoverableError(error) || attempt >= max) {
        throw error;
      }
      attemptErrorRecovery({ ...ctx, error });
      log.info("Re-tentando agente após recuperação", {
        task: ctx.task.id,
        agent: ctx.agentName,
        attempt: attempt + 1,
      });
    }
  }

  throw lastError;
}
