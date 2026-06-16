import {
  recordAiCallStart,
  recordAiCallEnd,
} from "../src/ai-call-billing.js";
import { createLogger } from "../src/logger.js";
import { buildLunaContextPack, updateLunaSessionMemory } from "./luna-context-pack.js";
import { resolveLunaProfile } from "./luna-model-router.js";
import { LUNA_TOOLS, executeLunaTool } from "./luna-tools.js";

const log = createLogger("luna-agent");
const MAX_TOOL_ROUNDS = Number(process.env.LUNA_MAX_TOOL_ROUNDS || 8);

/**
 * Headers de billing/correlação para o router Luna.
 * @param {string} profileKey
 * @param {string} callId
 */
export function buildLunaRequestHeaders(profileKey, callId) {
  const jobId = process.env.AI_FACTORY_JOB_ID || "";
  const tenantId = process.env.TENANT_ID || "";
  const secret = process.env.WORKER_SECRET || "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
    "X-Luna-Profile": profileKey,
    "X-Luna-Job-Id": jobId,
    "X-Luna-Call-Id": callId,
    "X-Tenant-Id": tenantId,
  };
}

/**
 * @param {string} lunaBaseUrl
 * @param {object} body
 * @param {Record<string, string>} headers
 */
async function chatCompletions(lunaBaseUrl, body, headers) {
  const base = lunaBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const billingErr = res.headers.get("X-Luna-Billing-Error");
    throw new Error(
      `Luna ${res.status}: ${text.slice(0, 400)}${billingErr ? ` [billing: ${billingErr}]` : ""}`
    );
  }
  return JSON.parse(text);
}

/**
 * Executa agente Luna com tool loop; billing settle no router.
 * @param {object} opts
 */
export async function runLunaAgent(opts) {
  const {
    agentFile,
    agentName,
    prompt,
    skipAgents = false,
    meta = {},
    timeoutMs,
  } = opts;

  const AGENT_TIMEOUT_MS = Number(
    timeoutMs || process.env.AGENT_TIMEOUT_MS || 300_000
  );
  const label = agentName || agentFile;
  const lunaBaseUrl = String(process.env.LUNA_BASE_URL || "").trim();
  if (!skipAgents && !lunaBaseUrl) {
    throw new Error(
      "LUNA_BASE_URL ausente — configure no .env do tenant (bot_mode=luna)"
    );
  }

  const callId = recordAiCallStart({
    agentFile,
    agentName,
    skipped: skipAgents,
    meta,
    prompt,
  });

  if (skipAgents) {
    log.debug(`Agente Luna ignorado (SKIP_AGENTS)`, { agent: label });
    recordAiCallEnd(callId);
    return "";
  }

  const { profileKey } = resolveLunaProfile({
    agentName,
    agentFile,
    meta,
    jobKind: meta.jobKind || process.env.AI_FACTORY_JOB_KIND,
  });

  const fullPrompt = buildLunaContextPack({ prompt, meta });
  /** @type {Array<Record<string, unknown>>} */
  const messages = [
    {
      role: "system",
      content:
        "És Luna, agente de engenharia da AI Factory. Usa ferramentas quando precisares de ler ficheiros. Responde de forma concisa e accionável.",
    },
    { role: "user", content: fullPrompt },
  ];

  const headers = buildLunaRequestHeaders(profileKey, callId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    let round = 0;
    let finalContent = "";

    while (round < MAX_TOOL_ROUNDS) {
      round += 1;
      const completion = await chatCompletions(
        lunaBaseUrl,
        {
          model: profileKey,
          messages,
          tools: LUNA_TOOLS,
          tool_choice: "auto",
          temperature: 0.2,
        },
        headers
      );

      const choice = completion.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new Error("Resposta Luna vazia");

      if (msg.tool_calls?.length) {
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.tool_calls,
        });
        for (const tc of msg.tool_calls) {
          const fn = tc.function || tc;
          const result = executeLunaTool({
            name: fn.name,
            arguments: fn.arguments,
          });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: fn.name,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      finalContent = String(msg.content || "").trim();
      messages.push({ role: "assistant", content: finalContent });
      break;
    }

    const project = meta.project || process.env.AI_FACTORY_ACTIVE_PROJECT || "";
    const jobId = process.env.AI_FACTORY_JOB_ID || "";
    if (project && jobId) {
      updateLunaSessionMemory(jobId, project, messages, finalContent.slice(0, 500));
    }

    log.debug(`Chamada Luna concluída`, {
      agent: label,
      profile: profileKey,
      elapsedMs: Date.now() - startMs,
      contentLen: finalContent.length,
    });
    return finalContent;
  } catch (err) {
    log.warn(`Chamada Luna falhou`, {
      agent: label,
      profile: profileKey,
      error: err.message?.slice(0, 200),
    });
    throw err;
  } finally {
    clearTimeout(timer);
    recordAiCallEnd(callId);
  }
}
