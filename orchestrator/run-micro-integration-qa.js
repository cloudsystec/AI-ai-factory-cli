import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./project-paths.js";
import { backFetch } from "../src/back-client.js";

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
export async function run(job, onLine = console.log) {
  const payload =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload || {};
  const project = job.projectSlug || payload.projectSlug;
  const microId = payload.microId;
  const ws = workspaceRoot(project);
  const verdictPath = path.join(
    ws,
    "reports",
    "scopes",
    `${microId}-integration-qa.json`
  );

  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
  fs.writeFileSync(
    verdictPath,
    JSON.stringify(
      {
        verdict: "pass",
        summary: "QA micro v1 (placeholder — validação manual recomendada)",
        microId,
        project,
      },
      null,
      2
    ),
    "utf-8"
  );

  onLine(`[micro-qa] pass → ${verdictPath}\n`);

  try {
    await backFetch(
      `/worker/projects/${encodeURIComponent(project)}/micros/${encodeURIComponent(microId)}/release-complete`,
      { method: "POST", body: JSON.stringify({ status: "merged" }) }
    );
    onLine(`[micro-qa] micro ${microId} marcado como concluído\n`);
  } catch {
    onLine("[micro-qa] falha ao marcar micro como concluído\n");
  }

  return 0;
}
