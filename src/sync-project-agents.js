import fs from "node:fs";
import path from "node:path";
import { backFetch } from "./back-client.js";

/**
 * Sincroniza prompts do projeto para workspaces/<slug>/agents e AGENTS.md.
 * @param {string} tenantRoot
 * @param {string} projectSlug
 */
export async function syncProjectAgentsToDisk(tenantRoot, projectSlug) {
  const res = await backFetch(
    `/worker/projects/${encodeURIComponent(projectSlug)}/agents`
  );
  const data = await res.json();
  const files = data.files || {};

  const wsRoot = path.join(tenantRoot, "workspaces", projectSlug);
  fs.mkdirSync(path.join(wsRoot, "agents"), { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    const normalized = relativePath.replace(/\\/g, "/");
    const dest =
      normalized === "AGENTS.md"
        ? path.join(wsRoot, "AGENTS.md")
        : path.join(wsRoot, normalized);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
  }

  return Object.keys(files).length;
}
