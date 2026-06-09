import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const orchestratorDir = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do repositório (pai de `orchestrator/`). */
export const repoRoot = path.resolve(orchestratorDir, "..");

/** Lê env em tempo de chamada (worker define AI_FACTORY_* após imports). */
function resolveWorkspacesDir() {
  return process.env.AI_FACTORY_WORKSPACES_DIR
    ? path.resolve(process.env.AI_FACTORY_WORKSPACES_DIR)
    : path.join(repoRoot, "workspaces");
}

function resolveMacroScopesDir() {
  return process.env.AI_FACTORY_MACRO_DIR
    ? path.resolve(process.env.AI_FACTORY_MACRO_DIR)
    : path.join(repoRoot, "scopes", "macro");
}

/**
 * Raiz do volume do tenant (AGENTS.md + agents/ + workspaces/).
 */
export function tenantRoot() {
  if (process.env.AI_FACTORY_TENANT_ROOT) {
    return path.resolve(process.env.AI_FACTORY_TENANT_ROOT);
  }
  if (process.env.AI_FACTORY_WORKSPACES_DIR) {
    return path.resolve(process.env.AI_FACTORY_WORKSPACES_DIR, "..");
  }
  return repoRoot;
}

/** Slug do projeto ativo (definido pelo worker em cada job). */
export function activeProjectSlug() {
  const slug = process.env.AI_FACTORY_ACTIVE_PROJECT?.trim();
  return slug && isValidProjectSlug(slug) ? slug : null;
}

/** Diretório agents/ do projeto ativo ou legado no tenant. */
export function agentsDir() {
  if (process.env.AI_FACTORY_AGENTS_DIR) {
    return path.resolve(process.env.AI_FACTORY_AGENTS_DIR);
  }
  const project = activeProjectSlug();
  if (project) {
    return path.join(workspaceRoot(project), "agents");
  }
  return path.join(tenantRoot(), "agents");
}

/** AGENTS.md (regras globais do projeto ou legado no tenant). */
export function globalAgentsFile() {
  const project = activeProjectSlug();
  if (project) {
    return path.join(workspaceRoot(project), "AGENTS.md");
  }
  if (process.env.AI_FACTORY_TENANT_ROOT) {
    return path.join(path.resolve(process.env.AI_FACTORY_TENANT_ROOT), "AGENTS.md");
  }
  return path.join(repoRoot, "AGENTS.md");
}

/**
 * @param {string} relativePath ex. agents/planner.md
 */
export function agentFilePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "AGENTS.md") {
    return globalAgentsFile();
  }
  const project = activeProjectSlug();
  if (project) {
    if (normalized.startsWith("agents/")) {
      const projectPath = path.join(workspaceRoot(project), normalized);
      if (fs.existsSync(projectPath)) return projectPath;
    } else {
      const projectPath = path.join(workspaceRoot(project), "agents", path.basename(normalized));
      if (fs.existsSync(projectPath)) return projectPath;
    }
  }
  if (normalized.startsWith("agents/")) {
    const legacy = path.join(tenantRoot(), normalized);
    if (fs.existsSync(legacy)) return legacy;
  }
  const legacyFlat = path.join(tenantRoot(), "agents", path.basename(normalized));
  if (fs.existsSync(legacyFlat)) return legacyFlat;
  const bundled = path.join(repoRoot, normalized);
  if (fs.existsSync(bundled)) return bundled;
  if (normalized.startsWith("agents/")) {
    return path.join(agentsDir(), path.basename(normalized));
  }
  return path.join(agentsDir(), path.basename(normalized));
}

/**
 * Slug seguro de projeto (evita path traversal).
 * @param {string} project
 */
export function isValidProjectSlug(project) {
  return typeof project === "string" && /^[a-zA-Z0-9_-]+$/.test(project);
}

/**
 * @param {string} project
 */
export function workspaceRoot(project) {
  return path.join(resolveWorkspacesDir(), project);
}

/**
 * @param {string} project
 */
export function backlogFile(project) {
  return path.join(workspaceRoot(project), "backlog", `${project}.tasks.json`);
}

/**
 * @param {string} project
 */
export function taskStateFile(project) {
  return path.join(workspaceRoot(project), "tasks-state.json");
}

/**
 * Preferências do `develop-next` (ex.: autorun entre tasks).
 * @param {string} project
 */
export function developSettingsFile(project) {
  return path.join(workspaceRoot(project), "develop-settings.json");
}

/**
 * Escopo macro na raiz do repositório (fora de `workspaces/<projeto>/`).
 * O parâmetro `project` é mantido por compatibilidade de assinatura; não entra no caminho.
 * @param {string} _project
 * @param {string} macroId
 */
export function macroScopeFile(_project, macroId) {
  return path.join(resolveMacroScopesDir(), `${macroId}.md`);
}

/** Diretório `scopes/macro` (raiz do repo ou `AI_FACTORY_MACRO_DIR`). */
export function repoMacroScopesDir() {
  return resolveMacroScopesDir();
}

/**
 * Lista identificadores a partir de `scopes/macro/<id>.md` (nome do ficheiro sem `.md`).
 * O slug costuma coincidir com o projeto em `workspaces/<slug>/`.
 * @returns {string[]}
 */
export function listMacroScopeIds() {
  const dir = repoMacroScopesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => path.basename(d.name, ".md"))
    .filter((id) => isValidProjectSlug(id))
    .sort();
}

/**
 * Slugs para UI (dashboard): união de macros em `scopes/macro/*.md` e workspaces com app/backlog.
 * @returns {string[]}
 */
export function listDashboardProjectSlugs() {
  const fromMacros = listMacroScopeIds();
  const fromWorkspaces = listWorkspaceProjects();
  return [...new Set([...fromMacros, ...fromWorkspaces])].sort();
}

/**
 * @param {string} project
 * @param {string} macroId
 */
export function microScopeFile(project, macroId) {
  return path.join(workspaceRoot(project), "scopes", "micro", `${macroId}.micro.json`);
}

/**
 * Caminho relativo à raiz do repo, com barras POSIX (para prompts e logs).
 * @param {string} absolutePath
 */
export function repoRelativePosix(absolutePath) {
  const rel = path.relative(repoRoot, absolutePath);
  return rel.split(path.sep).join("/");
}

/**
 * Prefixo para `npm test --prefix <...>` a partir da raiz do repo.
 * @param {string} project
 */
export function npmTestPrefix(project) {
  const ws = workspaceRoot(project);
  const rel = path.relative(repoRoot, ws);
  return rel.split(path.sep).join("/");
}

/**
 * Garante pastas usadas pelo pipeline de escopo dentro do workspace do projeto.
 * @param {string} project
 */
export function ensureScopePipelineDirs(project) {
  const root = workspaceRoot(project);
  [
    repoMacroScopesDir(),
    path.join(root, "agents"),
    path.join(root, "scopes", "micro"),
    path.join(root, "backlog"),
    path.join(root, "reports", "scopes"),
    path.join(root, "docs", "scopes"),
  ].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

/**
 * Lista slugs de projetos em `workspaces/` (diretório com package.json ou backlog).
 */
export function listWorkspaceProjects() {
  const workspacesDir = resolveWorkspacesDir();
  if (!fs.existsSync(workspacesDir)) return [];
  const names = fs.readdirSync(workspacesDir, { withFileTypes: true });
  return names
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      if (!isValidProjectSlug(name)) return false;
      const root = workspaceRoot(name);
      const hasPkg = fs.existsSync(path.join(root, "package.json"));
      const backlog = path.join(root, "backlog", `${name}.tasks.json`);
      const hasBacklog = fs.existsSync(backlog);
      return hasPkg || hasBacklog;
    })
    .sort();
}
