/**
 * Migra micros/tasks existentes para QA no micro + task de fechamento.
 * Uso: node orchestrator/migrate-micro-qa.js <projeto> [macro-id]
 */
import fs from "node:fs";
import {
  backlogFile,
  isValidProjectSlug,
  microScopeFile,
  workspaceRoot,
} from "./project-paths.js";
import { readBacklogFile, writeBacklogFile } from "./backlog-io.js";
import { readMicrosFromPath, writeMicrosToPath } from "./micro-delivery.js";

const project = process.argv[2];
const macroIdArg = process.argv[3];

if (!project || !isValidProjectSlug(project)) {
  console.error("Uso: node orchestrator/migrate-micro-qa.js <projeto> [macro-id]");
  process.exit(1);
}

const backlogPath = backlogFile(project);
const doc = readBacklogFile(backlogPath, { project });
const macroId = macroIdArg || doc.macroId || project;
const microPath = microScopeFile(project, macroId);

function nextTaskId(existingIds) {
  let n = 1;
  while (existingIds.has(`TASK-${String(n).padStart(3, "0")}`)) n += 1;
  return `TASK-${String(n).padStart(3, "0")}`;
}

const micros = readMicrosFromPath(microPath);
const normalizedMicros = micros.map((micro) => ({
  ...micro,
  acceptance: Array.isArray(micro.acceptance)
    ? micro.acceptance
    : typeof micro.acceptance === "string" && micro.acceptance.trim()
      ? [micro.acceptance.trim()]
      : [],
  testStrategy:
    typeof micro.testStrategy === "string" && micro.testStrategy.trim()
      ? micro.testStrategy.trim()
      : micro.testStrategy || `npm test --prefix workspaces/${project}`,
}));

writeMicrosToPath(microPath, normalizedMicros);
console.log(`Micros atualizados: ${microPath}`);

let tasks = [...doc.tasks];
let changed = false;

for (const micro of normalizedMicros) {
  const microTasks = tasks.filter((t) => t.sourceMicroId === micro.id);
  if (microTasks.length === 0) continue;

  const existingIds = new Set(tasks.map((t) => t.id));
  let closers = microTasks.filter((t) => t.isMicroCloser === true);
  const nonCloser = microTasks.filter((t) => t.isMicroCloser !== true);

  if (closers.length > 1) {
    const keep = closers.find((t) => t.status !== "done") || closers[0];
    tasks = tasks.map((t) => {
      if (t.sourceMicroId === micro.id && t.isMicroCloser && t.id !== keep.id) {
        changed = true;
        const { isMicroCloser, ...rest } = t;
        return rest;
      }
      return t;
    });
    closers = [keep];
  }

  if (closers.length === 0) {
    const closerId = nextTaskId(existingIds);
    existingIds.add(closerId);
    tasks.push({
      id: closerId,
      project,
      sourceMicroId: micro.id,
      title: `Integração e validação QA — ${micro.title || micro.id}`,
      description: `Consolidar e validar o incremento integrado do micro "${micro.title || micro.id}".`,
      acceptance: [],
      dependencies: nonCloser.map((t) => t.id),
      isMicroCloser: true,
      status: "pending_validation",
      approved: false,
      validationStatus: "pending_validation",
      priority: Math.max(0, ...microTasks.map((t) => t.priority ?? 0)) + 1,
    });
    changed = true;
    console.log(`Closer criada para ${micro.id}: ${closerId}`);
  } else {
    const closer = closers[0];
    const expected = nonCloser.map((t) => t.id).sort().join(",");
    const actual = (Array.isArray(closer.dependencies) ? closer.dependencies : [])
      .sort()
      .join(",");
    if (expected !== actual) {
      tasks = tasks.map((t) =>
        t.id === closer.id ? { ...t, dependencies: nonCloser.map((x) => x.id) } : t
      );
      changed = true;
    }
  }
}

if (changed) {
  writeBacklogFile(backlogPath, {
    ...doc,
    tasks,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Backlog atualizado: ${backlogPath}`);
} else {
  console.log("Backlog já compatível — nenhuma alteração.");
}

console.log(`Workspace: ${workspaceRoot(project)}`);
