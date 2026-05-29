import { mergeTechLeadIntoBranch } from "./git/merge-tech-lead-into-branch.js";
import { ensureTaskWorkspace, taskCodeDir } from "./git/task-workspace.js";
import { backFetch } from "../src/back-client.js";

const MERGE_MAX_RETRIES = 3;
const MERGE_RETRY_DELAY_MS = 3000;
const MERGEABLE_POLL_MS = 2500;
const MERGEABLE_MAX_POLLS = 20;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/**
 * @param {string} owner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} token
 */
async function fetchPull(owner, repoName, prNumber, token) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
    { headers: apiHeaders(token) }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR ${prNumber}: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * @param {string} owner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} token
 * @param {(line: string) => void} onLine
 */
async function waitForMergeable(owner, repoName, prNumber, token, onLine) {
  for (let i = 0; i < MERGEABLE_MAX_POLLS; i += 1) {
    const pr = await fetchPull(owner, repoName, prNumber, token);
    if (pr.merged) return { merged: true, mergeable: true };
    if (pr.mergeable === true) return { merged: false, mergeable: true };
    if (pr.mergeable === false) return { merged: false, mergeable: false };
    onLine(`[pr-resolve] GitHub a calcular mergeable (${i + 1}/${MERGEABLE_MAX_POLLS})…\n`);
    await sleep(MERGEABLE_POLL_MS);
  }
  return { merged: false, mergeable: null };
}

/**
 * @param {string} owner
 * @param {string} repoName
 * @param {number} prNumber
 * @param {string} token
 * @param {(line: string) => void} onLine
 */
async function mergePullRequestApi(owner, repoName, prNumber, token, onLine) {
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/merge`;
  const body = { merge_method: process.env.GITHUB_TL_MERGE_METHOD || "squash" };
  for (let attempt = 1; attempt <= MERGE_MAX_RETRIES; attempt += 1) {
    const res = await fetch(url, {
      method: "PUT",
      headers: apiHeaders(token),
      body: JSON.stringify(body),
    });
    if (res.ok) return true;
    const text = await res.text();
    const retriable = res.status === 405 || res.status === 409 || res.status >= 500;
    if (!retriable || attempt === MERGE_MAX_RETRIES) {
      onLine(`[pr-resolve] merge API falhou (${res.status}): ${text}\n`);
      return false;
    }
    onLine(
      `[pr-resolve] merge ${res.status} — retry ${attempt}/${MERGE_MAX_RETRIES}…\n`
    );
    await sleep(MERGE_RETRY_DELAY_MS);
  }
  return false;
}

async function reportComplete(work, status, summary) {
  await backFetch("/worker/pr-resolution/complete", {
    method: "POST",
    body: JSON.stringify({
      projectSlug: work.projectSlug,
      taskId: work.taskId,
      status,
      summary,
    }),
  });
}

/**
 * @param {object} work — payload do claim no back
 * @param {(line: string) => void} onLine
 */
export async function resolveStuckPullRequest(work, onLine = console.log) {
  const {
    projectSlug,
    taskId,
    prNumber,
    headBranch,
    baseBranch,
    repoFullName,
    techLeadBranch,
    githubInstallationToken,
  } = work;

  const token =
    githubInstallationToken || process.env.AI_FACTORY_GITHUB_TOKEN;
  const techLead = techLeadBranch || baseBranch || "tech-lead";

  if (!token || !repoFullName || !prNumber) {
    onLine("[pr-resolve] dados insuficientes (token/repo/pr)\n");
    await reportComplete(work, "failed", "Dados Git insuficientes");
    return 1;
  }

  const [owner, repoName] = repoFullName.split("/");
  onLine(
    `[pr-resolve] PR #${prNumber} ${projectSlug}/${taskId} (${headBranch} → ${techLead})\n`
  );

  let pr;
  try {
    pr = await fetchPull(owner, repoName, prNumber, token);
  } catch (e) {
    onLine(`[pr-resolve] ${e.message}\n`);
    await reportComplete(work, "failed", e.message);
    return 1;
  }

  if (pr.merged) {
    onLine(`[pr-resolve] PR #${prNumber} já mergeado no GitHub\n`);
    await reportComplete(work, "merged", `PR #${prNumber} já mergeado`);
    return 0;
  }

  if (pr.mergeable === true) {
    onLine(`[pr-resolve] PR mergeável — merge directo\n`);
    const ok = await mergePullRequestApi(owner, repoName, prNumber, token, onLine);
    if (ok) {
      await reportComplete(work, "merged", `PR #${prNumber} merged`);
      return 0;
    }
    await reportComplete(work, "conflict", "Merge API falhou");
    return 1;
  }

  onLine(`[pr-resolve] PR com conflito — merge local tech-lead → head\n`);

  try {
    ensureTaskWorkspace(
      projectSlug,
      taskId,
      { techLeadBranch: techLead, token },
      onLine
    );
  } catch (e) {
    onLine(`[pr-resolve] workspace: ${e.message}\n`);
    await reportComplete(work, "failed", `Workspace: ${e.message}`);
    return 1;
  }

  const codeDir = taskCodeDir(projectSlug, taskId);
  const mergeResult = await mergeTechLeadIntoBranch(
    {
      project: projectSlug,
      taskId,
      codeDir,
      techLeadBranch: techLead,
      token,
      repoFullName,
      headBranch: headBranch || pr.head?.ref,
    },
    onLine
  );

  if (!mergeResult.pushed) {
    onLine("[pr-resolve] não foi possível integrar tech-lead na branch do PR\n");
    await reportComplete(work, "conflict", "Conflitos não resolvidos");
    return 1;
  }

  const state = await waitForMergeable(owner, repoName, prNumber, token, onLine);
  if (state.merged) {
    await reportComplete(work, "merged", `PR #${prNumber} já mergeado`);
    return 0;
  }
  if (state.mergeable === false) {
    onLine("[pr-resolve] GitHub ainda reporta conflito após push\n");
    await reportComplete(work, "conflict", "Conflito persiste no GitHub");
    return 1;
  }

  const ok = await mergePullRequestApi(owner, repoName, prNumber, token, onLine);
  if (ok) {
    onLine(`[pr-resolve] PR #${prNumber} merged em ${techLead}\n`);
    await reportComplete(work, "merged", `PR #${prNumber} merged após resolução`);
    return 0;
  }

  await reportComplete(work, "conflict", "Merge API falhou após resolução local");
  return 1;
}
