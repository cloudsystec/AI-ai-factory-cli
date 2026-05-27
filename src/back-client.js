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
  const silent = path === "/worker/claim" || path === "/worker/heartbeat";
  if (!silent) log.debug(`→ ${method} ${path}`);

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, { ...init, headers });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`BACK ${res.status}: ${body}`);
      }
      const elapsedMs = Date.now() - startMs;
      if (!silent) log.debug(`← ${method} ${path}`, { status: res.status, elapsedMs });
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
      if (!silent) log.debug(`← ${method} ${path} FALHOU`, { elapsedMs, error: err.message?.slice(0, 100) });
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
 * @param {string} workerId
 * @returns {Promise<object|null>}
 */
export async function claimJob(workerId) {
  const res = await backFetch("/worker/claim", {
    method: "POST",
    body: JSON.stringify({ workerId }),
  });
  const data = await res.json();
  return data.job;
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
 * @param {{ status: string, costBaseUsd?: number, exitCode?: number }} payload
 */
export async function completeJob(jobId, payload) {
  await backFetch(`/worker/jobs/${jobId}/complete`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * @param {string} jobId
 * @param {{ costBaseUsd: number }} payload
 */
export async function updateJobBilling(jobId, payload) {
  await backFetch(`/worker/jobs/${jobId}/billing`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function heartbeat() {
  await backFetch("/worker/heartbeat", { method: "POST", body: "{}" });
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
