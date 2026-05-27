import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../project-paths.js";
import { gitExec } from "./git-exec.js";

/**
 * @param {string} project
 * @param {{ repoFullName: string, defaultBranch: string, techLeadBranch?: string, token?: string }} git
 * @param {(line: string) => void} [onLine]
 */
export function provisionProjectGit(project, git, onLine = () => {}) {
  const ws = workspaceRoot(project);
  const cacheDir = path.join(ws, ".git-cache");
  const techLead = git.techLeadBranch || "tech-lead";
  const defaultBranch = git.defaultBranch || "main";
  const remoteUrl = tokenRemoteUrl(git.repoFullName, git.token);

  if (fs.existsSync(cacheDir)) {
    onLine(`[git] .git-cache já existe; fetch…\n`);
    gitExec(["remote", "set-url", "origin", remoteUrl], { cwd: cacheDir });
  } else {
    onLine(`[git] clone bare ${git.repoFullName}…\n`);
    fs.mkdirSync(ws, { recursive: true });
    gitExec(["clone", "--bare", remoteUrl, cacheDir]);
  }

  ensureBareRemoteTracking(cacheDir);
  gitExec(["fetch", "origin"], { cwd: cacheDir });

  const isEmpty = !hasAnyRef(cacheDir);
  if (isEmpty) {
    onLine(`[git] repo vazio — criar commit inicial + ${defaultBranch}…\n`);
    bootstrapEmptyRepo(cacheDir, defaultBranch, remoteUrl, onLine);
  }

  if (localBranchExists(cacheDir, techLead)) {
    onLine(`[git] branch ${techLead} já existe (local)\n`);
  } else if (remoteBranchExists(cacheDir, techLead)) {
    onLine(`[git] branch ${techLead} existe no remote — baixar…\n`);
    gitExec(["branch", techLead, `origin/${techLead}`], { cwd: cacheDir });
  } else {
    let base;
    if (localBranchExists(cacheDir, defaultBranch)) {
      base = defaultBranch;
    } else if (remoteBranchExists(cacheDir, defaultBranch)) {
      base = `origin/${defaultBranch}`;
    } else {
      const firstRemote = findAnyRemoteBranch(cacheDir);
      if (firstRemote) {
        base = firstRemote;
        onLine(`[git] branch "${defaultBranch}" não encontrada — usando ${firstRemote}\n`);
      } else {
        onLine(`[git] repo sem branches — criar commit inicial…\n`);
        bootstrapEmptyRepo(cacheDir, defaultBranch, remoteUrl, onLine);
        base = `origin/${defaultBranch}`;
      }
    }
    onLine(`[git] criar branch ${techLead} a partir de ${base}…\n`);
    gitExec(["branch", techLead, base], { cwd: cacheDir });
    gitExec(["push", "origin", techLead], { cwd: cacheDir });
  }

  onLine(`[git] provision OK (${techLead} pronta)\n`);
  return { cacheDir, techLeadBranch: techLead };
}

/**
 * Bare clones use refspec +refs/heads/*:refs/heads/* by default,
 * which prevents remote tracking refs (refs/remotes/origin/*) from
 * being created. Fix the refspec so git fetch populates origin/*.
 */
function ensureBareRemoteTracking(cwd) {
  try {
    gitExec(
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd }
    );
  } catch { /* ignore */ }
}

function hasAnyRef(cwd) {
  try {
    const out = gitExec(["show-ref", "--head"], { cwd });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function localBranchExists(cwd, branch) {
  try {
    gitExec(["show-ref", "--verify", `refs/heads/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function remoteBranchExists(cwd, branch) {
  try {
    gitExec(["show-ref", "--verify", `refs/remotes/origin/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function findAnyRemoteBranch(cwd) {
  try {
    const out = gitExec(["branch", "-r"], { cwd });
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const first = lines.find((l) => !l.includes("HEAD"));
    return first || null;
  } catch {
    return null;
  }
}

function bootstrapEmptyRepo(cacheDir, defaultBranch, remoteUrl, onLine) {
  const tmp = cacheDir + "-init-tmp";
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    gitExec(["clone", remoteUrl, tmp]);
    gitExec(["checkout", "-B", defaultBranch], { cwd: tmp });
    const readmePath = path.join(tmp, "README.md");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, `# Projeto\n`, "utf-8");
      gitExec(["add", "README.md"], { cwd: tmp });
    }
    try {
      gitExec(["commit", "-m", "initial commit"], { cwd: tmp });
    } catch { /* nothing to commit — repo already has content */ }
    try {
      gitExec(["push", "-u", "origin", defaultBranch], { cwd: tmp });
    } catch { /* already up to date */ }
    onLine(`[git] commit inicial pushed → ${defaultBranch}\n`);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
  ensureBareRemoteTracking(cacheDir);
  gitExec(["fetch", "origin"], { cwd: cacheDir });
}

function tokenRemoteUrl(repoFullName, token) {
  if (token) {
    return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  }
  return `https://github.com/${repoFullName}.git`;
}
