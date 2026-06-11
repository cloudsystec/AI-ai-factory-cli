import fs from "node:fs";
import {
  backlogFile,
  isValidProjectSlug,
  taskStateFile,
} from "./project-paths.js";
import { readBacklogFile } from "./backlog-io.js";

/**
 * Task do backlog pronta para a coluna «A fazer» do Kanban.
 * @param {{ status?: string, validationStatus?: string }} task
 */
export function isBacklogTodoApproved(task) {
  return task.status === "todo" && task.validationStatus === "approved";
}

/**
 * @param {string} project
 * @returns {object[]}
 */
function loadRuntimeTasks(project) {
  const statePath = taskStateFile(project);
  if (!fs.existsSync(statePath)) return [];

  const raw = JSON.parse(fs.readFileSync(statePath, "utf-8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => t && typeof t.id === "string");
}

/**
 * Task do backlog visível no Kanban (runtime prevalece quando existir).
 * @param {{ status?: string, validationStatus?: string }} task
 */
export function isBacklogKanbanVisible(task) {
  if (task.status === "in_progress") return true;
  return isBacklogTodoApproved(task);
}

/**
 * @param {string} project
 * @param {object} backlogTask
 */
function backlogRowToDashboard(project, backlogTask) {
  const status =
    backlogTask.status === "in_progress" ? "in_progress" : "todo";
  return {
    id: backlogTask.id,
    title: backlogTask.title ?? backlogTask.id,
    project: backlogTask.project ?? project,
    status,
    currentAgent: null,
    updatedAt: backlogTask.updatedAt ?? null,
    isMicroCloser: backlogTask.isMicroCloser === true,
    backlogReady: status === "todo",
    backlogInProgress: status === "in_progress",
  };
}

/**
 * Lista para o Kanban: `tasks-state.json` + tasks do backlog ainda não executadas
 * (`status` todo e `validationStatus` approved).
 *
 * @param {string} project
 */
export function buildDashboardTasks(project) {
  if (!isValidProjectSlug(project)) {
    throw new Error(`Slug de projeto inválido: ${project}`);
  }

  const runtime = loadRuntimeTasks(project);
  const runtimeIds = new Set(runtime.map((t) => t.id));

  let backlogById = new Map();
  let backlogReady = [];
  const backlogPath = backlogFile(project);
  if (fs.existsSync(backlogPath)) {
    const doc = readBacklogFile(backlogPath, { project });
    backlogById = new Map(doc.tasks.map((t) => [t.id, t]));
    backlogReady = doc.tasks
      .filter((t) => isBacklogKanbanVisible(t) && !runtimeIds.has(t.id))
      .map((t) => backlogRowToDashboard(project, t));
  }

  const enrichedRuntime = runtime.map((t) => ({
    ...t,
    isMicroCloser: backlogById.get(t.id)?.isMicroCloser === true,
  }));

  return [...enrichedRuntime, ...backlogReady];
}
