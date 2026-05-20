import fs from "node:fs";
import path from "node:path";
import { readBacklogFile } from "./backlog-io.js";

/**
 * @param {string} microPath
 * @returns {object[]}
 */
export function readMicrosFromPath(microPath) {
  if (!fs.existsSync(microPath)) return [];
  const raw = JSON.parse(
    fs.readFileSync(microPath, "utf-8").replace(/^\uFEFF/, "")
  );
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.microScopes)) return raw.microScopes;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

/**
 * @param {string} microPath
 * @param {object[]} micros
 */
export function writeMicrosToPath(microPath, micros) {
  fs.mkdirSync(path.dirname(microPath), { recursive: true });
  fs.writeFileSync(microPath, JSON.stringify(micros, null, 2), "utf-8");
}

/**
 * @param {object[]} micros
 */
export function sortApprovedMicros(micros) {
  const approved = micros.filter(
    (m) => m.approved === true && m.validationStatus === "approved"
  );
  return [...approved].sort((a, b) => {
    const pa = a.priority ?? 999999;
    const pb = b.priority ?? 999999;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Micro com todas as tasks em done (se não houver tasks, ainda não está "fechado" para onda).
 * @param {string} microId
 * @param {object[]} tasks
 */
export function isMicroDevClosed(microId, tasks) {
  const subset = tasks.filter((t) => t.sourceMicroId === microId);
  if (subset.length === 0) return false;
  return subset.every((t) => t.status === "done");
}

/**
 * Calcula onda atual (open/locked/closed) a partir de micros + tasks, **sem gravar** ficheiros.
 * @param {object[]} micros
 * @param {object[]} tasks
 * @returns {{ openMicro: object|undefined, deliveryStatusById: Map<string, string>, approvedSorted: object[] }}
 */
export function computeWaveDeliveryFromData(micros, tasks) {
  const sorted = sortApprovedMicros(micros);
  const deliveryStatusById = new Map();
  let assignedOpen = false;

  for (const m of sorted) {
    const closed = isMicroDevClosed(m.id, tasks);
    if (closed) {
      deliveryStatusById.set(m.id, "closed");
    } else if (!assignedOpen) {
      deliveryStatusById.set(m.id, "open");
      assignedOpen = true;
    } else {
      deliveryStatusById.set(m.id, "locked");
    }
  }

  const openMicro = sorted.find((m) => deliveryStatusById.get(m.id) === "open");
  return { openMicro, deliveryStatusById, approvedSorted: sorted };
}

/**
 * Atualiza `taskDeliveryStatus` em cada micro aprovado: locked | open | closed.
 * @param {{ microPath: string, backlogPath: string, project: string, macroId: string }} opts
 * @returns {{ micros: object[], openMicro: object|undefined }}
 */
export function syncTaskDeliveryFlags(opts) {
  const { microPath, backlogPath, project, macroId } = opts;
  if (!microPath || !backlogPath) {
    const keys = opts && typeof opts === "object" ? Object.keys(opts).join(", ") : String(opts);
    throw new Error(
      `syncTaskDeliveryFlags: microPath e backlogPath são obrigatórios (recebido: ${keys}). ` +
        "Use backlogPath, não backlogFile."
    );
  }
  const micros = readMicrosFromPath(microPath);
  const doc = readBacklogFile(backlogPath, { project, macroId });
  const tasks = doc.tasks;
  const { deliveryStatusById, openMicro } = computeWaveDeliveryFromData(micros, tasks);

  const updated = micros.map((micro) => {
    const st = deliveryStatusById.get(micro.id);
    if (!st) return micro;
    return { ...micro, taskDeliveryStatus: st };
  });

  writeMicrosToPath(microPath, updated);
  const openFromFile = updated.find((m) => m.taskDeliveryStatus === "open");
  return { micros: updated, openMicro: openFromFile ?? openMicro };
}

/**
 * @param {object[]} micros
 */
export function getOpenMicro(micros) {
  return micros.find((m) => m.taskDeliveryStatus === "open");
}
