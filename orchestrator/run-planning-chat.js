import fs from "node:fs";
import path from "node:path";
import { macroScopeFile, workspaceRoot } from "./project-paths.js";
import { readAgentFile, readGlobalRules, systemSecurityRules } from "./agent-prompts.js";
import { runAgent as executeAgent } from "./agent-runner.js";
import {
  flushPendingSettlements,
  installBillingSignalHandlers,
} from "../src/ai-call-billing.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("planning-chat");

const project = process.argv[2];
const lane = process.argv[3];

if (!project || (lane !== "layout" && lane !== "infra")) {
  console.error("Uso: node orchestrator/run-planning-chat.js <projeto> <layout|infra>");
  process.exit(1);
}

const RESULT_FILE = ".planning-chat-result.json";
const jobKind = lane === "layout" ? "planning-chat-layout" : "planning-chat-infra";
const agentFile = lane === "layout" ? "agents/layout-revise.md" : "agents/infra-revise.md";
const agentName = lane === "layout" ? "LayoutRevise" : "InfraRevise";

const wsRoot = workspaceRoot(project);
const designDir = path.join(wsRoot, "design");
const previewDir = path.join(designDir, "preview");

/**
 * @returns {object}
 */
function readJobPayload() {
  const raw = process.env.AI_FACTORY_JOB_PAYLOAD || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shouldSkipAgents() {
  const v = process.env.AI_FACTORY_SKIP_AGENTS;
  return v === "1" || v === "true";
}

function readMacroBody() {
  const macroFile = macroScopeFile(project, project);
  if (!fs.existsSync(macroFile)) return "";
  return fs.readFileSync(macroFile, "utf-8").replace(/^\uFEFF/, "");
}

/**
 * @param {string} raw
 */
function parsePlanningChatResponse(raw) {
  const text = String(raw ?? "").trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [text];
  if (fenceMatch?.[1]) candidates.unshift(fenceMatch[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        assistantMessage: String(
          parsed.assistantMessage ?? parsed.message ?? "Alteração aplicada."
        ).trim(),
        previewVersion:
          parsed.previewVersion != null ? Number(parsed.previewVersion) : undefined,
        infraVersion:
          parsed.infraVersion != null ? Number(parsed.infraVersion) : undefined,
      };
    } catch {
      /* next */
    }
  }
  return { assistantMessage: text.slice(0, 2000) || "Alteração aplicada." };
}

function readManifestVersion() {
  const manifestPath = path.join(designDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest.version != null ? Number(manifest.version) : undefined;
  } catch {
    return undefined;
  }
}

function readInfraVersion() {
  const infraPath = path.join(designDir, "infra.json");
  if (!fs.existsSync(infraPath)) return undefined;
  try {
    const infra = JSON.parse(fs.readFileSync(infraPath, "utf-8"));
    return infra.version != null ? Number(infra.version) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} result
 */
function writeResultFile(result) {
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, RESULT_FILE),
    JSON.stringify({ ...result, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}

function writeSkipStub() {
  const version = (readManifestVersion() ?? 0) + 1;
  if (lane === "layout") {
    fs.mkdirSync(previewDir, { recursive: true });
    writeResultFile({
      assistantMessage: "[skip] Revisão simulada (SKIP_AGENTS).",
      previewVersion: version,
    });
  } else {
    writeResultFile({
      assistantMessage: "[skip] Revisão infra simulada (SKIP_AGENTS).",
      infraVersion: (readInfraVersion() ?? 0) + 1,
    });
  }
}

/**
 * @param {object} payload
 */
function buildPrompt(payload) {
  const scopeMd = String(payload.scopeMd ?? readMacroBody() ?? "").trim();
  const attachmentContext = String(payload.attachmentContext ?? "");
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const history = messages
    .map((m) => `${m.role === "assistant" ? "Assistente" : "Usuário"}: ${m.content}`)
    .join("\n\n");

  let globalRules = "";
  try {
    globalRules = readGlobalRules();
  } catch {
    globalRules = "(AGENTS.md não encontrado)";
  }

  let agentBody = "";
  try {
    agentBody = readAgentFile(agentFile);
  } catch {
    agentBody = `(agente ${agentFile} não encontrado)`;
  }

  return `${agentBody}

Conteúdo de AGENTS.md:
${globalRules}

---

Projeto: ${project}
Diretório raiz do workspace: ${wsRoot}
Escopo macro:
${scopeMd || "(vazio)"}

Diretórios de trabalho:
- Layout/preview: ${path.join(wsRoot, "design/preview/")}
- Manifest: ${path.join(wsRoot, "design/manifest.json")}
- Infra: ${path.join(wsRoot, "design/infra.json")}
${attachmentContext}

Histórico:
${history}

Aplique a alteração pedida pelo utilizador nos ficheiros adequados em design/.
Depois de editar os ficheiros, responda apenas com JSON:
{
  "assistantMessage": "texto para o operador",
  "previewVersion": number (opcional, incrementar se alterou layout),
  "infraVersion": number (opcional, incrementar se alterou infra)
}

${systemSecurityRules()}
`;
}

async function invokeReviseAgent() {
  const payload = readJobPayload();
  const prompt = buildPrompt(payload);

  fs.mkdirSync(designDir, { recursive: true });
  if (lane === "layout") {
    fs.mkdirSync(previewDir, { recursive: true });
  }

  const raw = await executeAgent({
    agentFile,
    agentName,
    prompt,
    skipAgents: shouldSkipAgents(),
    meta: { project, step: jobKind, jobKind },
  });

  const parsed = parsePlanningChatResponse(raw || "");
  const result = {
    assistantMessage: parsed.assistantMessage,
    previewVersion:
      parsed.previewVersion ??
      (lane === "layout" ? readManifestVersion() : undefined),
    infraVersion:
      parsed.infraVersion ?? (lane === "infra" ? readInfraVersion() : undefined),
  };
  writeResultFile(result);
  console.log(`\n[planning-chat] Resultado gravado em design/${RESULT_FILE}\n`);
}

installBillingSignalHandlers();

async function main() {
  console.log(`\n=== Planning chat (${lane}): ${project} ===\n`);
  if (shouldSkipAgents()) {
    writeSkipStub();
  } else {
    await invokeReviseAgent();
  }
  await flushPendingSettlements();
  console.log(`\n=== Planning chat concluído ===\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
