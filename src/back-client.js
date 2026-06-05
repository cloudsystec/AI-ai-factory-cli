import { createLogger } from "./logger.js";

const log = createLogger("api");

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

function isRetryable(err) {
  const msg = String(err?.message || err?.cause?.message || "").toLowerCase();
  return msg.includes("fetch failed")
    || msg.includes("socket")
    || msg.includes("econnreset")
    || msg.includes("econnrefused")
    || msg.includes("other side closed")
    || msg.includes("network");
}

/**
 * @param {string} path
 * @param {RequestInit} init
 */
export async function backFetch(path, init = {}) {
  const base = process.env.BACK_URL?.replace(/\/$/, "");
  if (!base) throw new Error("BACK_URL não definido");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.WORKER_SECRET}`,
    "X-Tenant-Id": process.env.TENANT_ID,
    ...(init.headers || {}),
  };

  const method = init.method || "GET";
  const startMs = Date.now();
  const isBilling =
    path.includes("/billing/calls") || path.includes("/billing/reconcile");
  const silent =
    !isBilling
    && (path === "/worker/claim"
    || path === "/worker/heartbeat"
    || path === "/worker/runtime-sync"
    || path === "/worker/pr-resolution/claim"
    || path === "/worker/dispatch-tick"
    || path.startsWith("/worker/active-projects"));
  if (!silent) {
    const logFn = isBilling ? log.info.bind(log) : log.debug.bind(log);
    logFn(`→ ${method} ${path}`);
  }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, { ...init, headers });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`BACK ${res.status}: ${body}`);
      }
      const elapsedMs = Date.now() - startMs;
      if (!silent) {
        const logFn = isBilling ? log.info.bind(log) : log.debug.bind(log);
        logFn(`← ${method} ${path}`, { status: res.status, elapsedMs });
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = RETRY_BASE_MS * 2 ** attempt;
        log.warn(`${method} ${path} tentativa ${attempt + 1} falhou, retry em ${delay}ms`, { error: err.message });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const elapsedMs = Date.now() - startMs;
      if (!silent) {
        const logFn = isBilling ? log.warn.bind(log) : log.debug.bind(log);
        logFn(`← ${method} ${path} FALHOU`, {
          elapsedMs,
          error: err.message?.slice(0, 200),
        });
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function registerWorker(workerId) {
  await backFetch("/worker/register", {
    method: "POST",
    body: JSON.stringify({ workerId }),
  });
}

/**
 * @returns {Promise<{ slotsMax: number, workers: Array<{ slot: number, botReady: boolean, botEmail?: string|null }> }>}
 */
export async function fetchBotsReady() {
  const res = await backFetch("/worker/bots-ready");
  return res.json();
}

/**
 * @param {string} workerId
 * @returns {Promise<{ job: object|null, botEmail?: string|null, workerSlot?: number, error?: string }>}
 */
/**
 * @param {string} workerId
 * @param {{ provisionOnly?: boolean }} [opts]
 */
export async function claimJob(workerId, opts = {}) {
  const res = await backFetch("/worker/claim", {
    method: "POST",
    body: JSON.stringify({
      workerId,
      provisionOnly: opts.provisionOnly === true,
    }),
  });
  const data = await res.json();
  if (data.error === "bot_not_configured") {
    return { job: null, error: data.error, workerSlot: data.workerSlot };
  }
  return {
    job: data.job ?? null,
    botEmail: data.botEmail ?? data.job?.botEmail ?? null,
    workerSlot: data.workerSlot ?? data.job?.workerSlot,
    error: data.error,
  };
}

/**
 * @param {string} jobId
 * @param {string} line
 */
export async function postLog(jobId, line) {
  await backFetch(`/worker/jobs/${jobId}/log`, {
    method: "POST",
    body: JSON.stringify({ line }),
  });
}

/**
 * @param {string} jobId
 * @param {{ status: string, costBaseUsd?: number, exitCode?: number, chargeSource?: string }} payload
 */
export async function completeJob(jobId, payload) {
  await backFetch(`/worker/jobs/${jobId}/complete`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} jobId
 * @param {{ costBaseUsd: number, chargeSource?: string }} payload
 */
export async function updateJobBilling(jobId, payload) {
  await backFetch(`/worker/jobs/${jobId}/billing`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} jobId
 * @param {{ callId: string, agentFile?: string, agentName?: string, startedAtMs: number, meta?: object }} payload
 */
export async function registerBillingCall(jobId, payload) {
  await backFetch(`/worker/jobs/${jobId}/billing/calls`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} jobId
 * @param {string} callId
 * @param {object} payload
 */
export async function settleBillingCall(jobId, callId, payload) {
  await backFetch(
    `/worker/jobs/${encodeURIComponent(jobId)}/billing/calls/${encodeURIComponent(callId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    }
  );
}

/**
 * @param {string} jobId
 * @param {string} callId
 * @param {{ endedAtMs: number, botEmail?: string }} payload
 */
export async function endBillingCall(jobId, callId, payload) {
  await backFetch(
    `/worker/jobs/${encodeURIComponent(jobId)}/billing/calls/${encodeURIComponent(callId)}/end`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    }
  );
}

/**
 * @param {string} jobId
 * @returns {Promise<{ totalCostBaseUsd: number, chargeSource: string, callCount: number, openCount: number }>}
 */
export async function getJobBillingSummary(jobId) {
  const res = await backFetch(`/worker/jobs/${encodeURIComponent(jobId)}/billing/summary`);
  return res.json();
}

/**
 * @param {{ botEmail: string, sinceMs: number, untilMs: number }} query
 */
export async function fetchConsumedBillingKeys(query) {
  const params = new URLSearchParams({
    botEmail: query.botEmail,
    sinceMs: String(query.sinceMs),
    untilMs: String(query.untilMs),
  });
  const res = await backFetch(`/worker/billing/consumed-keys?${params}`);
  return res.json();
}

/**
 * @param {string} jobId
 * @param {object} payload
 */
export async function reconcileBillingJob(jobId, payload) {
  await backFetch(`/worker/jobs/${jobId}/billing/reconcile`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} [workerId]
 */
export async function heartbeat(workerId) {
  const body = workerId ? JSON.stringify({ workerId }) : "{}";
  await backFetch("/worker/heartbeat", { method: "POST", body });
}

/**
 * Reporta ao back o estado real dos slots (fonte da verdade = CLI).
 * @param {{ slots: Array<{ slot: number, workerId: string, busy: boolean, jobId?: string|null }>, startup?: boolean }} payload
 */
export async function reportRuntimeSync(payload) {
  const res = await backFetch("/worker/runtime-sync", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json();
}

/**
 * @param {string} workerId
 * @returns {Promise<{ work: object|null }>}
 */
export async function claimPrResolution(workerId) {
  const res = await backFetch("/worker/pr-resolution/claim", {
    method: "POST",
    body: JSON.stringify({ workerId }),
  });
  return res.json();
}

/**
 * @param {{ projectSlug: string, taskId: string, status: string, summary?: string }} payload
 */
export async function completePrResolution(payload) {
  await backFetch("/worker/pr-resolution/complete", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} workerId
 */
export async function fetchActiveProjects(workerId) {
  const res = await backFetch(
    `/worker/active-projects?workerId=${encodeURIComponent(workerId)}`
  );
  return res.json();
}

/**
 * @param {string} workerId
 */
export async function dispatchTick(workerId) {
  const res = await backFetch("/worker/dispatch-tick", {
    method: "POST",
    body: JSON.stringify({ workerId }),
  });
  return res.json();
}

export async function ensureGitProvision() {
  const res = await backFetch("/worker/ensure-git-provision", {
    method: "POST",
    body: "{}",
  });
  return res.json();
}

/**
 * @param {string} slug
 * @returns {Promise<{ slug: string, name: string, scopeMd: string }>}
 */
export async function getProjectFromBack(slug) {
  const res = await backFetch(
    `/worker/projects/${encodeURIComponent(slug)}`
  );
  return res.json();
}

/**
 * @param {string} slug
 * @param {{ tasks: unknown, scopeState: unknown }} body
 */
export async function putProjectDashboard(slug, body) {
  await backFetch(`/worker/projects/${encodeURIComponent(slug)}/dashboard`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} slug
 * @param {{ autorun: boolean }} body
 */
/**
 * @param {string} slug
 * @returns {Promise<{ autorun: boolean }>}
 */
export async function getDevelopSettingsFromBack(slug) {
  const res = await backFetch(
    `/worker/projects/${encodeURIComponent(slug)}/develop-settings`
  );
  return res.json();
}

export async function putDevelopSettings(slug, body) {
  await backFetch(
    `/worker/projects/${encodeURIComponent(slug)}/develop-settings`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    }
  );
}

/**
 * @param {string} slug
 * @param {string} taskId
 * @param {unknown} detail
 */
export async function notifyProvisionComplete(slug, body) {
  await backFetch(`/worker/projects/${encodeURIComponent(slug)}/git/provision-complete`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function notifyMigrateComplete(slug, body) {
  await backFetch(`/worker/projects/${encodeURIComponent(slug)}/git/migrate-complete`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function putTaskDetail(slug, taskId, detail) {
  await backFetch(
    `/worker/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/detail`,
    {
      method: "PUT",
      body: JSON.stringify({ detail }),
    }
  );
}

/**
 * @param {string} slug
 * @returns {Promise<{ pauseAfterCurrent: boolean }>}
 */
export async function getExecutionStateFromBack(slug) {
  const res = await backFetch(
    `/worker/projects/${encodeURIComponent(slug)}/execution-state`
  );
  return res.json();
}
