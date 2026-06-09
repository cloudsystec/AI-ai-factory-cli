import fs from "node:fs";
import path from "node:path";
import { workspaceRoot, taskStateFile } from "../project-paths.js";
import { gitExec } from "./git-exec.js";

export function taskCodeDir(project, taskId) {
  return path.join(workspaceRoot(project), "tasks", taskId, "code");
}

function getRemoteRepo(cwd) {
  const url = gitExec(["remote", "get-url", "origin"], { cwd });
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : url;
}

export function taskBranchName(taskId) {
  return `task/${taskId}`;
}

function branchExistsOnRemote(cwd, branch) {
  try {
    gitExec(["show-ref", "--verify", `refs/remotes/origin/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} porcelain saída de `git worktree list --porcelain`
 */
function parseWorktreeList(porcelain) {
  /** @type {{ path: string, branch: string|null }[]} */
  const worktrees = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice(9).trim(), branch: null };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice(7).trim();
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/**
 * Remove registo de worktree quando a pasta foi apagada mas o Git ainda associa a branch ao path.
 * @param {string} cacheDir
 * @param {string} codeDir
 * @param {string} branch
 * @param {(line: string) => void} onLine
 */
function removeTaskWorktreeIfRegistered(cacheDir, codeDir, branch, onLine) {
  const normalizedCode = path.resolve(codeDir);
  const branchRef = `refs/heads/${branch}`;
  let removed = false;

  try {
    const porcelain = gitExec(["worktree", "list", "--porcelain"], { cwd: cacheDir });
    for (const wt of parseWorktreeList(porcelain)) {
      const wtPath = path.resolve(wt.path);
      if (wtPath !== normalizedCode && wt.branch !== branchRef) continue;
      onLine(`[git] remover worktree registado (${wt.branch || wt.path})…\n`);
      try {
        gitExec(["worktree", "remove", "--force", wt.path], { cwd: cacheDir });
        removed = true;
      } catch (e) {
        onLine(`[git] worktree remove warn: ${e.message}\n`);
      }
    }
  } catch {
    /* ignore */
  }

  if (!removed) {
    try {
      gitExec(["worktree", "prune"], { cwd: cacheDir });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string[]} addArgs argumentos após `worktree add`
 */
function worktreeAddWithRecovery(cacheDir, codeDir, branch, addArgs, onLine) {
  try {
    gitExec(["worktree", "add", ...addArgs], { cwd: cacheDir });
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/already checked out/i.test(msg)) throw e;
    onLine(`[git] worktree em conflito — limpar registo e repetir…\n`);
    removeTaskWorktreeIfRegistered(cacheDir, codeDir, branch, onLine);
    gitExec(["worktree", "add", ...addArgs], { cwd: cacheDir });
  }
}

function findFallbackRemoteBranch(cwd) {
  try {
    const out = gitExec(["branch", "-r"], { cwd });
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const main = lines.find((l) => l === "origin/main");
    if (main) return main;
    const first = lines.find((l) => !l.includes("HEAD"));
    return first || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} project
 * @param {string} taskId
 * @param {{ techLeadBranch?: string, token?: string, forceRecreate?: boolean }} [opts]
 * @param {(line: string) => void} [onLine]
 */
export function ensureTaskWorkspace(project, taskId, opts = {}, onLine = () => {}) {
  const ws = workspaceRoot(project);
  const cacheDir = path.join(ws, ".git-cache");
  const codeDir = taskCodeDir(project, taskId);
  const techLead = opts.techLeadBranch || "tech-lead";
  const branch = taskBranchName(taskId);

  if (!fs.existsSync(cacheDir)) {
    throw new Error(`Git cache ausente em ${cacheDir}. Execute provision primeiro.`);
  }

  if (opts.forceRecreate) {
    removeTaskWorktreeIfRegistered(cacheDir, codeDir, branch, onLine);
    if (fs.existsSync(path.join(ws, "tasks", taskId))) {
      try {
        fs.rmSync(path.join(ws, "tasks", taskId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  if (opts.token) {
    const url = `https://x-access-token:${opts.token}@github.com/${getRemoteRepo(cacheDir)}.git`;
    gitExec(["remote", "set-url", "origin", url], { cwd: cacheDir });
  }

  try {
    gitExec(
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: cacheDir }
    );
  } catch { /* ignore */ }

  onLine(`[git] fetch origin…\n`);
  gitExec(["fetch", "origin"], { cwd: cacheDir });

  if (!branchExistsOnRemote(cacheDir, techLead)) {
    onLine(`[git] origin/${techLead} não encontrada — criando a partir da default…\n`);
    let fallback = findFallbackRemoteBranch(cacheDir);

    if (!fallback) {
      onLine(`[git] repo sem branches remotas — bootstrap local…\n`);
      const tmpInit = cacheDir + "-init-tmp";
      const remoteUrl = gitExec(["remote", "get-url", "origin"], { cwd: cacheDir }).trim();
      try {
        if (fs.existsSync(tmpInit)) fs.rmSync(tmpInit, { recursive: true, force: true });
        gitExec(["clone", remoteUrl, tmpInit]);
        gitExec(["checkout", "-B", "main"], { cwd: tmpInit });
        const readmePath = path.join(tmpInit, "README.md");
        if (!fs.existsSync(readmePath)) {
          fs.writeFileSync(readmePath, `# Projeto\n`, "utf-8");
          gitExec(["add", "README.md"], { cwd: tmpInit });
        }
        try {
          gitExec(["commit", "-m", "initial commit"], { cwd: tmpInit });
        } catch { /* nothing to commit — repo already has content */ }
        try {
          gitExec(["push", "-u", "origin", "main"], { cwd: tmpInit });
        } catch { /* already up to date */ }
        onLine(`[git] commit inicial pushed → main\n`);
      } finally {
        if (fs.existsSync(tmpInit)) fs.rmSync(tmpInit, { recursive: true, force: true });
      }
      gitExec(["fetch", "origin"], { cwd: cacheDir });
      fallback = findFallbackRemoteBranch(cacheDir);
      if (!fallback) {
        throw new Error(`Nenhuma branch remota disponível para criar ${techLead} (após bootstrap)`);
      }
    }

    gitExec(["branch", techLead, fallback], { cwd: cacheDir });
    gitExec(["push", "origin", techLead], { cwd: cacheDir });
    gitExec(["fetch", "origin"], { cwd: cacheDir });
  }

  onLine(`[git] actualizando ${techLead} local com origin…\n`);
  try {
    gitExec(["branch", "-f", techLead, `origin/${techLead}`], { cwd: cacheDir });
  } catch {
    // branch pode não existir localmente ainda
    try {
      gitExec(["branch", techLead, `origin/${techLead}`], { cwd: cacheDir });
    } catch { /* já existe, ignore */ }
  }

  const remoteBranchExists = branchExistsOnRemote(cacheDir, branch);

  if (!fs.existsSync(codeDir)) {
    removeTaskWorktreeIfRegistered(cacheDir, codeDir, branch, onLine);
    fs.mkdirSync(path.dirname(codeDir), { recursive: true });
    if (remoteBranchExists) {
      onLine(`[git] worktree ${branch} (remote existe)…\n`);
      worktreeAddWithRecovery(
        cacheDir,
        codeDir,
        branch,
        ["-B", branch, codeDir, `origin/${branch}`],
        onLine
      );
      onLine(`[git] merge origin/${techLead} na task branch…\n`);
      try {
        gitExec(["merge", `origin/${techLead}`, "--no-edit"], { cwd: codeDir });
      } catch {
        onLine(`[git] reset para origin/${techLead} (conflito, recriando branch)…\n`);
        gitExec(["reset", "--hard", `origin/${techLead}`], { cwd: codeDir });
      }
    } else {
      onLine(`[git] worktree ${branch} from origin/${techLead}…\n`);
      worktreeAddWithRecovery(
        cacheDir,
        codeDir,
        branch,
        ["-B", branch, codeDir, `origin/${techLead}`],
        onLine
      );
    }
  } else {
    onLine(`[git] worktree existente em ${codeDir}\n`);
    try {
      gitExec(["checkout", branch], { cwd: codeDir });
      if (remoteBranchExists) {
        try {
          gitExec(["merge", "--ff-only", `origin/${branch}`], { cwd: codeDir });
        } catch {
          onLine(`[git] reset para origin/${branch} (divergiu)…\n`);
          gitExec(["reset", "--hard", `origin/${branch}`], { cwd: codeDir });
        }
      }
      onLine(`[git] merge origin/${techLead} na task branch…\n`);
      try {
        gitExec(["merge", `origin/${techLead}`, "--no-edit"], { cwd: codeDir });
      } catch {
        onLine(`[git] reset para origin/${techLead} (conflito, recriando)…\n`);
        gitExec(["reset", "--hard", `origin/${techLead}`], { cwd: codeDir });
      }
    } catch {
      onLine(`[git] recriar worktree…\n`);
      ensureTaskWorkspace(
        project,
        taskId,
        { ...opts, forceRecreate: true },
        onLine
      );
      return codeDir;
    }
  }

  const sha = gitExec(["rev-parse", "--short", "HEAD"], { cwd: codeDir });
  onLine(`[git] Base da task: ${techLead} @ ${sha}\n`);
  return codeDir;
}

/**
 * Recria worktrees de tasks em curso após troca de repositório remoto.
 * @param {string} project
 * @param {{ techLeadBranch?: string, token?: string }} opts
 * @param {(line: string) => void} [onLine]
 * @param {string} [logPrefix]
 */
export function realignOpenTaskWorkspaces(
  project,
  opts = {},
  onLine = () => {},
  logPrefix = "[git]"
) {
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

  const openTasks = tasksState.filter((t) => t?.id && t.status !== "done");
  if (openTasks.length === 0) return;

  onLine(
    `${logPrefix} realinhar ${openTasks.length} task(s) em curso…\n`
  );
  for (const t of openTasks) {
    ensureTaskWorkspace(
      project,
      t.id,
      { ...opts, forceRecreate: true },
      onLine
    );
  }
}
