import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do repo CLI (`orchestrator/` na raiz deste repo). */
export function resolveRepoRoot() {
  const candidates = [
    process.env.AI_FACTORY_CLI_ROOT,
    path.resolve(__dirname, ".."),
  ].filter(Boolean);

  for (const root of candidates) {
    const resolved = path.resolve(root);
    if (fs.existsSync(path.join(resolved, "orchestrator"))) {
      return resolved;
    }
  }

  throw new Error(
    "orchestrator/ não encontrado na raiz do repo CLI (defina AI_FACTORY_CLI_ROOT se necessário)"
  );
}

export const REPO_ROOT = resolveRepoRoot();

/**
 * @param {string} orchestratorFile ex. dashboard-job-runner.js
 */
export function orchestratorImport(orchestratorFile) {
  const abs = path.join(REPO_ROOT, "orchestrator", orchestratorFile);
  return import(pathToFileURL(abs).href);
}
