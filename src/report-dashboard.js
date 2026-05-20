import fs from "node:fs";
import { orchestratorImport } from "./repo-root.js";
import {
  putDevelopSettings,
  putProjectDashboard,
  putTaskDetail,
} from "./back-client.js";

/**
 * Sincroniza snapshot do dashboard e develop-settings para o BACK (Postgres).
 * @param {string} projectSlug
 * @param {{ taskId?: string }} [opts]
 */
export async function reportProjectDashboard(projectSlug, opts = {}) {
  const { isValidProjectSlug, taskStateFile } = await orchestratorImport(
    "project-paths.js"
  );
  if (!projectSlug || !isValidProjectSlug(projectSlug)) return;

  const { buildDashboardTasks } = await orchestratorImport(
    "task-dashboard-tasks.js"
  );
  const { getScopeDashboardState } = await orchestratorImport(
    "scope-dashboard-state.js"
  );
  const { readDevelopSettings } = await orchestratorImport("develop-settings.js");

  const tasks = buildDashboardTasks(projectSlug);

  let tasksState = [];
  const statePath = taskStateFile(projectSlug);
  try {
    if (fs.existsSync(statePath)) {
      tasksState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!Array.isArray(tasksState)) tasksState = [];
    }
  } catch {
    tasksState = [];
  }

  const scopeState = getScopeDashboardState(projectSlug, { tasksState });
  await putProjectDashboard(projectSlug, { tasks, scopeState });

  const develop = readDevelopSettings(projectSlug);
  await putDevelopSettings(projectSlug, develop);

  if (opts.taskId) {
    const { buildTaskDetail } = await orchestratorImport(
      "task-dashboard-detail.js"
    );
    const detail = buildTaskDetail(projectSlug, String(opts.taskId).trim());
    if (detail) {
      await putTaskDetail(projectSlug, opts.taskId, detail);
    }
  }
}
