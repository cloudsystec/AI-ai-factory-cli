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
 * @param {{ taskId?: string, jobId?: string, publishDashboardEvent?: (jobId: string) => Promise<void> }} [opts]
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

  const { buildTaskDetail } = await orchestratorImport(
    "task-dashboard-detail.js"
  );

  const detailIds = new Set(
    tasks.map((t) => (t && typeof t.id === "string" ? t.id : null)).filter(Boolean)
  );
  if (opts.taskId) {
    detailIds.add(String(opts.taskId).trim());
  }

  for (const id of detailIds) {
    const detail = buildTaskDetail(projectSlug, id);
    if (detail) {
      await putTaskDetail(projectSlug, id, detail);
    }
  }

  if (opts.jobId && opts.publishDashboardEvent) {
    await opts.publishDashboardEvent(opts.jobId);
  }
}
