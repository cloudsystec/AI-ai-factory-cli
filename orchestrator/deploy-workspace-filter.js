import fs from "node:fs";
import path from "node:path";

/** @type {Set<string>} */
export const DEPLOY_EXCLUDE_DIRS = new Set([
  ".git",
  ".git-cache",
  ".deploy-sync",
  ".deploy-preview",
  ".git-import-tmp",
  ".git-provision-source",
  ".git-migrate-source",
  ".git-migrate-client",
  "agents",
  "tasks",
  "reports",
  "docs",
  "evidence",
  "node_modules",
  "backlog",
  "scopes",
]);

/** Pastas de artefactos gerados pelo agente (overlay completo). */
export const DEPLOY_ARTIFACT_DIRS = ["docker"];

/** Ficheiros gerados pelo agente deploy-railway (overlay sobre tech-lead). */
export const DEPLOY_ARTIFACT_FILES = [
  "Dockerfile",
  "Dockerfile.frontend",
  "Dockerfile.backend",
  "docker-compose.yml",
  "railway.json",
  ".env.example",
  ".dockerignore",
];

/**
 * @param {string} dir
 */
export function deployDirectoryHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DEPLOY_EXCLUDE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isFile()) return true;
    if (ent.isDirectory() && deployDirectoryHasFiles(full)) return true;
  }
  return false;
}

/**
 * @param {string} srcDir
 * @param {string} destRoot
 */
export function copyDeployTreeFiltered(srcDir, destRoot) {
  if (!fs.existsSync(srcDir)) return;
  const destRootAbs = path.resolve(destRoot);
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (DEPLOY_EXCLUDE_DIRS.has(ent.name)) continue;
    const src = path.join(srcDir, ent.name);
    const srcAbs = path.resolve(src);
    if (srcAbs === destRootAbs || destRootAbs.startsWith(srcAbs + path.sep)) {
      continue;
    }
    const dest = path.join(destRoot, ent.name);
    if (ent.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyDeployTreeFiltered(src, dest);
    } else if (ent.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Copia artefactos de deploy gerados no workspace (Dockerfile, docker/, etc.) para staging.
 * @param {string} wsRoot
 * @param {string} staging
 * @param {string[]} [extraFiles]
 */
export function overlayDeployArtifacts(wsRoot, staging, extraFiles = []) {
  const names = new Set([...DEPLOY_ARTIFACT_FILES, ...extraFiles]);
  for (const name of names) {
    if (!name || name.includes("..")) continue;
    const rel = String(name).replace(/\\/g, "/");
    const src = path.join(wsRoot, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dest = path.join(staging, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  for (const dir of DEPLOY_ARTIFACT_DIRS) {
    const srcDir = path.join(wsRoot, dir);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) continue;
    const destDir = path.join(staging, dir);
    fs.mkdirSync(destDir, { recursive: true });
    copyDeployTreeFiltered(srcDir, destDir);
    normalizeShellScriptsInDir(destDir);
  }
}

/**
 * Garante LF em scripts shell (CRLF no Windows quebra shebang no Linux).
 * @param {string} dir
 */
function normalizeShellScriptsInDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      normalizeShellScriptsInDir(full);
      continue;
    }
    if (!/\.(sh|bash)$/i.test(ent.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (!text.includes("\r")) continue;
    fs.writeFileSync(full, text.replace(/\r\n/g, "\n"), "utf8");
  }
}
