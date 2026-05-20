import fs from "node:fs";
import path from "node:path";

/**
 * Lê o arquivo de backlog normalizando para `{ project, macroId, tasks }`.
 * Suporta legado em que o arquivo é um array de tasks.
 *
 * @param {string} backlogPath
 * @param {{ project?: string, macroId?: string }} defaults
 * @returns {{ project: string, macroId: string, tasks: object[], updatedAt?: string|null }}
 */
export function readBacklogFile(backlogPath, defaults = {}) {
  const project = defaults.project ?? "";
  const macroId = defaults.macroId ?? "";

  if (!fs.existsSync(backlogPath)) {
    return {
      project,
      macroId,
      tasks: [],
      updatedAt: null,
    };
  }

  const raw = JSON.parse(
    fs.readFileSync(backlogPath, "utf-8").replace(/^\uFEFF/, "")
  );

  if (Array.isArray(raw)) {
    console.warn(
      `[backlog-io] Formato legado (array raiz) em ${backlogPath}. Considere migrar para { project, macroId, tasks }.`
    );
    return {
      project,
      macroId,
      tasks: raw,
      updatedAt: null,
    };
  }

  return {
    project: raw.project ?? project,
    macroId: raw.macroId ?? macroId,
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    updatedAt: raw.updatedAt ?? null,
  };
}

/**
 * @param {string} backlogPath
 * @param {{ project: string, macroId: string, tasks: object[], updatedAt?: string|null }} doc
 */
export function writeBacklogFile(backlogPath, doc) {
  const out = {
    project: doc.project,
    macroId: doc.macroId,
    updatedAt: doc.updatedAt ?? new Date().toISOString(),
    tasks: doc.tasks,
  };
  fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
  fs.writeFileSync(backlogPath, JSON.stringify(out, null, 2), "utf-8");
}
