import fs from "node:fs";
import { gitExec } from "./git-exec.js";
import { taskCodeDir, taskBranchName } from "./task-workspace.js";
import { mergeTechLeadIntoBranch } from "./merge-tech-lead-into-branch.js";

/**
 * @param {object} opts
 * @param {(line: string) => void} [onLine]
 */
export async function publishTaskPullRequest(opts, onLine = () => {}) {
  const {
    project,
    taskId,
    title,
    body,
    techLeadBranch = "tech-lead",
    createPrFn,
    token,
    repoFullName,
  } = opts;

  const codeDir = taskCodeDir(project, taskId);
  if (!fs.existsSync(codeDir)) {
    throw new Error(`Task workspace ausente: ${codeDir}`);
  }

  const branch = taskBranchName(taskId);

  // 1) Commit local changes
  gitExec(["add", "-A"], { cwd: codeDir });
  const status = gitExec(["status", "--porcelain"], { cwd: codeDir });
  if (status) {
    gitExec(
      ["commit", "-m", `[${project}/${taskId}] implementação concluída`],
      { cwd: codeDir }
    );
  }
  onLine(`[git] commit local OK\n`);

  const mergeResult = await mergeTechLeadIntoBranch(
    {
      project,
      taskId,
      codeDir,
      techLeadBranch,
      token,
      repoFullName,
      headBranch: branch,
    },
    onLine
  );
  if (!mergeResult.pushed) {
    onLine(`[git] push sem merge completo da tech-lead (PR pode ter conflito no GitHub)\n`);
    try {
      gitExec(["push", "-u", "origin", branch], { cwd: codeDir });
    } catch {
      gitExec(["fetch", "origin"], { cwd: codeDir });
      gitExec(["push", "-u", "--force-with-lease", "origin", branch], { cwd: codeDir });
    }
  }

  // 6) Create PR
  if (!createPrFn) {
    throw new Error("createPrFn obrigatório (API GitHub)");
  }

  const pr = await createPrFn({
    title: title || `[${project}/${taskId}]`,
    body: body || "",
    head: branch,
    base: techLeadBranch,
  });

  onLine(`[git] PR #${pr.number} ${pr.url}\n`);
  return pr;
}
