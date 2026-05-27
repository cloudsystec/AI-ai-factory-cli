import { backFetch } from "../src/back-client.js";

async function reportRelease(project, microId, data) {
  try {
    await backFetch(
      `/worker/projects/${encodeURIComponent(project)}/micros/${encodeURIComponent(microId)}/release-complete`,
      { method: "POST", body: JSON.stringify(data) }
    );
  } catch {
    // best-effort
  }
}

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
export async function run(job, onLine = console.log) {
  const payload =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload || {};
  const project = job.projectSlug || payload.projectSlug;
  const microId = payload.microId;
  const token = job.githubInstallationToken || process.env.AI_FACTORY_GITHUB_TOKEN;
  const repo = job.git?.repoFullName || process.env.AI_FACTORY_GIT_REPO;
  const defaultBranch = job.git?.defaultBranch || "main";
  const techLead = job.git?.techLeadBranch || "tech-lead";

  if (!token || !repo) {
    onLine("[micro-release] sem token/repo\n");
    return 1;
  }

  const [owner, repoName] = repo.split("/");
  const apiHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const title = `[${project}/${microId}] Release micro — integração em ${defaultBranch}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      title,
      body: "Release do microescopo — merge manual após validação.",
      head: techLead,
      base: defaultBranch,
    }),
  });

  if (res.ok) {
    const pr = await res.json();
    onLine(`[micro-release] PR #${pr.number} criado: ${pr.html_url}\n`);
    await reportRelease(project, microId, {
      prNumber: pr.number,
      prUrl: pr.html_url,
      status: "open",
    });
    return 0;
  }

  if (res.status === 422) {
    const existing = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/pulls?head=${encodeURIComponent(`${owner}:${techLead}`)}&base=${encodeURIComponent(defaultBranch)}&state=open`,
      { headers: apiHeaders }
    );
    if (existing.ok) {
      const prs = await existing.json();
      if (prs.length > 0) {
        onLine(`[micro-release] PR #${prs[0].number} já existe: ${prs[0].html_url}\n`);
        await reportRelease(project, microId, {
          prNumber: prs[0].number,
          prUrl: prs[0].html_url,
          status: "open",
        });
        return 0;
      }
    }

    const closed = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/pulls?head=${encodeURIComponent(`${owner}:${techLead}`)}&base=${encodeURIComponent(defaultBranch)}&state=closed`,
      { headers: apiHeaders }
    );
    if (closed.ok) {
      const prs = await closed.json();
      const merged = prs.find((pr) => pr.merged_at);
      if (merged) {
        onLine(`[micro-release] PR #${merged.number} já mergeado em ${merged.merged_at}\n`);
        await reportRelease(project, microId, {
          prNumber: merged.number,
          prUrl: merged.html_url,
          status: "merged",
        });
        return 0;
      }
    }
  }

  onLine(`[micro-release] erro: ${await res.text()}\n`);
  return 1;
}
