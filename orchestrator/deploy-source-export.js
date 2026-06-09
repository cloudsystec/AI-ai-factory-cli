import fs from "node:fs";
import path from "node:path";
import {
  copyDeployTreeFiltered,
  DEPLOY_EXCLUDE_DIRS,
} from "./deploy-workspace-filter.js";
import { exportExistingCodeTree } from "./git/provision-repo.js";

export const DEPLOY_PREVIEW_DIR = ".deploy-preview";

/** Paths que nunca existem no repo deploy (sync exclui estas pastas). */
export const DEPLOY_FORBIDDEN_PATH_FRAGMENTS = [
  "tasks/",
  "tasks\\",
  "agents/",
  "reports/",
  "scopes/",
  "backlog/",
  ".git-cache/",
  "node_modules/",
];

/**
 * @param {string} wsRoot
 * @param {string} [sourceBranch]
 */
export function prepareDeploySourceExport(wsRoot, sourceBranch = "tech-lead") {
  const previewDir = path.join(wsRoot, DEPLOY_PREVIEW_DIR);
  if (fs.existsSync(previewDir)) {
    fs.rmSync(previewDir, { recursive: true, force: true });
  }
  fs.mkdirSync(previewDir, { recursive: true });

  const cacheDir = path.join(wsRoot, ".git-cache");
  if (fs.existsSync(cacheDir)) {
    const branch = exportExistingCodeTree(cacheDir, previewDir, {
      techLeadBranch: sourceBranch,
      defaultBranch: "main",
    });
    if (branch) {
      return { dir: previewDir, branch, from: "git-cache" };
    }
  }

  copyDeployTreeFiltered(wsRoot, previewDir);
  return { dir: previewDir, branch: sourceBranch, from: "workspace-filtered" };
}

/**
 * @param {string} rel
 * @param {string} treeRoot
 * @param {string} [artifactRoot]
 */
function resolvePathInDeployTree(rel, treeRoot, artifactRoot) {
  const normalized = rel.replace(/\/$/, "").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return treeRoot;
  for (const root of [treeRoot, artifactRoot]) {
    if (!root) continue;
    const abs = path.join(root, normalized);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/**
 * @param {string} dockerfilePath
 * @param {string} treeRoot — árvore tech-lead (ex.: .deploy-preview ou subpasta)
 * @param {string} [artifactRoot] — workspace com Dockerfile, docker/, etc.
 */
export function validateDeployDockerfileForTree(
  dockerfilePath,
  treeRoot,
  artifactRoot = null
) {
  if (!fs.existsSync(dockerfilePath)) {
    throw new Error("Dockerfile ausente");
  }
  const content = fs.readFileSync(dockerfilePath, "utf8");
  const normalized = content.replace(/\\/g, "/");

  for (const fragment of DEPLOY_FORBIDDEN_PATH_FRAGMENTS) {
    const needle = fragment.replace(/\\/g, "/");
    if (normalized.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(
        `Dockerfile referencia "${fragment.trim()}" — no repo deploy só entra código da branch tech-lead na raiz (sem tasks/, agents/, etc.). ` +
          "Use COPY a partir de ficheiros na raiz do preview (.deploy-preview/)."
      );
    }
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:COPY|ADD)\s+(\S+)\s+/i);
    if (!m) continue;
    const src = m[1];
    if (src.startsWith("--")) continue;

    if (src.endsWith("/") || (!src.includes(".") && !src.includes("*"))) {
      const rel = src.replace(/\/$/, "").replace(/^\.\//, "");
      if (!rel || rel === ".") continue;
      if (!resolvePathInDeployTree(rel, treeRoot, artifactRoot)) {
        throw new Error(
          `Dockerfile ${trimmed.split(/\s+/)[0]} ${src} — não existe no preview nem nos artefactos de deploy`
        );
      }
      continue;
    }

    const rel = src.replace(/^\.\//, "");
    if (!resolvePathInDeployTree(rel, treeRoot, artifactRoot)) {
      throw new Error(
        `Dockerfile ${trimmed.split(/\s+/)[0]} ${src} — ficheiro não existe no preview nem nos artefactos de deploy`
      );
    }
  }
}

/**
 * Lista árvore do preview (até 2 níveis) para prompts de correção.
 * @param {string} previewDir
 * @param {number} [maxDepth]
 */
export function describeDeployPreviewDetail(previewDir, maxDepth = 2) {
  if (!fs.existsSync(previewDir)) return "(preview vazio)";

  /** @type {string[]} */
  const lines = [];

  /**
   * @param {string} dir
   * @param {string} prefix
   * @param {number} depth
   */
  function walk(dir, prefix, depth) {
    if (depth > maxDepth) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (DEPLOY_EXCLUDE_DIRS.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      lines.push(ent.isDirectory() ? `${rel}/` : rel);
      if (ent.isDirectory() && depth < maxDepth) {
        walk(path.join(dir, ent.name), rel, depth + 1);
      }
    }
  }

  walk(previewDir, "", 0);
  return lines.length ? lines.slice(0, 80).join("\n") : "(sem ficheiros)";
}

/**
 * Lista top-level do preview (para prompt do agente).
 * @param {string} previewDir
 */
export function describeDeployPreviewTree(previewDir) {
  if (!fs.existsSync(previewDir)) return "(preview vazio)";
  const names = fs.readdirSync(previewDir).filter((n) => !DEPLOY_EXCLUDE_DIRS.has(n));
  return names.length ? names.join(", ") : "(sem ficheiros na raiz)";
}
