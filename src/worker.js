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
  fetchBotsReady,
  heartbeat,
  registerWorker,
  reportRuntimeSync,
  claimPrResolution,
  completePrResolution,
  dispatchTick,
  ensureGitProvision,
  fetchActiveProjects,
} = await import("./back-client.js");
const {
  appendJobLogLine,
  publishJobLogEvent,
  resetJobLog,
} = await import("./job-log-redis.js");
const { runJobLocally } = await import("./run-job.js");
const { reportProjectDashboard } = await import("./report-dashboard.js");
const { syncProjectAgentsToDisk } = await import("./sync-project-agents.js");
const {
  clearBillingSession,
  reconcileJobBilling,
  flushPendingSettlements,
  describeBillingSession,
} = await import("./ai-call-billing.js");
const { createLogger, redactForClient } = await import("./logger.js");

const log = createLogger("worker");
const TENANT_PREFIX = TENANT_ID.slice(0, 8);
const POLL_MS = Number(process.env.CLAIM_POLL_MS || 1000);
const DASHBOARD_SYNC_MS = Number(process.env.DASHBOARD_SYNC_MS || 5000);
const BOTS_READY_REFRESH_MS = Number(
  process.env.BOTS_READY_REFRESH_MS || 300_000
);
const RUNTIME_SYNC_MS = Number(process.env.RUNTIME_SYNC_MS || 15_000);

/** @type {Map<number, boolean>} */
const runningBySlot = new Map();
/** @type {Map<number, string>} */
const currentJobBySlot = new Map();
/** @type {number[]} */
let activeSlots = [];

function workerIdForSlot(slot) {
  return `cli-${TENANT_PREFIX}-slot-${slot}`;
}

function buildRuntimeSlots() {
  return activeSlots.map((slot) => ({
    slot,
    workerId: workerIdForSlot(slot),
    busy: runningBySlot.get(slot) === true,
    jobId: currentJobBySlot.get(slot) ?? null,
  }));
}

/**
 * @param {{ startup?: boolean }} [opts]
 */
async function syncRuntimeToBack(opts = {}) {
  if (activeSlots.length === 0 && !opts.startup) return null;
  try {
    const result = await reportRuntimeSync({
      slots: buildRuntimeSlots(),
      startup: opts.startup === true,
    });
    if (opts.startup && result?.failed?.length) {
      log.info("Runtime sync (startup): jobs órfãos no back", {
        count: result.failed.length,
      });
    }
    if (opts.startup && result?.executionUpdates?.length) {
      log.info("Runtime sync (startup): pools de execução alinhados", {
        projects: result.executionUpdates.map((u) => u.project),
      });
    }
    return result;
  } catch (e) {
    log.warn("Runtime sync falhou", { error: e.message });
    return null;
  }
}

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

/**
 * @param {string} jobId
 * @param {{ status: string, exitCode?: number, startedMs: number, finishedMs: number, billingEmail?: string }} opts
 */
async function finishJobWithBilling(jobId, opts) {
  const session = describeBillingSession(jobId);
  log.info("Finalizando billing do job (worker)", {
    jobId,
    pid: process.pid,
    billingEmail: opts.billingEmail || "(ausente)",
    ...session,
  });

  await flushPendingSettlements();

  const reconciled = await reconcileJobBilling(jobId, {
    startedMs: opts.startedMs,
    finishedMs: opts.finishedMs,
    email: opts.billingEmail || undefined,
  });

  await completeJob(jobId, {
    status: opts.status,
    exitCode: opts.exitCode,
    costBaseUsd: reconciled.totalCostBaseUsd,
    chargeSource: reconciled.chargeSource,
  });

  log.info("Billing registado (summary BD + completeJob)", {
    jobId,
    costBaseUsd: reconciled.totalCostBaseUsd.toFixed(4),
    calls: reconciled.callCount,
    chargeSource: reconciled.chargeSource,
  });
}

/**
 * @param {object} job
 * @param {{ workerId: string, slot: number, botEmail?: string|null }} ctx
 */
async function processOneJob(job, ctx) {
  const { workerId, slot, botEmail } = ctx;
  const billingEmail = botEmail || job.botEmail || null;
  const jobStartedMs = Date.now();
  const projectSlug =
    job.projectSlug ||
    (job.kind === "provision" || job.kind === "git-migrate"
      ? job.payload?.slug
      : null);

  log.debug("Job processamento iniciado", {
    jobId: job.id,
    kind: job.kind,
    project: projectSlug || "—",
    task: job.taskId || "—",
    executor: job.requestedByEmail || "—",
  });

  const prevUsageEmail = process.env.CURSOR_USAGE_EMAIL;
  if (billingEmail) {
    process.env.CURSOR_USAGE_EMAIL = billingEmail;
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
    const clearedPath = clearBillingSession(job.id);
    if (clearedPath) {
      log.info("Sessão billing anterior removida", {
        jobId: job.id,
        path: clearedPath,
      });
    }
    await appendJobLogLine(
      job.id,
      `Worker ${workerId} (slot ${slot}) iniciou job ${job.kind}`
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
      billingEmail,
    });
    const durationSec = ((Date.now() - jobStartedMs) / 1000).toFixed(1);
    log.info("Job concluído", {
      jobId: job.id,
      slot,
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
        billingEmail,
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
    if (billingEmail) {
      if (prevUsageEmail !== undefined) {
        process.env.CURSOR_USAGE_EMAIL = prevUsageEmail;
      } else {
        delete process.env.CURSOR_USAGE_EMAIL;
      }
    }
    runningBySlot.set(slot, false);
    currentJobBySlot.delete(slot);
    void syncRuntimeToBack();
    setImmediate(() => loopForSlot(slot));
  }
}

/**
 * Antes de claim de job: resolve PR parado (conflito) — merge tech-lead na head, push, merge API.
 * @param {number} slot
 * @param {string} workerId
 * @returns {Promise<boolean>} true se tratou um PR (repetir loop)
 */
async function tryResolveStuckPr(slot, workerId) {
  let work;
  try {
    const data = await claimPrResolution(workerId);
    work = data?.work ?? null;
  } catch (e) {
    log.warn("PR resolution claim falhou", { slot, error: e.message });
    return false;
  }
  if (!work) return false;

  const logJobId = work.jobId || null;
  runningBySlot.set(slot, true);
  if (logJobId) currentJobBySlot.set(slot, logJobId);

  const onLine = (line) => {
    const t = String(line || "").trimEnd();
    if (t) log.info(t, { slot, pr: work.prNumber });
    if (logJobId) {
      void appendJobLogLine(logJobId, line).catch(() => {});
      void publishJobLogEvent(logJobId, { type: "stdout", text: line }).catch(
        () => {}
      );
    }
  };

  log.info("PR resolution iniciada", {
    slot,
    project: work.projectSlug,
    task: work.taskId,
    pr: work.prNumber,
  });

  try {
    const { resolveStuckPullRequest } = await import(
      "../orchestrator/resolve-stuck-pr.js"
    );
    await resolveStuckPullRequest(work, onLine);
  } catch (e) {
    log.error("PR resolution erro", { slot, error: e.message });
    try {
      await completePrResolution({
        projectSlug: work.projectSlug,
        taskId: work.taskId,
        status: "failed",
        summary: e.message,
      });
    } catch {
      /* ignore */
    }
  } finally {
    runningBySlot.set(slot, false);
    if (logJobId) currentJobBySlot.delete(slot);
    void syncRuntimeToBack();
  }

  return true;
}

async function slotHasPlay(slot) {
  const workerId = workerIdForSlot(slot);
  try {
    const data = await fetchActiveProjects(workerId);
    return Array.isArray(data.projects) && data.projects.length > 0;
  } catch {
    return false;
  }
}

async function tryClaimProvision(slot, workerId) {
  try {
    const claimed = await claimJob(workerId, { provisionOnly: true });
    if (claimed.error === "bot_not_configured") return false;
    const job = claimed.job;
    if (!job || !["provision", "git-migrate"].includes(job.kind)) return false;
    log.info("Infra Git claimed", {
      slot,
      jobId: job.id,
      kind: job.kind,
      project: job.projectSlug,
    });
    runningBySlot.set(slot, true);
    currentJobBySlot.set(slot, job.id);
    void syncRuntimeToBack();
    await processOneJob(job, {
      workerId,
      slot,
      botEmail: claimed.botEmail || job.botEmail,
    });
    return true;
  } catch (e) {
    log.warn("Provision claim falhou", { slot, error: e.message });
    return false;
  }
}

async function loopForSlot(slot) {
  if (runningBySlot.get(slot)) return;
  const workerId = workerIdForSlot(slot);

  const inPlay = await slotHasPlay(slot);

  if (!inPlay) {
    const didProvision = await tryClaimProvision(slot, workerId);
    if (didProvision) {
      setImmediate(() => loopForSlot(slot));
    }
    return;
  }

  try {
    const prHandled = await tryResolveStuckPr(slot, workerId);
    if (prHandled) {
      setImmediate(() => loopForSlot(slot));
      return;
    }

    await dispatchTick(workerId).catch((e) =>
      log.warn("dispatch-tick falhou", { slot, error: e.message })
    );

    const claimStart = Date.now();
    let claimed = await claimJob(workerId);
    if (claimed.error === "bot_not_configured") {
      log.warn("Bot não configurado para slot", { slot });
      return;
    }
    let job = claimed.job;
    if (!job) {
      await dispatchTick(workerId).catch(() => {});
      claimed = await claimJob(workerId);
      job = claimed.job;
    }
    if (!job) return;
    log.info("Job claimed", {
      slot,
      jobId: job.id,
      kind: job.kind,
      project: job.projectSlug,
      task: job.taskId || "—",
      executor: job.requestedByEmail || job.requestedByUserId || "—",
      bot: claimed.botEmail || job.botEmail || "—",
      claimMs: Date.now() - claimStart,
    });
    runningBySlot.set(slot, true);
    currentJobBySlot.set(slot, job.id);
    void syncRuntimeToBack();
    await processOneJob(job, {
      workerId,
      slot,
      botEmail: claimed.botEmail || job.botEmail,
    });
  } catch (e) {
    log.error("Claim falhou", { slot, error: e.message });
  }
}

async function refreshActiveSlots() {
  const data = await fetchBotsReady();
  const ready = (data.workers || [])
    .filter((w) => w.botReady)
    .map((w) => w.slot);
  if (ready.length === 0) {
    log.warn("Nenhum bot configurado — aguardando admin da plataforma");
    activeSlots = [];
    return;
  }
  const prev = new Set(activeSlots);
  activeSlots = ready;
  for (const slot of ready) {
    if (!prev.has(slot)) {
      const workerId = workerIdForSlot(slot);
      await registerWorker(workerId).catch((e) =>
        log.warn("Register slot falhou", { slot, error: e.message })
      );
      runningBySlot.set(slot, false);
      setInterval(() => loopForSlot(slot), POLL_MS);
      loopForSlot(slot);
      log.info("Loop iniciado para slot", { slot, workerId });
    }
  }
  if (ready.length > 0) {
    void syncRuntimeToBack();
  }
}

async function heartbeatAll() {
  for (const slot of activeSlots) {
    await heartbeat(workerIdForSlot(slot)).catch(() => {});
  }
  await syncRuntimeToBack();
}

async function main() {
  requireEnv("REDIS_URL");
  log.info("AI Factory CLI worker a iniciar", {
    tenant: TENANT_PREFIX + "…",
    back: process.env.BACK_URL,
    color: process.env.AI_FACTORY_LOG_COLOR !== "0",
  });
  await refreshActiveSlots();
  await ensureGitProvision().catch((e) =>
    log.warn("ensure-git-provision falhou", { error: e.message })
  );
  await syncRuntimeToBack({ startup: true });
  setInterval(() => heartbeatAll().catch(() => {}), 30_000);
  setInterval(() => syncRuntimeToBack().catch(() => {}), RUNTIME_SYNC_MS);
  setInterval(() => ensureGitProvision().catch(() => {}), 60_000);
  setInterval(() => refreshActiveSlots().catch((e) => {
    log.warn("Refresh bots-ready falhou", { error: e.message });
  }), BOTS_READY_REFRESH_MS);
}

main().catch((e) => {
  log.error("Worker terminou com erro", { error: e.message });
  process.exit(1);
});
