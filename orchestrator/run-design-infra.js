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

const log = createLogger("design-infra");

const project = process.argv[2];
if (!project) {
  console.error("Uso: node orchestrator/run-design-infra.js <projeto>");
  process.exit(1);
}

const wsRoot = workspaceRoot(project);
const designDir = path.join(wsRoot, "design");
const infraFile = path.join(designDir, "infra.json");
const macroFile = macroScopeFile(project, project);

function readMacroBody() {
  if (!fs.existsSync(macroFile)) return "";
  return fs.readFileSync(macroFile, "utf-8").replace(/^\uFEFF/, "");
}

function shouldSkipAgents() {
  const v = process.env.AI_FACTORY_SKIP_AGENTS;
  return v === "1" || v === "true";
}

function writeStubInfra() {
  fs.mkdirSync(designDir, { recursive: true });
  const infra = {
    version: 1,
    status: "review",
    nodes: [
      {
        id: "web",
        label: "Frontend",
        type: "frontend",
        icon: "react",
        description: "Vite/React SPA",
      },
      {
        id: "api",
        label: "API",
        type: "backend",
        icon: "nodedotjs",
        description: "Node.js REST",
      },
      {
        id: "db",
        label: "PostgreSQL",
        type: "database",
        icon: "postgresql",
        description: "Postgres gerido (Railway)",
      },
    ],
    edges: [
      { from: "web", to: "api", label: "HTTPS" },
      { from: "api", to: "db", label: "SQL" },
    ],
    notes: ["Deploy Railway — serviços web + Postgres"],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(infraFile, JSON.stringify(infra, null, 2), "utf-8");
  console.log("\n[skip] Stub infra.json gravado\n");
}

async function invokeInfraAgent() {
  const agentFile = "agents/infra-diagram.md";
  const macro = readMacroBody();
  const prompt = `
Leia AGENTS.md e ${agentFile}.

Conteúdo de AGENTS.md:
${readGlobalRules()}

Conteúdo de ${agentFile}:
${readAgentFile(agentFile)}

---

Projeto: ${project}
Grave o diagrama em: ${infraFile}

Escopo macro:
${macro || "(vazio)"}

${systemSecurityRules()}
`;
  fs.mkdirSync(designDir, { recursive: true });
  await executeAgent({
    agentFile,
    agentName: "InfraDiagram",
    prompt,
    skipAgents: shouldSkipAgents(),
    meta: { project, step: "design-infra" },
  });
}

installBillingSignalHandlers();

async function main() {
  console.log(`\n=== Design infra: ${project} ===\n`);
  if (shouldSkipAgents()) {
    writeStubInfra();
  } else {
    await invokeInfraAgent();
  }
  if (!fs.existsSync(infraFile)) {
    writeStubInfra();
  }
  await flushPendingSettlements();
  console.log("\n=== Design infra concluído ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
