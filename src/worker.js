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
const IDLE_POLL_MS = Number(process.env.IDLE_CLAIM_POLL_MS || 5000);
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
 * @param {string} jobId — job infra a marcar complete (ex.: railway-publish)
 * @param {{ status: string, exitCode?: number, startedMs: number, finishedMs: number, billingEmail?: string, billingJobId?: string }} opts
 */
async function finishJobWithBilling(jobId, opts) {
  const reconcileJobId = opts.billingJobId || jobId;
  const session = describeBillingSession(reconcileJobId);
  log.info("Finalizando billing do job (worker)", {
    jobId,
    billingJobId: reconcileJobId,
    pid: process.pid,
    billingEmail: opts.billingEmail || "(ausente)",
    ...session,
  });

  await flushPendingSettlements();

  const reconciled = await reconcileJobBilling(reconcileJobId, {
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
    billingJobId: reconcileJobId,
    costBaseUsd: reconciled.totalCostBaseUsd.toFixed(4),
    calls: reconciled.callCount,
    chargeSource: reconciled.chargeSource,
  });
}

/**
 * @param {object} job
 */
function applyJobBillingEnv(job) {
  const billingJobId = job.billingJobId || job.id;
  process.env.AI_FACTORY_JOB_ID = billingJobId;
  process.env.AI_FACTORY_BILLING_SESSION_DIR = path.join(
    tenantRoot,
    "billing-sessions"
  );
  if (job.cursorApiKey) {
    process.env.CURSOR_API_KEY = job.cursorApiKey;
  }
}

/**
 * @param {{ jobId?: string, cursorKey?: string, billingDir?: string }} saved
 */
function restoreJobBillingEnv(saved) {
  if (saved.jobId !== undefined) {
    if (saved.jobId) process.env.AI_FACTORY_JOB_ID = saved.jobId;
    else delete process.env.AI_FACTORY_JOB_ID;
  }
  if (saved.cursorKey !== undefined) {
    if (saved.cursorKey) process.env.CURSOR_API_KEY = saved.cursorKey;
    else delete process.env.CURSOR_API_KEY;
  }
  if (saved.billingDir !== undefined) {
    if (saved.billingDir) {
      process.env.AI_FACTORY_BILLING_SESSION_DIR = saved.billingDir;
    } else {
      delete process.env.AI_FACTORY_BILLING_SESSION_DIR;
    }
  }
}

/**
 * @param {object} job
 * @param {{ workerId: string, slot: number, botEmail?: string|null }} ctx
 */
async function processOneJob(job, ctx) {
  const { workerId, slot, botEmail } = ctx;
  const billingEmail = botEmail || job.botEmail || null;
  const billingJobId = job.billingJobId || job.id;
  const jobStartedMs = Date.now();
  const projectSlug =
    job.projectSlug ||
    (job.kind === "provision" || job.kind === "git-migrate"
      ? job.payload?.slug
      : null);

  log.debug("Job processamento iniciado", {
    jobId: job.id,
    billingJobId,
    kind: job.kind,
    project: projectSlug || "—",
    task: job.taskId || "—",
    executor: job.requestedByEmail || "—",
  });

  const prevUsageEmail = process.env.CURSOR_USAGE_EMAIL;
  if (billingEmail) {
    process.env.CURSOR_USAGE_EMAIL = billingEmail;
  }

  const savedBillingEnv = {
    jobId: process.env.AI_FACTORY_JOB_ID,
    cursorKey: process.env.CURSOR_API_KEY,
    billingDir: process.env.AI_FACTORY_BILLING_SESSION_DIR,
  };
  applyJobBillingEnv(job);

  /** @type {ReturnType<typeof setInterval>|null} */
  let dashboardTimer = null;

  try {
    if (projectSlug) {
      const syncStart = Date.now();
      await syncAgentsForProject(projectSlug);
      log.debug("Agentes sincronizados", { project: projectSlug, elapsedMs: Date.now() - syncStart });
    }

    await resetJobLog(job.id);
    if (billingJobId === job.id) {
      const clearedPath = clearBillingSession(billingJobId);
      if (clearedPath) {
        log.info("Sessão billing anterior removida", {
          jobId: job.id,
          billingJobId,
          path: clearedPath,
        });
      }
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
      billingJobId,
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
        billingJobId,
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
    restoreJobBillingEnv(savedBillingEnv);
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

async function tryClaimInfra(slot, workerId) {
  try {
    const claimed = await claimJob(workerId, { provisionOnly: true });
    if (claimed.error === "bot_not_configured") return false;
    const job = claimed.job;
    if (
      !job ||
      !["provision", "git-migrate", "railway-publish"].includes(job.kind)
    ) {
      return false;
    }
    log.info("Infra job claimed", {
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
  if (runningBySlot.get(slot)) return POLL_MS;
  const workerId = workerIdForSlot(slot);

  const inPlay = await slotHasPlay(slot);

  if (!inPlay) {
    const didInfra = await tryClaimInfra(slot, workerId);
    if (didInfra) return 0;
    return IDLE_POLL_MS;
  }

  try {
    const prHandled = await tryResolveStuckPr(slot, workerId);
    if (prHandled) return 0;

    await dispatchTick(workerId).catch((e) =>
      log.warn("dispatch-tick falhou", { slot, error: e.message })
    );

    const claimStart = Date.now();
    let claimed = await claimJob(workerId);
    if (claimed.error === "bot_not_configured") {
      log.warn("Bot não configurado para slot", { slot });
      return IDLE_POLL_MS;
    }
    let job = claimed.job;
    if (!job) {
      await dispatchTick(workerId).catch(() => {});
      claimed = await claimJob(workerId);
      job = claimed.job;
    }
    if (!job) return POLL_MS;
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
  return POLL_MS;
}

/** Loop adaptativo: intervalo curto com ▶ Play, longo em pausa. */
function startSlotLoop(slot) {
  const tick = () => {
    if (!activeSlots.includes(slot)) return;
    loopForSlot(slot)
      .then((delay) => {
        if (!activeSlots.includes(slot)) return;
        const ms = delay ?? POLL_MS;
        if (ms <= 0) setImmediate(tick);
        else setTimeout(tick, ms);
      })
      .catch(() => {
        if (!activeSlots.includes(slot)) return;
        setTimeout(tick, POLL_MS);
      });
  };
  tick();
}

async function refreshActiveSlots() {
  const data = await fetchBotsReady();
  const botReadySlots = (data.workers || [])
    .filter((w) => w.botReady)
    .map((w) => w.slot);
  const ready = new Set(botReadySlots);
  // Slot 1 faz polling de jobs de infra (provision, git-migrate, publicação) mesmo sem bot.
  ready.add(1);
  const readyList = [...ready].sort((a, b) => a - b);
  if (readyList.length === 0) {
    log.warn("Nenhum slot activo — aguardando configuração");
    activeSlots = [];
    return;
  }
  const prev = new Set(activeSlots);
  activeSlots = readyList;
  for (const slot of readyList) {
    if (!prev.has(slot)) {
      const workerId = workerIdForSlot(slot);
      await registerWorker(workerId).catch((e) =>
        log.warn("Register slot falhou", { slot, error: e.message })
      );
      runningBySlot.set(slot, false);
      startSlotLoop(slot);
      log.info("Loop iniciado para slot", { slot, workerId });
    }
  }
  if (readyList.length > 0) {
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
