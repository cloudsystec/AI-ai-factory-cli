import fs from "node:fs";
import path from "node:path";
import { backFetch } from "./back-client.js";

/**
 * @param {string} tenantRoot
 */
export async function syncTenantAgentsToDisk(tenantRoot) {
  const res = await backFetch("/worker/tenant-config/agents");
  const data = await res.json();
  const files = data.files || {};

  fs.mkdirSync(path.join(tenantRoot, "agents"), { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    const normalized = relativePath.replace(/\\/g, "/");
    const dest = path.join(tenantRoot, normalized);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
  }

  return Object.keys(files).length;
}
