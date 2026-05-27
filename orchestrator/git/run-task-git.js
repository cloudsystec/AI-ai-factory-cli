import fs from "node:fs";
import path from "node:path";
import { npmTestPrefix, repoRelativePosix, workspaceRoot } from "../project-paths.js";
import { readDevelopSettings } from "../develop-settings.js";
import { ensureTaskWorkspace } from "./task-workspace.js";
import { publishTaskPullRequest } from "./publish-task-pr.js";
import { cleanupTaskWorkspace } from "./cleanup-task-workspace.js";
import { backFetch } from "../../src/back-client.js";

/**
 * @param {object} jobEnv from process.env + worker job
 */
export function isGitTaskEnabled(jobEnv) {
  return Boolean(jobEnv?.AI_FACTORY_GITHUB_TOKEN && jobEnv?.AI_FACTORY_GIT_REPO);
}

export function taskCodePrefix(project, taskId) {
  return path.join(workspaceRoot(project), "tasks", taskId, "code");
}

/**
 * @param {string} project
 * @param {string} taskId
 * @param {object} task
 * @param {object} ctx
 */
export async function setupGitForTask(project, taskId, ctx) {
  const { git, onLine = console.log } = ctx;
  if (!git?.githubInstallationToken) return null;

  process.env.AI_FACTORY_GITHUB_TOKEN = git.githubInstallationToken;
  process.env.AI_FACTORY_GIT_REPO = git.git?.repoFullName || git.repoFullName;
  process.env.AI_FACTORY_TECH_LEAD_BRANCH =
    git.git?.techLeadBranch || "tech-lead";

  const codeDir = ensureTaskWorkspace(
    project,
    taskId,
    {
      techLeadBranch: process.env.AI_FACTORY_TECH_LEAD_BRANCH,
      token: process.env.AI_FACTORY_GITHUB_TOKEN,
    },
    onLine
  );
  return codeDir;
}

/**
 * @param {string} project
 * @param {string} taskId
 * @param {object} task
 * @param {object} ctx
 */
export async function finalizeGitForTask(project, taskId, task, ctx) {
  const { jobId, git, microId, onLine = console.log } = ctx;
  const token = git?.githubInstallationToken || process.env.AI_FACTORY_GITHUB_TOKEN;
  const repoFull = git?.git?.repoFullName || process.env.AI_FACTORY_GIT_REPO;
  const techLead = git?.git?.techLeadBranch || "tech-lead";
  if (!token || !repoFull) {
    onLine("[git] skip PR (sem token/repo)\n");
    return;
  }

  const devReport = path.join(
    workspaceRoot(project),
    "reports",
    "tasks",
    `${taskId}-dev.md`
  );
  let body = "";
  if (fs.existsSync(devReport)) {
    body = fs.readFileSync(devReport, "utf-8").slice(0, 8000);
  }

  const micro = microId || task.sourceMicroId || project;
  const title = `[${project}/${micro}/${taskId}] ${task.title || taskId}`;

  const [owner, repo] = repoFull.split("/");

  const pr = await publishTaskPullRequest(
    {
      project,
      taskId,
      title,
      body,
      techLeadBranch: techLead,
      token,
      repoFullName: repoFull,
      createPrFn: async ({ title: t, body: b, head, base }) => {
        const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
        const hdrs = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        const res = await fetch(`${apiBase}/pulls`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify({ title: t, body: b, head, base }),
        });
        if (res.ok) {
          const data = await res.json();
          return { number: data.number, url: data.html_url };
        }
        if (res.status === 422) {
          const existing = await fetch(
            `${apiBase}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
            { headers: hdrs }
          );
          if (existing.ok) {
            const prs = await existing.json();
            if (prs.length > 0) {
              return { number: prs[0].number, url: prs[0].html_url };
            }
          }
        }
        throw new Error(await res.text());
      },
    },
    onLine
  );

  cleanupTaskWorkspace(project, taskId, onLine);

  if (jobId) {
    await backFetch(`/worker/projects/${encodeURIComponent(project)}/git/pr`, {
      method: "POST",
      body: JSON.stringify({
        taskId,
        jobId,
        microId: micro,
        executorUserId:
          process.env.AI_FACTORY_EXECUTOR_USER_ID || undefined,
        prNumber: pr.number,
        prUrl: pr.url,
        headBranch: `task/${taskId}`,
        baseBranch: techLead,
      }),
    });
  }
}

export function resolveHumanAgentAfterPipeline(project) {
  const settings = readDevelopSettings(project);
  if (settings.skipHumanApproval) {
    return "Done";
  }
  return "Human Approval Pending";
}

export function codePathPrompt(project, taskId) {
  if (process.env.AI_FACTORY_GITHUB_TOKEN) {
    return repoRelativePosix(taskCodePrefix(project, taskId));
  }
  return repoRelativePosix(workspaceRoot(project));
}

export function npmTestPrefixForTask(project, taskId) {
  if (process.env.AI_FACTORY_GITHUB_TOKEN) {
    return repoRelativePosix(taskCodePrefix(project, taskId)).replace(/\\/g, "/");
  }
  return npmTestPrefix(project);
}
