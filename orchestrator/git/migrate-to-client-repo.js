import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../project-paths.js";
import { gitExec } from "./git-exec.js";
import { provisionProjectGit } from "./provision-repo.js";
import { ensureTaskWorkspace } from "./task-workspace.js";
import { taskStateFile } from "../project-paths.js";

function tokenRemoteUrl(repoFullName, token) {
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 */
function copyDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const name of fs.readdirSync(srcDir)) {
    if (name === ".git") continue;
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * @param {string} cacheDir
 * @param {string} branch
 * @param {string} destDir
 */
function exportBranchTree(cacheDir, branch, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  gitExec([
    "--git-dir",
    cacheDir,
    "--work-tree",
    destDir,
    "checkout",
    "-f",
    branch,
  ]);
}

/**
 * @param {string} project
 * @param {object} opts
 * @param {(line: string) => void} [onLine]
 */
export async function migrateToClientRepo(project, opts, onLine = () => {}) {
  const {
    token,
    managedRepoFullName,
    repoFullName,
    defaultBranch = "main",
    techLeadBranch = "tech-lead",
    sourceTechLead = "tech-lead",
  } = opts;

  if (!token || !repoFullName) {
    throw new Error("token e repoFullName obrigatórios para migração");
  }

  const ws = workspaceRoot(project);
  const cacheDir = path.join(ws, ".git-cache");
  if (!fs.existsSync(cacheDir)) {
    throw new Error(`Git cache ausente em ${cacheDir}`);
  }

  onLine(`[git-migrate] exportar ${sourceTechLead} do repo managed…\n`);
  const sourceTree = path.join(ws, ".git-migrate-source");
  if (fs.existsSync(sourceTree)) {
    fs.rmSync(sourceTree, { recursive: true, force: true });
  }
  exportBranchTree(cacheDir, sourceTechLead, sourceTree);

  const clientRemote = tokenRemoteUrl(repoFullName, token);
  const clientWork = path.join(ws, ".git-migrate-client");
  if (fs.existsSync(clientWork)) {
    fs.rmSync(clientWork, { recursive: true, force: true });
  }

  onLine(`[git-migrate] preparar repo cliente ${repoFullName}…\n`);
  gitExec(["clone", clientRemote, clientWork]);
  gitExec(["checkout", "-B", defaultBranch], { cwd: clientWork });

  const readmePath = path.join(clientWork, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# ${project}\n`, "utf-8");
  }
  gitExec(["add", "-A"], { cwd: clientWork });
  try {
    gitExec(["commit", "-m", "initial commit"], { cwd: clientWork });
  } catch {
    /* already committed */
  }
  gitExec(["push", "-u", "origin", defaultBranch], { cwd: clientWork });

  onLine(`[git-migrate] branch ${techLeadBranch} com código actual…\n`);
  gitExec(["checkout", "-B", techLeadBranch, defaultBranch], { cwd: clientWork });

  for (const name of fs.readdirSync(clientWork)) {
    if (name === ".git" || name === "README.md") continue;
    const p = path.join(clientWork, name);
    fs.rmSync(p, { recursive: true, force: true });
  }
  copyDirContents(sourceTree, clientWork);
  gitExec(["add", "-A"], { cwd: clientWork });
  gitExec(
    ["commit", "-m", `[migrate] código integrado em ${techLeadBranch}`],
    { cwd: clientWork }
  );
  gitExec(["push", "-u", "origin", techLeadBranch], { cwd: clientWork });

  fs.rmSync(sourceTree, { recursive: true, force: true });
  fs.rmSync(clientWork, { recursive: true, force: true });

  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  onLine(`[git-migrate] re-provisionar cache com repo cliente…\n`);
  provisionProjectGit(
    project,
    {
      repoFullName,
      defaultBranch,
      techLeadBranch,
      token,
    },
    onLine
  );

  const statePath = taskStateFile(project);
  /** @type {Array<{ id?: string, status?: string }>} */
  let tasksState = [];
  if (fs.existsSync(statePath)) {
    try {
      tasksState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    } catch {
      tasksState = [];
    }
  }

  const openTasks = tasksState.filter(
    (t) => t?.id && t.status !== "done"
  );
  if (openTasks.length > 0) {
    onLine(
      `[git-migrate] realinhar ${openTasks.length} task(s) em curso…\n`
    );
    for (const t of openTasks) {
      ensureTaskWorkspace(
        project,
        t.id,
        { techLeadBranch, token, forceRecreate: true },
        onLine
      );
    }
  }

  onLine(`[git-migrate] concluído (${managedRepoFullName || "?"} → ${repoFullName})\n`);
}
