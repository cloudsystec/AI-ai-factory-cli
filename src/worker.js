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

const WORKER_ID = process.env.WORKER_ID || `cli-${TENANT_ID.slice(0, 8)}`;
const POLL_MS = Number(process.env.CLAIM_POLL_MS || 3000);
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
  console.log(`Agentes sincronizados para ${projectSlug}: ${n} ficheiros`);
}

/**
 * @param {string} jobId
 * @param {{ status: string, exitCode?: number, startedMs: number, finishedMs: number }} opts
 */
async function finishJobWithBilling(jobId, opts) {
  const sessionTotals = readJobBillingTotal(jobId);
  let billing;

  if (sessionTotals.roundCount > 0) {
    billing = {
      costBaseUsd: Math.max(0.01, sessionTotals.totalCostBaseUsd),
      source: "round_settlement",
      detail: {
        roundCount: sessionTotals.roundCount,
      },
    };
  } else {
    billing = await resolveJobCostBaseUsd({
      startedMs: opts.startedMs,
      finishedMs: opts.finishedMs,
    });
  }

  await completeJob(jobId, {
    status: opts.status,
    exitCode: opts.exitCode,
    costBaseUsd: billing.costBaseUsd,
  });

  const d = billing.detail ?? {};
  let extra;
  if (billing.source === "round_settlement") {
    extra = ` | rodadas=${d.roundCount ?? 0}`;
  } else if (billing.source === "cursor_admin_api") {
    extra = ` | eventos=${d.eventCount ?? 0} tokens_in=${d.tokensIn ?? 0} tokens_out=${d.tokensOut ?? 0}`;
  } else {
    extra = ` | ${d.reason ?? "estimate"}`;
  }

  await appendJobLogLine(
    jobId,
    `[billing] CB=$${billing.costBaseUsd.toFixed(4)} (${billing.source})${extra}`
  ).catch(() => {});

  return billing;
}

async function processOneJob(job) {
  running = true;
  const jobStartedMs = Date.now();
  const projectSlug =
    job.projectSlug ||
    (job.kind === "provision" ? job.payload?.slug : null);

  /** @type {ReturnType<typeof setInterval>|null} */
  let dashboardTimer = null;

  try {
    if (projectSlug) {
      await syncAgentsForProject(projectSlug);
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
      }).catch((e) => console.warn("dashboard sync (start):", e.message));

      dashboardTimer = setInterval(() => {
        syncDashboardForJob(projectSlug, {
          taskId: job.taskId || undefined,
          jobId: job.id,
        }).catch((e) => console.warn("dashboard sync (interval):", e.message));
      }, DASHBOARD_SYNC_MS);
    }

    let result;
    try {
      result = await runJobLocally(job, (line) => {
        appendJobLogLine(job.id, line).catch((e) =>
          console.error("log failed", e.message)
        );
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
    await publishJobLogEvent(job.id, {
      type: "exit",
      code: result.exitCode ?? null,
      signal: null,
    });
    await finishJobWithBilling(job.id, {
      status: result.status,
      exitCode: result.exitCode,
      startedMs: jobStartedMs,
      finishedMs,
    });
    await appendJobLogLine(job.id, `Job finalizado: ${result.status}`);
  } catch (e) {
    console.error(e);
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
      });
    } catch (e2) {
      console.error("complete failed", e2);
    }
  } finally {
    if (dashboardTimer) {
      clearInterval(dashboardTimer);
    }
    if (projectSlug) {
      await syncDashboardForJob(projectSlug, {
        taskId: job.taskId || undefined,
        jobId: job.id,
      }).catch((e) => console.warn("dashboard sync (finally):", e.message));
    }
    running = false;
  }
}

async function loop() {
  if (running) return;
  try {
    const job = await claimJob(WORKER_ID);
    if (job) {
      console.log("claimed", job.id, job.kind, job.projectSlug);
      await processOneJob(job);
    }
  } catch (e) {
    console.error("claim error", e.message);
  }
}

async function main() {
  requireEnv("REDIS_URL");
  console.log("CLI worker", {
    TENANT_ID,
    BACK_URL: process.env.BACK_URL,
    REDIS_URL: process.env.REDIS_URL,
    REPO_ROOT,
  });
  await registerWorker(WORKER_ID);
  setInterval(() => heartbeat().catch(() => {}), 30_000);
  setInterval(loop, POLL_MS);
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
