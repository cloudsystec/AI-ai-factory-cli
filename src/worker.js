import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "./repo-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot();

dotenv.config();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} obrigatório`);
  return v;
}

const TENANT_ID = requireEnv("TENANT_ID");
const tenantRoot = path.join(REPO_ROOT, "data", "tenants", TENANT_ID);
dotenv.config({
  path: path.join(tenantRoot, ".env"),
  override: false,
});
process.env.AI_FACTORY_TENANT_ROOT = tenantRoot;
process.env.AI_FACTORY_WORKSPACES_DIR = path.join(tenantRoot, "workspaces");
process.env.AI_FACTORY_MACRO_DIR = path.join(tenantRoot, "scopes", "macro");

const {
  claimJob,
  completeJob,
  heartbeat,
  registerWorker,
  updateJobBilling,
} = await import("./back-client.js");
const {
  appendJobLogLine,
  publishJobLogEvent,
  resetJobLog,
} = await import("./job-log-redis.js");
const { runJobLocally } = await import("./run-job.js");
const { reportProjectDashboard } = await import("./report-dashboard.js");
const { syncProjectAgentsToDisk } = await import("./sync-project-agents.js");
const { resolveJobCostBaseUsd } = await import("./resolve-job-cost.js");
const {
  readJobBillingTotal,
  clearBillingSession,
} = await import("./ai-call-billing.js");
const { createLogger, redactForClient } = await import("./logger.js");

const log = createLogger("worker");
const WORKER_ID = process.env.WORKER_ID || `cli-${TENANT_ID.slice(0, 8)}`;
const POLL_MS = Number(process.env.CLAIM_POLL_MS || 1000);
const DASHBOARD_SYNC_MS = Number(process.env.DASHBOARD_SYNC_MS || 5000);

let running = false;

/**
 * @param {string} projectSlug
 * @param {{ taskId?: string, jobId?: string }} [opts]
 */
async function syncDashboardForJob(projectSlug, opts = {}) {
  await reportProjectDashboard(projectSlug, {
    taskId: opts.taskId,
    jobId: opts.jobId,
    publishDashboardEvent: (jobId) =>
      publishJobLogEvent(jobId, { type: "dashboard" }),
  });
}

/**
 * @param {string} projectSlug
 */
async function syncAgentsForProject(projectSlug) {
  if (!projectSlug) return;
  const n = await syncProjectAgentsToDisk(tenantRoot, projectSlug);
  log.info("Agentes sincronizados", { project: projectSlug, files: n });
}

const BILLING_SETTLE_DELAY_MS = Number(process.env.BILLING_SETTLE_DELAY_MS || 20_000);

/**
 * @param {string} jobId
 * @param {{ status: string, exitCode?: number, startedMs: number, finishedMs: number, billingEmail?: string }} opts
 */
async function finishJobWithBilling(jobId, opts) {
  const sessionTotals = readJobBillingTotal(jobId);

  if (sessionTotals.callCount > 0) {
    await completeJob(jobId, {
      status: opts.status,
      exitCode: opts.exitCode,
      costBaseUsd: sessionTotals.totalCostBaseUsd,
    });
    log.debug("Billing registado (round_settlement)", {
      jobId,
      costBaseUsd: sessionTotals.totalCostBaseUsd.toFixed(4),
    });
    return;
  }

  await completeJob(jobId, {
    status: opts.status,
    exitCode: opts.exitCode,
    costBaseUsd: 0,
  });

  settleBillingInBackground(jobId, opts);
}

/**
 * Aguarda o delay e depois resolve o custo real via Cursor Admin API,
 * atualizando apenas o billing do job sem bloquear o worker.
 */
function settleBillingInBackground(jobId, opts) {
  log.debug("Billing background agendado", { jobId, delayMs: BILLING_SETTLE_DELAY_MS });
  setTimeout(async () => {
    log.debug("Billing background: iniciando resolução", { jobId });
    const resolveStart = Date.now();
    try {
      const billing = await resolveJobCostBaseUsd({
        startedMs: opts.startedMs,
        finishedMs: opts.finishedMs,
        email: opts.billingEmail,
      });
      const resolveMs = Date.now() - resolveStart;
      if (billing.costBaseUsd > 0) {
        await updateJobBilling(jobId, {
          costBaseUsd: billing.costBaseUsd,
        });
        log.info("Billing atualizado (background)", {
          jobId,
          costBaseUsd: billing.costBaseUsd.toFixed(4),
          source: billing.source,
          resolveMs,
        });
      } else {
        log.debug("Billing background: custo zero, sem atualização", { jobId, source: billing.source, resolveMs });
      }
    } catch (e) {
      log.warn("Billing background falhou", {
        jobId,
        error: e instanceof Error ? e.message : String(e),
        resolveMs: Date.now() - resolveStart,
      });
    }
  }, BILLING_SETTLE_DELAY_MS);
}

async function processOneJob(job) {
  running = true;
  const jobStartedMs = Date.now();
  const projectSlug =
    job.projectSlug ||
    (job.kind === "provision" ? job.payload?.slug : null);

  log.debug("Job processamento iniciado", {
    jobId: job.id,
    kind: job.kind,
    project: projectSlug || "—",
    task: job.taskId || "—",
    executor: job.requestedByEmail || "—",
  });

  const prevUsageEmail = process.env.CURSOR_USAGE_EMAIL;
  if (job.requestedByEmail) {
    process.env.CURSOR_USAGE_EMAIL = job.requestedByEmail;
  }

  /** @type {ReturnType<typeof setInterval>|null} */
  let dashboardTimer = null;

  try {
    if (projectSlug) {
      const syncStart = Date.now();
      await syncAgentsForProject(projectSlug);
      log.debug("Agentes sincronizados", { project: projectSlug, elapsedMs: Date.now() - syncStart });
    }

    await resetJobLog(job.id);
    clearBillingSession(job.id);
    await appendJobLogLine(
      job.id,
      `Worker ${WORKER_ID} iniciou job ${job.kind}`
    );

    const prevProject = process.env.AI_FACTORY_ACTIVE_PROJECT;
    if (projectSlug) {
      process.env.AI_FACTORY_ACTIVE_PROJECT = projectSlug;
      process.env.AI_FACTORY_AGENTS_DIR = path.join(
        tenantRoot,
        "workspaces",
        projectSlug,
        "agents"
      );
      await syncDashboardForJob(projectSlug, {
        taskId: job.taskId || undefined,
        jobId: job.id,
      }).catch((e) => log.warn("Dashboard sync (início)", { error: e.message }));

      dashboardTimer = setInterval(() => {
        syncDashboardForJob(projectSlug, {
          taskId: job.taskId || undefined,
          jobId: job.id,
        }).catch((e) => log.warn("Dashboard sync", { error: e.message }));
      }, DASHBOARD_SYNC_MS);
    }

    log.debug("Executando job localmente", { jobId: job.id, kind: job.kind });
    const jobExecStart = Date.now();

    let result;
    try {
      result = await runJobLocally(job, (line) => {
        const plain = log.jobLine(line);
        if (plain) {
          const safe = redactForClient(plain);
          if (safe) {
            appendJobLogLine(job.id, safe).catch((e) =>
              log.error("Falha ao gravar log no Redis", { error: e.message })
            );
          }
        }
      });
    } finally {
      if (dashboardTimer) {
        clearInterval(dashboardTimer);
        dashboardTimer = null;
      }
      if (projectSlug) {
        if (prevProject !== undefined) {
          process.env.AI_FACTORY_ACTIVE_PROJECT = prevProject;
        } else {
          delete process.env.AI_FACTORY_ACTIVE_PROJECT;
        }
        delete process.env.AI_FACTORY_AGENTS_DIR;
      }
    }

    const finishedMs = Date.now();
    const jobExecElapsed = finishedMs - jobExecStart;
    log.debug("Job execução concluída", {
      jobId: job.id,
      status: result.status,
      exitCode: result.exitCode,
      execMs: jobExecElapsed,
      execSec: `${(jobExecElapsed / 1000).toFixed(1)}s`,
    });

    await publishJobLogEvent(job.id, {
      type: "exit",
      code: result.exitCode ?? null,
      signal: null,
    });
    log.debug("Finalizando billing", { jobId: job.id });
    await finishJobWithBilling(job.id, {
      status: result.status,
      exitCode: result.exitCode,
      startedMs: jobStartedMs,
      finishedMs,
      billingEmail: job.requestedByEmail,
    });
    const durationSec = ((Date.now() - jobStartedMs) / 1000).toFixed(1);
    log.info("Job concluído", {
      jobId: job.id,
      status: result.status,
      exitCode: result.exitCode,
      durationSec,
    });
    await appendJobLogLine(
      job.id,
      `Job finalizado: ${result.status} (${durationSec}s)\n`
    );
  } catch (e) {
    log.error(e?.message || String(e), { jobId: job.id });
    try {
      const finishedMs = Date.now();
      await publishJobLogEvent(job.id, {
        type: "exit",
        code: 1,
        signal: null,
      });
      await finishJobWithBilling(job.id, {
        status: "failed",
        exitCode: 1,
        startedMs: jobStartedMs,
        finishedMs,
        billingEmail: job.requestedByEmail,
      });
    } catch (e2) {
      log.error("Falha ao completar job", { error: e2.message });
    }
  } finally {
    if (dashboardTimer) {
      clearInterval(dashboardTimer);
    }
    if (projectSlug) {
      await syncDashboardForJob(projectSlug, {
        taskId: job.taskId || undefined,
        jobId: job.id,
      }).catch((e) => log.warn("Dashboard sync (fim)", { error: e.message }));
    }
    if (job.requestedByEmail) {
      if (prevUsageEmail !== undefined) {
        process.env.CURSOR_USAGE_EMAIL = prevUsageEmail;
      } else {
        delete process.env.CURSOR_USAGE_EMAIL;
      }
    }
    running = false;
    setImmediate(loop);
  }
}

async function loop() {
  if (running) return;
  try {
    const claimStart = Date.now();
    const job = await claimJob(WORKER_ID);
    if (job) {
      log.info("Job claimed", {
        jobId: job.id,
        kind: job.kind,
        project: job.projectSlug,
        task: job.taskId || "—",
        executor: job.requestedByEmail || job.requestedByUserId || "—",
        claimMs: Date.now() - claimStart,
      });
      await processOneJob(job);
    }
  } catch (e) {
    log.error("Claim falhou", { error: e.message });
  }
}

async function main() {
  requireEnv("REDIS_URL");
  log.info("AI Factory CLI worker a iniciar", {
    tenant: TENANT_ID.slice(0, 8) + "…",
    workerId: WORKER_ID,
    back: process.env.BACK_URL,
    color: process.env.AI_FACTORY_LOG_COLOR !== "0",
  });
  await registerWorker(WORKER_ID);
  setInterval(() => heartbeat().catch(() => {}), 30_000);
  setInterval(loop, POLL_MS);
  await loop();
}

main().catch((e) => {
  log.error("Worker terminou com erro", { error: e.message });
  process.exit(1);
});
