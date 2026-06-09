import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../project-paths.js";
import { gitExec } from "./git-exec.js";
import {
  copyDirContents,
  exportBranchTree,
  provisionProjectGit,
} from "./provision-repo.js";
import { realignOpenTaskWorkspaces } from "./task-workspace.js";

function tokenRemoteUrl(repoFullName, token) {
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
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

  await realignOpenTaskWorkspaces(
    project,
    { techLeadBranch, token },
    onLine,
    "[git-migrate]"
  );

  onLine(`[git-migrate] concluído (${managedRepoFullName || "?"} → ${repoFullName})\n`);
}
