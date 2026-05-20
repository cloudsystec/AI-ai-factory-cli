import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do repo CLI (`orchestrator/` na raiz deste repo). */
export function resolveRepoRoot() {
  const root = path.resolve(__dirname, "..");
  if (!fs.existsSync(path.join(root, "orchestrator"))) {
    throw new Error("orchestrator/ não encontrado na raiz do repo CLI");
  }
  return root;
}

export const REPO_ROOT = resolveRepoRoot();

/**
 * @param {string} orchestratorFile ex. dashboard-job-runner.js
 */
export function orchestratorImport(orchestratorFile) {
  const abs = path.join(REPO_ROOT, "orchestrator", orchestratorFile);
  return import(pathToFileURL(abs).href);
}
