import { backFetch } from "../src/back-client.js";

const MERGE_MAX_RETRIES = 3;
const MERGE_RETRY_DELAY_MS = 3000;

async function retryableMerge(url, headers, body, onLine) {
  for (let attempt = 1; attempt <= MERGE_MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
    if (res.ok) return res;

    const text = await res.text();
    const retriable = res.status === 405 || res.status === 409 || res.status >= 500;
    if (!retriable || attempt === MERGE_MAX_RETRIES) {
      onLine(`[tech-lead] merge falhou (${res.status}, tentativa ${attempt}/${MERGE_MAX_RETRIES}): ${text}\n`);
      return null;
    }
    onLine(`[tech-lead] merge ${res.status} — retry ${attempt}/${MERGE_MAX_RETRIES} em ${MERGE_RETRY_DELAY_MS / 1000}s…\n`);
    await new Promise((r) => setTimeout(r, MERGE_RETRY_DELAY_MS));
  }
  return null;
}

async function reportTlStatus(project, taskId, status, summary) {
  try {
    await backFetch(`/worker/projects/${encodeURIComponent(project)}/git/tl-review`, {
      method: "POST",
      body: JSON.stringify({ taskId, status, summary }),
    });
  } catch {
    // best-effort
  }
}

/**
 * Revisão Tech Lead automática (simplificada v1).
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
export async function run(job, onLine = console.log) {
  const payload =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload || {};
  const project = job.projectSlug || payload.projectSlug;
  const taskId = job.taskId || payload.taskId;
  const prNumber = payload.prNumber;
  const token = job.githubInstallationToken || process.env.AI_FACTORY_GITHUB_TOKEN;
  const repo = job.git?.repoFullName || process.env.AI_FACTORY_GIT_REPO;
  const techLead = job.git?.techLeadBranch || "tech-lead";

  if (!token || !repo || !prNumber) {
    onLine("[tech-lead] dados insuficientes\n");
    return 1;
  }

  const [owner, repoName] = repo.split("/");
  const apiHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
    { headers: apiHeaders }
  );
  if (!prRes.ok) {
    const body = await prRes.text();
    onLine(`[tech-lead] PR não encontrado: ${body}\n`);
    await reportTlStatus(project, taskId, "failed", `PR #${prNumber} não encontrado`);
    return 1;
  }
  const pr = await prRes.json();

  if (pr.merged) {
    onLine(`[tech-lead] PR #${prNumber} já mergeado\n`);
    await reportTlStatus(project, taskId, "merged", `PR #${prNumber} já mergeado`);
    return 0;
  }

  if (pr.mergeable === false) {
    onLine("[tech-lead] PR com conflitos — precisa resolução manual\n");
    await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          body: "Conflito detectado neste PR. Resolução manual necessária antes do merge.",
        }),
      }
    );
    await reportTlStatus(project, taskId, "conflict", "PR com conflitos");
    return 1;
  }

  const mergeRes = await retryableMerge(
    `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/merge`,
    apiHeaders,
    { merge_method: process.env.GITHUB_TL_MERGE_METHOD || "squash" },
    onLine
  );

  if (!mergeRes) {
    await reportTlStatus(project, taskId, "failed", `Merge falhou após ${MERGE_MAX_RETRIES} tentativas`);
    return 1;
  }

  onLine(`[tech-lead] PR #${prNumber} merged em ${techLead} (${project}/${taskId})\n`);
  await reportTlStatus(project, taskId, "merged", `PR #${prNumber} merged`);
  return 0;
}
