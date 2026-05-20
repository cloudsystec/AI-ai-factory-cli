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
 * @param {string} project
 * @param {object} backlogTask
 */
function backlogRowToDashboard(project, backlogTask) {
  return {
    id: backlogTask.id,
    title: backlogTask.title ?? backlogTask.id,
    project: backlogTask.project ?? project,
    status: "todo",
    currentAgent: null,
    updatedAt: backlogTask.updatedAt ?? null,
    backlogReady: true,
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

  let backlogReady = [];
  const backlogPath = backlogFile(project);
  if (fs.existsSync(backlogPath)) {
    const doc = readBacklogFile(backlogPath, { project });
    backlogReady = doc.tasks
      .filter((t) => isBacklogTodoApproved(t) && !runtimeIds.has(t.id))
      .map((t) => backlogRowToDashboard(project, t));
  }

  return [...runtime, ...backlogReady];
}
