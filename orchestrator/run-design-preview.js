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

const log = createLogger("design-preview");

const project = process.argv[2];
if (!project) {
  console.error("Uso: node orchestrator/run-design-preview.js <projeto>");
  process.exit(1);
}

const wsRoot = workspaceRoot(project);
const designDir = path.join(wsRoot, "design");
const previewDir = path.join(designDir, "preview");
const macroFile = macroScopeFile(project, project);

function readMacroBody() {
  if (!fs.existsSync(macroFile)) return "";
  return fs.readFileSync(macroFile, "utf-8").replace(/^\uFEFF/, "");
}

function shouldSkipAgents() {
  const v = process.env.AI_FACTORY_SKIP_AGENTS;
  return v === "1" || v === "true";
}

function writeStubPreview() {
  fs.mkdirSync(previewDir, { recursive: true });
  const manifest = {
    version: 1,
    status: "review",
    routes: [
      { path: "/", title: "Início" },
      { path: "/lista", title: "Lista" },
    ],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(designDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(previewDir, "styles.css"),
    `:root { --accent: #14b8a6; --bg: #0f172a; --text: #e2e8f0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); }
nav { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #334155; }
nav a { color: var(--accent); text-decoration: none; }
nav a.active { font-weight: 700; }
main { padding: 24px; max-width: 960px; margin: 0 auto; }
.card { background: #1e293b; border-radius: 12px; padding: 20px; margin-top: 16px; }
button { background: var(--accent); color: #042f2e; border: 0; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
.toast { position: fixed; bottom: 24px; right: 24px; background: #134e4a; padding: 12px 16px; border-radius: 8px; display: none; }
`,
    "utf-8"
  );
  fs.writeFileSync(
    path.join(previewDir, "app.js"),
    `const routes = {
  "/": renderHome,
  "/lista": renderList,
};
const mockItems = [
  { id: 1, name: "Item Alpha", status: "Ativo" },
  { id: 2, name: "Item Beta", status: "Pendente" },
];
function navigate(path) {
  window.location.hash = path;
}
function renderHome() {
  document.getElementById("app").innerHTML = \`
    <h1>Protótipo — Início</h1>
    <p class="card">Bem-vindo ao protótipo navegável. Use o menu para explorar.</p>
    <button type="button" id="mock-save">Salvar (mock)</button>\`;
  document.getElementById("mock-save")?.addEventListener("click", showToast);
}
function renderList() {
  document.getElementById("app").innerHTML = \`
    <h1>Lista</h1>
    <div class="card">\${mockItems.map(i => \`<div><strong>\${i.name}</strong> — \${i.status}</div>\`).join("")}</div>\`;
}
function showToast() {
  const t = document.getElementById("toast");
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 2000);
}
function router() {
  const path = window.location.hash.slice(1) || "/";
  document.querySelectorAll("nav a").forEach(a => {
    a.classList.toggle("active", a.getAttribute("href") === "#" + path);
  });
  (routes[path] || renderHome)();
}
window.addEventListener("hashchange", router);
router();
`,
    "utf-8"
  );
  fs.writeFileSync(
    path.join(previewDir, "index.html"),
    `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Protótipo</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <nav>
    <a href="#/">Início</a>
    <a href="#/lista">Lista</a>
  </nav>
  <main id="app"></main>
  <div id="toast" class="toast">Salvo (mock)</div>
  <script src="app.js"></script>
</body>
</html>`,
    "utf-8"
  );
  console.log("\n[skip] Stub de protótipo gravado em design/preview/\n");
}

async function invokePreviewAgent() {
  const agentFile = "agents/layout-prototype.md";
  const macro = readMacroBody();
  const prompt = `
Leia AGENTS.md e ${agentFile}.

Conteúdo de AGENTS.md:
${readGlobalRules()}

Conteúdo de ${agentFile}:
${readAgentFile(agentFile)}

---

Projeto: ${project}
Diretório raiz do workspace: ${wsRoot}
Crie ou substitua os ficheiros em:
- ${path.join(wsRoot, "design/manifest.json")}
- ${path.join(wsRoot, "design/preview/")}

Escopo macro:
${macro || "(vazio — use título genérico de app SaaS)"}

Gere um protótipo navegável completo conforme o agente.

${systemSecurityRules()}
`;
  fs.mkdirSync(previewDir, { recursive: true });
  await executeAgent({
    agentFile,
    agentName: "LayoutPrototype",
    prompt,
    skipAgents: shouldSkipAgents(),
    meta: { project, step: "design-preview" },
  });
}

installBillingSignalHandlers();

async function main() {
  console.log(`\n=== Design preview: ${project} ===\n`);
  if (shouldSkipAgents()) {
    writeStubPreview();
  } else {
    await invokePreviewAgent();
  }
  await flushPendingSettlements();
  console.log("\n=== Design preview concluído ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
