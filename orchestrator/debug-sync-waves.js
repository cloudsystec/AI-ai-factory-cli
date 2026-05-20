/**
 * Depuração rápida de ondas (sem agentes).
 * Uso: node orchestrator/debug-sync-waves.js <projeto> <macro-id>
 */
import path from "node:path";
import { syncTaskDeliveryFlags } from "./micro-delivery.js";

const project = process.argv[2];
const macroId = process.argv[3];

if (!project || !macroId) {
  console.error("Uso: node orchestrator/debug-sync-waves.js <projeto> <macro-id>");
  process.exit(1);
}

const microPath = path.join("workspaces", project, "scopes", "micro", `${macroId}.micro.json`);
const backlogPath = path.join("workspaces", project, "backlog", `${project}.tasks.json`);

const { openMicro, micros } = syncTaskDeliveryFlags({
  microPath,
  backlogPath,
  project,
  macroId,
});

console.log("\n=== syncTaskDeliveryFlags ===\n");
console.log("Micro open:", openMicro ? `${openMicro.id} — ${openMicro.title}` : "(nenhum)");
console.log("\nPor micro (aprovados com onda):");
for (const m of micros.filter((x) => x.taskDeliveryStatus)) {
  console.log(`  ${m.id}: ${m.taskDeliveryStatus}`);
}
