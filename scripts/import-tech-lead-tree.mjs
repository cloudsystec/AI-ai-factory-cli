/**
 * Importa árvore local → branch tech-lead do repo managed do projecto.
 * Uso:
 *   AI_FACTORY_TENANT_ROOT=... AI_FACTORY_GITHUB_TOKEN=... \
 *     node scripts/import-tech-lead-tree.mjs <projectSlug> <sourceDir> [repoFullName]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pushImportedCodeTree } from "../orchestrator/git/provision-repo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const project = process.argv[2];
const sourceDir = process.argv[3]
  ? path.resolve(process.argv[3])
  : null;
const repoOverride = process.argv[4]?.trim() || null;

if (!project || !sourceDir) {
  console.error(
    "Uso: node scripts/import-tech-lead-tree.mjs <projectSlug> <sourceDir> [repoFullName]"
  );
  process.exit(1);
}

const token =
  process.env.AI_FACTORY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
if (!token) {
  console.error("Defina AI_FACTORY_GITHUB_TOKEN ou GITHUB_TOKEN");
  process.exit(1);
}

const tenantRoot = process.env.AI_FACTORY_TENANT_ROOT
  ? path.resolve(process.env.AI_FACTORY_TENANT_ROOT)
  : path.resolve(__dirname, "..", "data", "tenants", "a1111111-1111-4111-8111-111111111111");

process.env.AI_FACTORY_TENANT_ROOT = tenantRoot;

let repoFullName = repoOverride;
if (!repoFullName) {
  const fs = await import("node:fs");
  const cacheConfig = path.join(
    tenantRoot,
    "workspaces",
    project,
    ".git-cache",
    "config"
  );
  if (fs.existsSync(cacheConfig)) {
    const cfg = fs.readFileSync(cacheConfig, "utf8");
    const m = cfg.match(/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/m);
    if (m) repoFullName = m[1];
  }
}
if (!repoFullName) {
  console.error("repoFullName não detectado — passe como 3.º argumento");
  process.exit(1);
}

console.log(`[import] project=${project}`);
console.log(`[import] source=${sourceDir}`);
console.log(`[import] repo=${repoFullName} → tech-lead`);

pushImportedCodeTree(
  project,
  {
    repoFullName,
    techLeadBranch: "tech-lead",
    token,
  },
  sourceDir,
  (line) => process.stdout.write(line)
);

console.log("[import] concluído");
