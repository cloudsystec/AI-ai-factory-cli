import fs from "node:fs";
import path from "node:path";
import {
  activeProjectSlug,
  backlogFile,
  taskStateFile,
  tenantRoot,
  workspaceRoot,
  repoMacroScopesDir,
  isValidProjectSlug,
} from "./project-paths.js";

const MAX_SECTION_CHARS = 12_000;
const MAX_TREE_ENTRIES = 80;
const MAX_SESSION_MESSAGES = 8;

/**
 * @param {string} filePath
 * @param {number} [max]
 */
function readTruncated(filePath, max = MAX_SECTION_CHARS) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf-8");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncado ${text.length - max} chars]`;
}

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @param {number} [depth]
 */
function summarizeTree(dir, prefix = "", depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  /** @type {string[]} */
  const lines = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
    if (ent.name === "node_modules") continue;
    lines.push(`${prefix}${ent.name}${ent.isDirectory() ? "/" : ""}`);
    if (lines.length >= MAX_TREE_ENTRIES) break;
    if (ent.isDirectory() && depth < 2) {
      lines.push(
        ...summarizeTree(path.join(dir, ent.name), `${prefix}  `, depth + 1)
      );
    }
  }
  return lines.slice(0, MAX_TREE_ENTRIES);
}

/**
 * @param {string} project
 */
function readMicroScopes(project) {
  const microDir = path.join(workspaceRoot(project), "scopes", "micro");
  if (!fs.existsSync(microDir)) return null;
  const files = fs
    .readdirSync(microDir)
    .filter((f) => f.endsWith(".json"))
    .slice(0, 5);
  return files
    .map((f) => {
      const content = readTruncated(path.join(microDir, f), 4000);
      return content ? `### ${f}\n${content}` : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {string} project
 */
function readRecentReports(project) {
  const reportsDir = path.join(workspaceRoot(project), "reports", "tasks");
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .slice(-3);
  return files
    .map((f) => {
      const content = readTruncated(path.join(reportsDir, f), 3000);
      return content ? `### reports/tasks/${f}\n${content}` : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {string} jobId
 * @param {string} project
 */
function sessionFile(jobId, project) {
  const root = tenantRoot();
  return path.join(root, "luna-sessions", project, `${jobId}.json`);
}

/**
 * @param {string} jobId
 * @param {string} project
 * @param {object} data
 */
export function saveLunaSession(jobId, project, data) {
  if (!jobId || !project) return;
  const file = sessionFile(jobId, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * @param {string} jobId
 * @param {string} project
 */
function loadLunaSession(jobId, project) {
  const file = sessionFile(jobId, project);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   prompt: string,
 *   meta?: { project?: string, task?: string, step?: string, jobKind?: string },
 * }} opts
 */
export function buildLunaContextPack(opts) {
  const project =
    opts.meta?.project || activeProjectSlug() || process.env.AI_FACTORY_ACTIVE_PROJECT || "";
  const jobId = process.env.AI_FACTORY_JOB_ID || "";
  /** @type {string[]} */
  const sections = [];

  if (project && isValidProjectSlug(project)) {
    const ws = workspaceRoot(project);
    const tree = summarizeTree(ws);
    if (tree.length) {
      sections.push(`## Árvore workspace (${project})\n${tree.join("\n")}`);
    }

    const taskState = readTruncated(taskStateFile(project), 8000);
    if (taskState) sections.push(`## tasks-state.json\n${taskState}`);

    const backlog = readTruncated(backlogFile(project), 8000);
    if (backlog) sections.push(`## backlog\n${backlog}`);

    const macroDir = repoMacroScopesDir();
    const macroPath = path.join(macroDir, `${project}.md`);
    const macro = readTruncated(macroPath, 6000);
    if (macro) sections.push(`## macro scope\n${macro}`);

    const micros = readMicroScopes(project);
    if (micros) sections.push(`## micro scopes\n${micros}`);

    const reports = readRecentReports(project);
    if (reports) sections.push(`## relatórios recentes\n${reports}`);

    const session = loadLunaSession(jobId, project);
    if (session?.summary) {
      sections.push(`## memória sessão\n${session.summary}`);
    }
    if (Array.isArray(session?.messages) && session.messages.length) {
      const recent = session.messages.slice(-MAX_SESSION_MESSAGES);
      sections.push(
        `## mensagens recentes\n${recent.map((m) => `[${m.role}] ${String(m.content).slice(0, 500)}`).join("\n")}`
      );
    }
  }

  if (opts.meta?.task) {
    sections.push(`## task activa\n${opts.meta.task}`);
  }

  const contextBlock =
    sections.length > 0
      ? `\n\n---\n# Context pack Luna\n${sections.join("\n\n")}\n---\n\n`
      : "";

  return `${contextBlock}${opts.prompt}`;
}

/**
 * @param {string} jobId
 * @param {string} project
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} [summary]
 */
export function updateLunaSessionMemory(jobId, project, messages, summary) {
  saveLunaSession(jobId, project, {
    updatedAt: new Date().toISOString(),
    summary: summary || null,
    messages: messages.slice(-MAX_SESSION_MESSAGES),
  });
}
