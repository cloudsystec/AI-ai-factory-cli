import fs from "node:fs";
import path from "node:path";
import {
  backlogFile,
  isValidProjectSlug,
  repoRelativePosix,
  taskStateFile,
  workspaceRoot,
} from "./project-paths.js";
import { readBacklogFile } from "./backlog-io.js";
import { buildPipelineSummary } from "./task-pipeline-state.js";
import { isMicroCloserTask } from "./micro-task-utils.js";
import { microQaVerdictFile } from "./qa-verdict.js";

const PREVIEW_MAX_CHARS = 2000;
const EVIDENCE_TAIL_LINES = 80;

/**
 * Normaliza campos de backlog para string (Markdown / API).
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeBacklogTextField(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => (typeof item === "string" ? item.trim() : String(item)))
      .filter(Boolean);
    return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : null;
  }
  return String(value);
}

/**
 * @param {string} taskId
 */
export function isValidTaskId(taskId) {
  return typeof taskId === "string" && /^[a-zA-Z0-9_-]+$/.test(taskId);
}

/**
 * @param {string} filePath
 * @param {number} maxChars
 */
function readTextPreview(filePath, maxChars = PREVIEW_MAX_CHARS) {
  const text = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n… (pré-visualização truncada)`;
}

/**
 * @param {string} filePath
 * @param {number} tailLines
 */
function readTailPreview(filePath, tailLines = EVIDENCE_TAIL_LINES) {
  const text = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines.length <= tailLines) return text;
  return `… (${lines.length - tailLines} linhas omitidas)\n\n${lines.slice(-tailLines).join("\n")}`;
}

/**
 * @param {string} wsRoot
 * @param {string} taskId
 */
function loadRuntimeState(project, taskId) {
  const statePath = taskStateFile(project);
  if (!fs.existsSync(statePath)) return null;
  const state = JSON.parse(fs.readFileSync(statePath, "utf-8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(state)) return null;
  const entry = state.find((t) => t.id === taskId);
  return entry ?? null;
}

/**
 * @param {string} wsRoot
 * @param {string} taskId
 */
function collectArtifacts(wsRoot, taskId, meta = {}) {
  const artifacts = [];

  const docRel = `docs/tasks/${taskId}.md`;
  const docAbs = path.join(wsRoot, docRel);
  const docEntry = {
    kind: "doc",
    label: "Documentação da task",
    path: repoRelativePosix(docAbs),
    exists: fs.existsSync(docAbs),
  };
  if (docEntry.exists) {
    docEntry.preview = readTextPreview(docAbs);
  }
  artifacts.push(docEntry);

  const reports = [
    { suffix: "planner", label: "Relatório Planner" },
    { suffix: "dev", label: "Relatório Dev" },
    { suffix: "qa", label: "Relatório QA" },
    { suffix: "reviewer", label: "Relatório Reviewer" },
  ];

  for (const { suffix, label } of reports) {
    const rel = `reports/tasks/${taskId}-${suffix}.md`;
    const abs = path.join(wsRoot, rel);
    const entry = {
      kind: "report",
      label,
      path: repoRelativePosix(abs),
      exists: fs.existsSync(abs),
    };
    if (entry.exists) {
      entry.preview = readTextPreview(abs);
    }
    artifacts.push(entry);
  }

  const verdictRel = `reports/tasks/${taskId}-qa-verdict.json`;
  const verdictAbs = path.join(wsRoot, verdictRel);
  const verdictEntry = {
    kind: "qaVerdict",
    label: "Veredito QA (JSON)",
    path: repoRelativePosix(verdictAbs),
    exists: fs.existsSync(verdictAbs),
  };
  if (verdictEntry.exists) {
    try {
      const raw = JSON.parse(fs.readFileSync(verdictAbs, "utf-8").replace(/^\uFEFF/, ""));
      verdictEntry.verdict = raw.verdict ?? null;
      verdictEntry.summary = raw.summary ?? "";
    } catch {
      verdictEntry.parseError = true;
    }
  }
  artifacts.push(verdictEntry);

  if (meta.isMicroCloser && meta.sourceMicroId) {
    const microVerdictRel = repoRelativePosix(
      microQaVerdictFile(wsRoot, meta.sourceMicroId)
    );
    const microVerdictAbs = path.join(wsRoot, microVerdictRel);
    const microVerdictEntry = {
      kind: "microQaVerdict",
      label: "Veredito QA do micro (JSON)",
      path: microVerdictRel,
      exists: fs.existsSync(microVerdictAbs),
    };
    if (microVerdictEntry.exists) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(microVerdictAbs, "utf-8").replace(/^\uFEFF/, "")
        );
        microVerdictEntry.verdict = raw.verdict ?? null;
        microVerdictEntry.summary = raw.summary ?? "";
      } catch {
        microVerdictEntry.parseError = true;
      }
    }
    artifacts.push(microVerdictEntry);
  }

  const evidenceRel = `evidence/tests/${taskId}-test-output.txt`;
  const evidenceAbs = path.join(wsRoot, evidenceRel);
  const evidenceEntry = {
    kind: "testEvidence",
    label: "Evidência de testes",
    path: repoRelativePosix(evidenceAbs),
    exists: fs.existsSync(evidenceAbs),
  };
  if (evidenceEntry.exists) {
    evidenceEntry.preview = readTailPreview(evidenceAbs);
  }
  artifacts.push(evidenceEntry);

  return artifacts;
}

/**
 * @param {string} project
 * @param {string} taskId
 */
export function buildTaskDetail(project, taskId) {
  if (!isValidProjectSlug(project)) {
    throw new Error(`Slug de projeto inválido: ${project}`);
  }
  if (!isValidTaskId(taskId)) {
    throw new Error(`ID de task inválido: ${taskId}`);
  }

  const wsRoot = workspaceRoot(project);
  const backlogPath = backlogFile(project);
  const runtime = loadRuntimeState(project, taskId);

  let backlog = null;
  if (fs.existsSync(backlogPath)) {
    const doc = readBacklogFile(backlogPath, { project });
    const task = doc.tasks.find((t) => t.id === taskId);
    if (task) {
      backlog = {
        sourceMicroId: task.sourceMicroId ?? null,
        title: task.title ?? null,
        description: normalizeBacklogTextField(task.description),
        acceptance: normalizeBacklogTextField(task.acceptance),
        testStrategy: normalizeBacklogTextField(task.testStrategy),
        isMicroCloser: isMicroCloserTask(task),
        dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
        status: task.status ?? null,
        approved: task.approved ?? null,
        validationStatus: task.validationStatus ?? null,
        priority: task.priority ?? null,
        techLeadScore: task.techLeadScore ?? null,
        updatedAt: task.updatedAt ?? null,
      };
    }
  }

  if (!runtime && !backlog) {
    return null;
  }

  const pipeline = buildPipelineSummary(
    runtime
      ? { ...runtime, isMicroCloser: backlog?.isMicroCloser === true }
      : null
  );

  return {
    taskId,
    project,
    runtime: runtime
      ? {
          id: runtime.id,
          title: runtime.title,
          project: runtime.project,
          status: runtime.status,
          currentAgent: runtime.currentAgent ?? null,
          updatedAt: runtime.updatedAt ?? null,
        }
      : null,
    backlog,
    pipeline,
    artifacts: collectArtifacts(wsRoot, taskId, {
      isMicroCloser: backlog?.isMicroCloser === true,
      sourceMicroId: backlog?.sourceMicroId ?? null,
    }),
  };
}
