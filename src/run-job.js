import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT, orchestratorImport } from "./repo-root.js";
import { getDevelopSettingsFromBack } from "./back-client.js";
import { ensureTenantProjectReady } from "./ensure-tenant-project.js";

export { REPO_ROOT };

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 * @returns {Promise<{ exitCode: number, status: string }>}
 */
export async function runJobLocally(job, onLine) {
  if (job.kind === "provision") {
    return runProvisionJob(job, onLine);
  }

  const project = job.projectSlug;
  const needsMacro = new Set([
    "scope",
    "scope-tasks-only",
    "develop",
    "task",
  ]).has(job.kind);

  if (needsMacro && project) {
    await ensureTenantProjectReady(project, onLine);
  }

  if (job.kind === "develop" && project) {
    try {
      const { writeDevelopSettings } = await orchestratorImport(
        "develop-settings.js"
      );
      const remote = await getDevelopSettingsFromBack(project);
      writeDevelopSettings(project, remote);
    } catch (e) {
      onLine(`[warn] develop-settings do back: ${e.message}\n`);
    }
  }

  const { buildJobCommand } = await orchestratorImport("dashboard-job-runner.js");
  const macroId = job.macroId || project;
  const built = buildJobCommand(job.kind, project, macroId, job.taskId);

  const env = {
    ...process.env,
    AI_FACTORY_WORKSPACES_DIR: process.env.AI_FACTORY_WORKSPACES_DIR,
    AI_FACTORY_MACRO_DIR: process.env.AI_FACTORY_MACRO_DIR,
    CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  };

  return new Promise((resolve, reject) => {
    onLine(`$ ${built.command}\n`);

    const child = spawn(built.executable, built.argv, {
      cwd: REPO_ROOT,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onChunk = () => (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine(line);
      }
    };

    child.stdout?.on("data", onChunk());
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine(`[stderr] ${line}`);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        exitCode,
        status: exitCode === 0 ? "succeeded" : "failed",
      });
    });
  });
}

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
async function runProvisionJob(job, onLine) {
  const { ensureProjectFiles } = await orchestratorImport("create-project.js");
  const payload = job.payload || {};
  const slug = payload.slug || job.projectSlug;
  const name = payload.name || slug;
  const scope = payload.scope || "";
  onLine(`Provisionando projeto ${slug}…\n`);
  try {
    const created = ensureProjectFiles({ name, slug, scope });
    onLine(`Projeto criado: ${created.project}\n`);
    return { exitCode: 0, status: "succeeded" };
  } catch (e) {
    onLine(`Erro: ${e.message}\n`);
    return { exitCode: 1, status: "failed" };
  }
}
