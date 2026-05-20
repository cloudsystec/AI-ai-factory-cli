import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimJob,
  completeJob,
  heartbeat,
  postLog,
  registerWorker,
} from "./back-client.js";
import { runJobLocally, REPO_ROOT } from "./run-job.js";
import { reportProjectDashboard } from "./report-dashboard.js";
import { syncTenantAgentsToDisk } from "./sync-tenant-agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} obrigatório`);
  return v;
}

const TENANT_ID = requireEnv("TENANT_ID");
const tenantRoot = path.join(REPO_ROOT, "data", "tenants", TENANT_ID);
process.env.AI_FACTORY_TENANT_ROOT = tenantRoot;
process.env.AI_FACTORY_WORKSPACES_DIR = path.join(tenantRoot, "workspaces");
process.env.AI_FACTORY_MACRO_DIR = path.join(tenantRoot, "scopes", "macro");
process.env.AI_FACTORY_AGENTS_DIR = path.join(tenantRoot, "agents");

const WORKER_ID = process.env.WORKER_ID || `cli-${TENANT_ID.slice(0, 8)}`;
const POLL_MS = Number(process.env.CLAIM_POLL_MS || 3000);

let running = false;

async function processOneJob(job) {
  running = true;
  try {
    await postLog(job.id, `Worker ${WORKER_ID} iniciou job ${job.kind}`);
    const result = await runJobLocally(job, (line) => {
      postLog(job.id, line).catch((e) =>
        console.error("log failed", e.message)
      );
    });
    await completeJob(job.id, {
      status: result.status,
      exitCode: result.exitCode,
      costBaseUsd: Number(process.env.BILLING_CB_ESTIMATE_USD || 0.5),
    });
    if (result.status === "succeeded" && job.projectSlug) {
      await reportProjectDashboard(job.projectSlug, {
        taskId: job.taskId || undefined,
      }).catch((e) =>
        console.warn("report dashboard:", e.message)
      );
    }
    await postLog(job.id, `Job finalizado: ${result.status}`);
  } catch (e) {
    console.error(e);
    try {
      await completeJob(job.id, {
        status: "failed",
        exitCode: 1,
      });
    } catch (e2) {
      console.error("complete failed", e2);
    }
  } finally {
    running = false;
  }
}

async function loop() {
  if (running) return;
  try {
    if (process.env.AGENT_SYNC_EACH_CLAIM === "true") {
      await syncTenantAgentsToDisk(tenantRoot).catch((e) =>
        console.warn("sync agents:", e.message)
      );
    }
    const job = await claimJob(WORKER_ID);
    if (job) {
      console.log("claimed", job.id, job.kind, job.projectSlug);
      await processOneJob(job);
    }
  } catch (e) {
    console.error("claim error", e.message);
  }
}

async function main() {
  console.log("CLI worker", { TENANT_ID, BACK_URL: process.env.BACK_URL, REPO_ROOT });
  const n = await syncTenantAgentsToDisk(tenantRoot);
  console.log(`Agent prompts sincronizados: ${n} ficheiros em ${tenantRoot}`);
  await registerWorker(WORKER_ID);
  setInterval(() => heartbeat().catch(() => {}), 30_000);
  setInterval(loop, POLL_MS);
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
