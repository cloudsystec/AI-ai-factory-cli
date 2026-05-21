/**
 * Consulta Cursor Admin API (filtered-usage-events) e imprime resumo.
 * Uso: node scripts/fetch-cursor-usage.js [--days 7] [--email x@y.com]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "../src/repo-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRoot();

dotenv.config();
const tenantId = process.env.TENANT_ID;
if (!tenantId) {
  console.error("Defina TENANT_ID ou execute a partir do worker com .env do tenant.");
  process.exit(1);
}
dotenv.config({
  path: path.join(repoRoot, "data", "tenants", tenantId, ".env"),
  override: true,
});

const {
  fetchAllFilteredUsageEvents,
  sumChargedUsdInWindow,
} = await import("../src/cursor-admin-api.js");

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] || 7);
const emailArg = process.argv.find((a) => a.startsWith("--email="))?.split("=")[1];
const email = emailArg || process.env.CURSOR_USAGE_EMAIL;

const end = Date.now();
const start = end - days * 24 * 60 * 60 * 1000;

const { events, period } = await fetchAllFilteredUsageEvents({
  startDate: start,
  endDate: end,
  email: email || undefined,
});

const summary = sumChargedUsdInWindow(events, {
  startMs: start,
  endMs: end,
  email: email || undefined,
});

console.log(JSON.stringify({ period, summary, sampleCount: events.length }, null, 2));
