import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../project-paths.js";
import { gitExec } from "./git-exec.js";

/**
 * @param {string} srcDir
 * @param {string} destDir
 */
export function copyDirContents(srcDir, destDir) {
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
 */
function resolveBranchRef(cacheDir, branch) {
  if (localBranchExists(cacheDir, branch)) return branch;
  if (remoteBranchExists(cacheDir, branch)) return `origin/${branch}`;
  return null;
}

/**
 * @param {string} cacheDir
 * @param {string} branch
 * @param {string} destDir
 * @returns {boolean}
 */
export function exportBranchTree(cacheDir, branch, destDir) {
  const ref = resolveBranchRef(cacheDir, branch);
  if (!ref) return false;
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });
  gitExec(
    ["--git-dir", cacheDir, "--work-tree", destDir, "checkout", "-f", ref],
    {}
  );
  return true;
}

/**
 * Exporta código do bare cache (tech-lead → default → qualquer branch remota).
 * @param {string} cacheDir
 * @param {string} destDir
 * @param {{ techLeadBranch?: string, defaultBranch?: string }} [opts]
 * @returns {string|null} nome da branch exportada
 */
export function exportExistingCodeTree(cacheDir, destDir, opts = {}) {
  const techLead = opts.techLeadBranch || "tech-lead";
  const defaultBranch = opts.defaultBranch || "main";
  for (const branch of [techLead, defaultBranch]) {
    if (exportBranchTree(cacheDir, branch, destDir)) return branch;
  }
  const remote = findAnyRemoteBranch(cacheDir);
  if (!remote) return null;
  const name = remote.replace(/^origin\//, "");
  if (exportBranchTree(cacheDir, name, destDir)) return name;
  return null;
}

/**
 * Envia árvore exportada para tech-lead no repo remoto (ex.: managed após desconexão).
 * @param {string} project
 * @param {{ repoFullName: string, defaultBranch?: string, techLeadBranch?: string, token?: string }} git
 * @param {string} sourceTreeDir
 * @param {(line: string) => void} [onLine]
 */
export function pushImportedCodeTree(project, git, sourceTreeDir, onLine = () => {}) {
  if (!git?.token) {
    throw new Error("Token GitHub obrigatório para importar código no repo managed");
  }
  if (!fs.existsSync(sourceTreeDir)) return;

  const ws = workspaceRoot(project);
  const cacheDir = path.join(ws, ".git-cache");
  const techLead = git.techLeadBranch || "tech-lead";
  const remoteUrl = tokenRemoteUrl(git.repoFullName, git.token);
  const workDir = path.join(ws, ".git-import-tmp");

  try {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    onLine(
      `[git] importar código existente → ${git.repoFullName}:${techLead}…\n`
    );
    gitExec(["clone", remoteUrl, workDir]);
    gitExec(["checkout", "-B", techLead], { cwd: workDir });

    for (const name of fs.readdirSync(workDir)) {
      if (name === ".git") continue;
      fs.rmSync(path.join(workDir, name), { recursive: true, force: true });
    }
    copyDirContents(sourceTreeDir, workDir);

    gitExec(["add", "-A"], { cwd: workDir });
    try {
      gitExec(
        ["commit", "-m", `[provision] código existente integrado em ${techLead}`],
        { cwd: workDir }
      );
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes("nothing to commit")) throw e;
      onLine("[git] nada novo para commitar (conteúdo já igual)\n");
    }
    try {
      gitExec(["push", "-u", "origin", techLead], { cwd: workDir });
    } catch {
      onLine(`[git] push rejeitado — force-with-lease em ${techLead}…\n`);
      gitExec(["fetch", "origin"], { cwd: workDir });
      gitExec(["push", "-u", "--force-with-lease", "origin", techLead], {
        cwd: workDir,
      });
    }

    if (fs.existsSync(cacheDir)) {
      gitExec(["remote", "set-url", "origin", remoteUrl], { cwd: cacheDir });
      ensureBareRemoteTracking(cacheDir);
      gitExec(["fetch", "origin"], { cwd: cacheDir });
      if (localBranchExists(cacheDir, techLead)) {
        gitExec(["branch", "-f", techLead, `origin/${techLead}`], { cwd: cacheDir });
      } else {
        gitExec(["branch", techLead, `origin/${techLead}`], { cwd: cacheDir });
      }
    }
    onLine(`[git] código importado OK (${techLead})\n`);
  } finally {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

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
