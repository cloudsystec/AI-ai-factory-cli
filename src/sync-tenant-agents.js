import fs from "node:fs";
import path from "node:path";
import { backFetch } from "./back-client.js";

/**
 * @deprecated Use syncProjectAgentsToDisk(tenantRoot, projectSlug).
 * Compatibilidade com imagens antigas do worker (sync no startup → tenant/agents/).
 * @param {string} tenantRoot
 */
export async function syncTenantAgentsToDisk(tenantRoot) {
  console.warn(
    "[ai-factory-cli] syncTenantAgentsToDisk está obsoleto. Rebuild da imagem Docker (docker build -t ai-factory-cli:latest .)."
  );
  const res = await backFetch("/worker/tenant-config/agents");
  const data = await res.json();
  const files = data.files || {};

  fs.mkdirSync(path.join(tenantRoot, "agents"), { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    const normalized = relativePath.replace(/\\/g, "/");
    const dest =
      normalized === "AGENTS.md"
        ? path.join(tenantRoot, "AGENTS.md")
        : path.join(tenantRoot, normalized);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
  }

  return Object.keys(files).length;
}
