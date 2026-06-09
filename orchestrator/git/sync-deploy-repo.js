import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExec } from "./git-exec.js";
import { exportExistingCodeTree } from "./provision-repo.js";
import {
  copyDeployTreeFiltered,
  overlayDeployArtifacts,
} from "../deploy-workspace-filter.js";
import { validateDeployDockerfileForTree } from "../deploy-source-export.js";

/**
 * @param {string} repoFullName
 * @param {string} token
 */
function tokenRemoteUrl(repoFullName, token) {
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

/**
 * @param {string} dir
 */
function rmDirSafe(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} cacheDir
 * @param {string} token
 * @param {(line: string) => void} onLine
 */
function refreshProjectGitCache(cacheDir, token, onLine) {
  const configPath = path.join(cacheDir, "config");
  if (!fs.existsSync(configPath) || !token) return;
  const cfg = fs.readFileSync(configPath, "utf8");
  const m = cfg.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/m);
  if (!m) return;
  const remote = tokenRemoteUrl(m[1], token);
  gitExec(["remote", "set-url", "origin", remote], { cwd: cacheDir });
  gitExec(
    ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    { cwd: cacheDir }
  );
  gitExec(["fetch", "origin"], { cwd: cacheDir });
  onLine(`[sync] git cache actualizado (${m[1]})…\n`);
}

/**
 * @param {string} project
 * @param {object} opts
 * @param {(line: string) => void} [onLine]
 */
export async function syncDeployRepo(project, opts, onLine = () => {}) {
  const {
    token,
    repoFullName,
    branch = "tech-lead",
    sourceBranch = "tech-lead",
    workspaceRoot: wsRoot,
    generatedFiles = [],
  } = opts;

  if (!token || !repoFullName || !wsRoot) {
    throw new Error("token, repoFullName e workspaceRoot são obrigatórios");
  }

  const runId = Date.now().toString(36);
  const staging = path.join(os.tmpdir(), `aif-deploy-sync-${project}-${runId}`);
  const sourceExport = path.join(
    os.tmpdir(),
    `aif-deploy-source-${project}-${runId}`
  );

  rmDirSafe(staging);
  fs.mkdirSync(staging, { recursive: true });

  const cacheDir = path.join(wsRoot, ".git-cache");
  let exportedBranch = null;
  if (fs.existsSync(cacheDir)) {
    refreshProjectGitCache(cacheDir, token, onLine);
    exportedBranch = exportExistingCodeTree(cacheDir, sourceExport, {
      techLeadBranch: sourceBranch,
      defaultBranch: "main",
    });
  }

  if (exportedBranch) {
    onLine(`[sync] exportar branch ${exportedBranch} do git cache…\n`);
    copyDeployTreeFiltered(sourceExport, staging);
    onLine(`[sync] overlay artefactos de deploy (Dockerfile, etc.)…\n`);
    overlayDeployArtifacts(wsRoot, staging, generatedFiles);
  } else {
    onLine(
      `[sync] git cache ausente — copiar workspace filtrado (fallback)…\n`
    );
    copyDeployTreeFiltered(wsRoot, staging);
    overlayDeployArtifacts(wsRoot, staging, generatedFiles);
  }

  const dockerfile = path.join(staging, "Dockerfile");
  if (fs.existsSync(dockerfile)) {
    validateDeployDockerfileForTree(dockerfile, staging, wsRoot);
    onLine(`[sync] Dockerfile validado contra árvore deploy\n`);
  }

  const remote = tokenRemoteUrl(repoFullName, token);

  try {
    const gitMeta = path.join(staging, ".git");
    if (fs.existsSync(gitMeta)) {
      fs.rmSync(gitMeta, { recursive: true, force: true });
    }

    gitExec(["init"], { cwd: staging });
    gitExec(["branch", "-M", branch], { cwd: staging });
    gitExec(["remote", "add", "origin", remote], { cwd: staging });

    gitExec(["add", "-A"], { cwd: staging });
    const status = gitExec(["status", "--porcelain"], { cwd: staging });
    if (!status) {
      onLine(`[sync] nada para commitar\n`);
    } else {
      gitExec(
        ["commit", "-m", `[deploy] sync ${project} (${sourceBranch}) — ${new Date().toISOString()}`],
        { cwd: staging }
      );
    }

    onLine(`[sync] push ${branch} → ${repoFullName}…\n`);
    try {
      gitExec(["push", "-u", "origin", branch], { cwd: staging });
    } catch {
      gitExec(["fetch", "origin"], { cwd: staging });
      gitExec(["push", "-u", "--force-with-lease", "origin", branch], {
        cwd: staging,
      });
    }
    onLine(`[sync] push OK\n`);
  } finally {
    rmDirSafe(staging);
    rmDirSafe(sourceExport);
    rmDirSafe(path.join(wsRoot, ".deploy-sync"));
  }

  return { repoFullName, branch, sourceBranch: exportedBranch || sourceBranch };
}
