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
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BACK ${res.status}: ${body}`);
  }
  return res;
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
export async function putTaskDetail(slug, taskId, detail) {
  await backFetch(
    `/worker/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/detail`,
    {
      method: "PUT",
      body: JSON.stringify({ detail }),
    }
  );
}
