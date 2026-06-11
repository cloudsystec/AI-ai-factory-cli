import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, orchestratorImport } from "./repo-root.js";
import { createLogger } from "./logger.js";

const log = createLogger("job");
import { getDevelopSettingsFromBack } from "./back-client.js";
import { ensureTenantProjectReady } from "./ensure-tenant-project.js";

export { REPO_ROOT };

const CURSOR_AGENT_JOB_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
  "railway-publish",
]);

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 * @returns {Promise<{ exitCode: number, status: string }>}
 */
export async function runJobLocally(job, onLine) {
  if (job.kind === "provision") {
    return runProvisionJob(job, onLine);
  }
  if (job.kind === "git-migrate") {
    return runGitMigrateJob(job, onLine);
  }
  if (job.kind === "railway-publish") {
    const billingJobId = job.billingJobId || job.id;
    process.env.AI_FACTORY_JOB_ID = billingJobId;
    if (job.cursorApiKey) {
      process.env.CURSOR_API_KEY = job.cursorApiKey;
    }
    return runRailwayPublishJob(job, onLine);
  }

  const project = job.projectSlug;
  const needsMacro = new Set([
    "scope",
    "scope-tasks-only",
    "develop",
    "task",
    "tech-lead-review",
    "micro-integration-qa",
    "micro-release",
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

  if (
    job.kind === "tech-lead-review" ||
    job.kind === "micro-integration-qa" ||
    job.kind === "micro-release"
  ) {
    const mod = await orchestratorImport(
      job.kind === "tech-lead-review"
        ? "run-tech-lead-review.js"
        : job.kind === "micro-integration-qa"
          ? "run-micro-integration-qa.js"
          : "run-micro-release.js"
    );
    const exitCode = await mod.run(job, onLine);
    return {
      exitCode,
      status: exitCode === 0 ? "succeeded" : "failed",
    };
  }

  const { buildJobCommand } = await orchestratorImport("dashboard-job-runner.js");
  const macroId = job.macroId || project;
  const built = buildJobCommand(job.kind, project, macroId, job.taskId);

  const tenantRoot = process.env.AI_FACTORY_TENANT_ROOT;
  const billingSessionDir = tenantRoot
    ? path.join(tenantRoot, "billing-sessions")
    : undefined;

  if (CURSOR_AGENT_JOB_KINDS.has(job.kind) && !job.cursorApiKey) {
    throw new Error(
      "Chave Cursor do executor em falta (grave a API key no utilizador executor ou reconecte Play)."
    );
  }

  const env = { ...process.env };
  delete env.CURSOR_API_KEY;
  if (job.cursorApiKey) {
    env.CURSOR_API_KEY = job.cursorApiKey;
  }
  env.AI_FACTORY_WORKSPACES_DIR = process.env.AI_FACTORY_WORKSPACES_DIR;
  env.AI_FACTORY_MACRO_DIR = process.env.AI_FACTORY_MACRO_DIR;
  env.AI_FACTORY_GITHUB_TOKEN = job.githubInstallationToken || undefined;
  env.AI_FACTORY_GIT_REPO = job.git?.repoFullName || undefined;
  env.AI_FACTORY_TECH_LEAD_BRANCH = job.git?.techLeadBranch || "tech-lead";
  env.AI_FACTORY_JOB_ID = job.id;
  if (job.requestedByUserId) {
    env.AI_FACTORY_EXECUTOR_USER_ID = job.requestedByUserId;
  }
  if (billingSessionDir) {
    env.AI_FACTORY_BILLING_SESSION_DIR = billingSessionDir;
  }
  if (project && process.env.AI_FACTORY_WORKSPACES_DIR) {
    env.AI_FACTORY_ACTIVE_PROJECT = project;
    env.AI_FACTORY_AGENTS_DIR = path.join(
      process.env.AI_FACTORY_WORKSPACES_DIR,
      project,
      "agents"
    );
  }
  const resumeStep = job.payload?.resumeFromStep || job.payload?.retryFromStep;
  if (resumeStep) {
    env.AI_FACTORY_RESUME_STEP = resumeStep;
  }
  if (job.payload?.retryMode) {
    env.AI_FACTORY_RETRY_MODE = job.payload.retryMode;
  }
  if (job.payload?.failedStep) {
    env.AI_FACTORY_FAILED_STEP = job.payload.failedStep;
  }
  if (job.kind === "scope-tasks-only" && job.payload?.microId) {
    env.AI_FACTORY_TARGET_MICRO_ID = String(job.payload.microId);
  }
  if (job.payload?.copilotInstructions) {
    env.AI_FACTORY_COPILOT_INSTRUCTIONS = String(job.payload.copilotInstructions);
  }
  if (job.payload?.replaceMicroTasks === true) {
    env.AI_FACTORY_REPLACE_MICRO_TASKS = "1";
  }

  return new Promise((resolve, reject) => {
    log.info("Executar comando", { command: built.command });
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
  const {
    provisionProjectGit,
    exportExistingCodeTree,
    pushImportedCodeTree,
  } = await orchestratorImport("git/provision-repo.js");
  const { realignOpenTaskWorkspaces } = await orchestratorImport(
    "git/task-workspace.js"
  );
  const { workspaceRoot } = await orchestratorImport("project-paths.js");
  const { notifyProvisionComplete } = await import("./back-client.js");
  const payload = job.payload || {};
  const slug = payload.slug || job.projectSlug;
  const name = payload.name || slug;
  const scope = payload.scope || "";
  const git = payload.git || null;
  onLine(`Provisionando projeto ${slug}…\n`);
  try {
    const created = ensureProjectFiles({ name, slug, scope });
    onLine(`Projeto criado: ${created.project}\n`);
    if (git?.repoFullName) {
      const ws = workspaceRoot(slug);
      const cacheDir = path.join(ws, ".git-cache");
      const sourceTree = path.join(ws, ".git-provision-source");
      /** @type {string|null} */
      let exportedBranch = null;

      if (git.resetGitCache && fs.existsSync(cacheDir)) {
        onLine("[git] exportar código existente antes de trocar repositório…\n");
        exportedBranch = exportExistingCodeTree(cacheDir, sourceTree, {
          techLeadBranch: git.techLeadBranch || "tech-lead",
          defaultBranch: git.defaultBranch || "main",
        });
        if (exportedBranch) {
          onLine(`[git] código exportado da branch ${exportedBranch}\n`);
        } else {
          onLine("[git] cache sem branches — nada para exportar\n");
          if (fs.existsSync(sourceTree)) {
            fs.rmSync(sourceTree, { recursive: true, force: true });
          }
        }
      }

      if (git.resetGitCache && fs.existsSync(cacheDir)) {
        onLine(`[git] limpar .git-cache (troca de repositório)…\n`);
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }

      provisionProjectGit(
        slug,
        {
          repoFullName: git.repoFullName,
          defaultBranch: git.defaultBranch || "main",
          techLeadBranch: git.techLeadBranch || "tech-lead",
          token: job.githubInstallationToken,
        },
        onLine
      );

      if (exportedBranch && fs.existsSync(sourceTree)) {
        pushImportedCodeTree(
          slug,
          {
            repoFullName: git.repoFullName,
            defaultBranch: git.defaultBranch || "main",
            techLeadBranch: git.techLeadBranch || "tech-lead",
            token: job.githubInstallationToken,
          },
          sourceTree,
          onLine
        );
        fs.rmSync(sourceTree, { recursive: true, force: true });
        realignOpenTaskWorkspaces(
          slug,
          {
            techLeadBranch: git.techLeadBranch || "tech-lead",
            token: job.githubInstallationToken,
          },
          onLine
        );
      }

      await notifyProvisionComplete(slug, { status: "ready" });
    }
    return { exitCode: 0, status: "succeeded" };
  } catch (e) {
    onLine(`Erro: ${e.message}\n`);
    try {
      await notifyProvisionComplete(slug, {
        status: "failed",
        error: e.message,
      });
    } catch {
      /* ignore */
    }
    return { exitCode: 1, status: "failed" };
  }
}

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
async function runRailwayPublishJob(job, onLine) {
  const { run } = await orchestratorImport("run-railway-publish.js");
  const slug = job.projectSlug;
  try {
    const exitCode = await run(job, onLine);
    return {
      exitCode,
      status: exitCode === 0 ? "succeeded" : "failed",
    };
  } catch (e) {
    onLine(`Erro interno: ${e.message}\n`);
    const { notifyRailwayPublishOutcome } = await import("./back-client.js");
    await notifyRailwayPublishOutcome(slug, {
      status: "failed",
      error:
        "Não foi possível publicar a aplicação automaticamente. Tente novamente.",
    }).catch(() => {});
    return { exitCode: 1, status: "failed" };
  }
}

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
async function runGitMigrateJob(job, onLine) {
  const { migrateToClientRepo } = await orchestratorImport(
    "git/migrate-to-client-repo.js"
  );
  const { notifyMigrateComplete } = await import("./back-client.js");
  const payload =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload || {};
  const slug = payload.slug || job.projectSlug;
  onLine(`Migrando Git do projeto ${slug}…\n`);
  try {
    await migrateToClientRepo(
      slug,
      {
        token: job.githubInstallationToken,
        managedRepoFullName: payload.managedRepoFullName,
        repoFullName: payload.repoFullName || job.git?.repoFullName,
        defaultBranch: payload.defaultBranch || job.git?.defaultBranch || "main",
        techLeadBranch:
          payload.techLeadBranch || job.git?.techLeadBranch || "tech-lead",
        sourceTechLead: payload.sourceTechLead || "tech-lead",
      },
      onLine
    );
    await notifyMigrateComplete(slug, { status: "ready" });
    return { exitCode: 0, status: "succeeded" };
  } catch (e) {
    onLine(`Erro: ${e.message}\n`);
    try {
      await notifyMigrateComplete(slug, {
        status: "failed",
        error: e.message,
      });
    } catch {
      /* ignore */
    }
    return { exitCode: 1, status: "failed" };
  }
}
