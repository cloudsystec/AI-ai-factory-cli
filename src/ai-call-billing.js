import fs from "node:fs";
import path from "node:path";
import {
  fetchAllFilteredUsageEvents,
  eventTimestampMs,
} from "./cursor-admin-api.js";
import { createLogger } from "./logger.js";

const log = createLogger("billing");

const DEFAULT_PER_CALL_USD = Number(
  process.env.BILLING_CB_ESTIMATE_PER_CALL || 0.0
);
const MAX_MATCH_DELTA_MS = Number(
  process.env.BILLING_MAX_MATCH_DELTA_MS || 120_000
);
const CALL_CLUSTER_MS = Number(process.env.BILLING_CALL_CLUSTER_MS || 30_000);
const START_BUFFER_MS = Number(
  process.env.CURSOR_USAGE_START_BUFFER_MS || 120_000
);
const END_BUFFER_MS = Number(process.env.CURSOR_USAGE_END_BUFFER_MS || 60_000);
const CALL_SETTLE_DELAY_MS = Number(
  process.env.BILLING_CALL_SETTLE_DELAY_MS || 15_000
);

/** @type {Map<string, object>} */
const activeCalls = new Map();
/** @type {Promise[]} */
const pendingSettlements = [];

let signalHandlersInstalled = false;

/**
 * @param {object} ev
 * @param {{ email?: string, headlessOnly?: boolean }} filter
 */
function eventPassesFilter(ev, filter) {
  if (ev.isChargeable === false) return false;
  if (filter.email && ev.userEmail && ev.userEmail !== filter.email) {
    return false;
  }
  if (filter.headlessOnly && ev.isHeadless !== true) return false;
  return true;
}

/**
 * @param {object[]} events
 * @param {{ email?: string, headlessOnly?: boolean }} filter
 */
export function filterUsageEvents(events, filter) {
  return events.filter((ev) => eventPassesFilter(ev, filter));
}

/**
 * Match chamadas locais a eventos Cursor por timestamp mais próximo (+ cluster).
 * @param {object[]} calls
 * @param {object[]} events — já filtrados
 * @param {{ maxMatchDeltaMs?: number, callClusterMs?: number, estimatePerCallUsd?: number }} [opts]
 */
export function matchCallsToUsageEvents(calls, events, opts = {}) {
  const maxDelta = opts.maxMatchDeltaMs ?? MAX_MATCH_DELTA_MS;
  const clusterMs = opts.callClusterMs ?? CALL_CLUSTER_MS;
  const estimateUsd = opts.estimatePerCallUsd ?? DEFAULT_PER_CALL_USD;

  const sortedCalls = [...calls].sort(
    (a, b) => (a.endedAtMs ?? a.startedAtMs) - (b.endedAtMs ?? b.startedAtMs)
  );

  const usedEventIndices = new Set();
  const matched = [];

  for (const call of sortedCalls) {
    const anchorMs = call.endedAtMs ?? call.startedAtMs ?? Date.now();
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < events.length; i++) {
      if (usedEventIndices.has(i)) continue;
      const ts = eventTimestampMs(events[i]);
      if (!Number.isFinite(ts)) continue;
      const dist = Math.abs(ts - anchorMs);
      if (dist <= maxDelta && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) {
      matched.push({
        callId: call.id,
        agentFile: call.agentFile,
        agentName: call.agentName,
        startedAtMs: call.startedAtMs,
        endedAtMs: call.endedAtMs,
        unmatched: true,
        costUsd: estimateUsd,
        chargedCents: Math.round(estimateUsd * 100),
        cursorEventCount: 0,
        matchDeltaMs: null,
      });
      continue;
    }

    const clusterIndices = [bestIdx];
    const pivotTs = eventTimestampMs(events[bestIdx]);

    for (let i = 0; i < events.length; i++) {
      if (i === bestIdx || usedEventIndices.has(i)) continue;
      const ts = eventTimestampMs(events[i]);
      if (!Number.isFinite(ts)) continue;
      if (Math.abs(ts - pivotTs) <= clusterMs) {
        clusterIndices.push(i);
      }
    }

    let cents = 0;
    for (const idx of clusterIndices) {
      usedEventIndices.add(idx);
      cents += Number(events[idx].chargedCents) || 0;
    }

    matched.push({
      callId: call.id,
      agentFile: call.agentFile,
      agentName: call.agentName,
      startedAtMs: call.startedAtMs,
      endedAtMs: call.endedAtMs,
      unmatched: false,
      costUsd: Math.round((cents / 100) * 1_000_000) / 1_000_000,
      chargedCents: cents,
      cursorEventCount: clusterIndices.length,
      matchDeltaMs: bestDist,
    });
  }

  let orphanCents = 0;
  let orphanCount = 0;
  for (let i = 0; i < events.length; i++) {
    if (usedEventIndices.has(i)) continue;
    orphanCents += Number(events[i].chargedCents) || 0;
    orphanCount += 1;
  }

  const callsCents = matched.reduce((s, m) => s + (m.chargedCents || 0), 0);
  const totalCents = callsCents + orphanCents;

  return {
    matched,
    orphanCents,
    orphanCount,
    totalCostBaseUsd: Math.round((totalCents / 100) * 1_000_000) / 1_000_000,
    matchedCount: matched.filter((m) => !m.unmatched).length,
    unmatchedCount: matched.filter((m) => m.unmatched).length,
  };
}

/**
 * @param {string} [jobId]
 */
export function getBillingSessionPath(jobId) {
  const id = jobId || process.env.AI_FACTORY_JOB_ID?.trim();
  if (!id) return null;
  const dir =
    process.env.AI_FACTORY_BILLING_SESSION_DIR?.trim() ||
    (process.env.AI_FACTORY_TENANT_ROOT
      ? path.join(process.env.AI_FACTORY_TENANT_ROOT, "billing-sessions")
      : null);
  if (!dir) return null;
  return path.join(dir, `${id}.jsonl`);
}

/**
 * @param {object} record
 */
function appendSessionLine(record) {
  const sessionPath = getBillingSessionPath();
  if (!sessionPath) return;
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.appendFileSync(sessionPath, `${JSON.stringify(record)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
//  Per-call billing
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   agentFile: string,
 *   agentName?: string,
 *   skipped?: boolean,
 *   meta?: { project?: string, task?: string, step?: string, [k: string]: unknown },
 * }} opts
 * @returns {string} callId
 */
export function recordAiCallStart(opts) {
  const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id: callId,
    agentFile: opts.agentFile,
    agentName: opts.agentName ?? null,
    meta: opts.meta || {},
    startedAtMs: Date.now(),
    endedAtMs: null,
    skipped: opts.skipped === true,
  };
  activeCalls.set(callId, record);
  log.debug("AI call registada", {
    callId,
    agent: opts.agentName || opts.agentFile,
    ...record.meta,
    skipped: record.skipped,
  });
  return callId;
}

/**
 * @param {string} callId
 */
export function recordAiCallEnd(callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  call.endedAtMs = Date.now();
  const durationMs = call.endedAtMs - call.startedAtMs;
  log.debug("AI call finalizada", {
    callId,
    agent: call.agentName || call.agentFile,
    durationMs,
    durationSec: `${(durationMs / 1000).toFixed(1)}s`,
  });
}

/**
 * Inicia settlement assíncrono de uma chamada individual.
 * Fire-and-forget: retorna Promise mas pode não ser awaited.
 * @param {string} callId
 */
export function settleAiCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return Promise.resolve(null);

  if (call.skipped) {
    const settlement = writeCallSettlement(call, {
      costBaseUsd: 0,
      chargedCents: 0,
      source: "skipped",
      cursorEventCount: 0,
    });
    activeCalls.delete(callId);
    return Promise.resolve(settlement);
  }

  const promise = settleCallAsync(call);
  pendingSettlements.push(promise);
  return promise;
}

/**
 * @param {object} call
 */
async function settleCallAsync(call) {
  if (CALL_SETTLE_DELAY_MS > 0) {
    log.debug("Aguardando propagação Cursor API", {
      callId: call.id,
      delayMs: CALL_SETTLE_DELAY_MS,
    });
    await new Promise((r) => setTimeout(r, CALL_SETTLE_DELAY_MS));
  }

  const email = process.env.CURSOR_USAGE_EMAIL?.trim() || undefined;
  const queryStart = call.startedAtMs - START_BUFFER_MS;
  const queryEnd = (call.endedAtMs || Date.now()) + END_BUFFER_MS;

  try {
    const { events, source: apiSource } = await fetchAllFilteredUsageEvents({
      startDate: queryStart,
      endDate: queryEnd,
      email,
    });

    log.debug("Eventos Cursor para call", {
      callId: call.id,
      agent: call.agentName || call.agentFile,
      apiSource,
      totalEvents: events.length,
    });

    if (apiSource === "cursor_admin_api" && events.length > 0) {
      const filtered = filterUsageEvents(events, { email });
      const matchResult = matchCallsToUsageEvents([call], filtered, {});
      const match = matchResult.matched[0];

      const totalCents =
        (match?.chargedCents || 0) + (matchResult.orphanCents || 0);
      const costBaseUsd =
        Math.round((totalCents / 100) * 1_000_000) / 1_000_000;

      const settlement = writeCallSettlement(call, {
        costBaseUsd,
        chargedCents: totalCents,
        source: "cursor_admin_api",
        cursorEventCount:
          (match?.cursorEventCount || 0) + (matchResult.orphanCount || 0),
        matchDeltaMs: match?.matchDeltaMs ?? null,
      });
      activeCalls.delete(call.id);
      return settlement;
    }

    const settlement = writeCallSettlement(call, {
      costBaseUsd: DEFAULT_PER_CALL_USD,
      chargedCents: Math.round(DEFAULT_PER_CALL_USD * 100),
      source: "estimate",
      cursorEventCount: 0,
    });
    activeCalls.delete(call.id);
    return settlement;
  } catch (e) {
    log.warn("Settlement falhou", {
      callId: call.id,
      error: e instanceof Error ? e.message : String(e),
    });
    const settlement = writeCallSettlement(call, {
      costBaseUsd: DEFAULT_PER_CALL_USD,
      chargedCents: Math.round(DEFAULT_PER_CALL_USD * 100),
      source: "estimate_error",
      cursorEventCount: 0,
    });
    activeCalls.delete(call.id);
    return settlement;
  }
}

/**
 * @param {object} call
 * @param {{ costBaseUsd: number, chargedCents: number, source: string, cursorEventCount: number, matchDeltaMs?: number|null }} result
 */
function writeCallSettlement(call, result) {
  const durationMs = (call.endedAtMs || Date.now()) - call.startedAtMs;
  const settlement = {
    type: "call_settled",
    callId: call.id,
    agent: call.agentName || call.agentFile,
    agentFile: call.agentFile,
    project: call.meta.project || null,
    task: call.meta.task || null,
    step: call.meta.step || null,
    meta: call.meta,
    startedAtMs: call.startedAtMs,
    endedAtMs: call.endedAtMs,
    durationMs,
    costBaseUsd: result.costBaseUsd,
    chargedCents: result.chargedCents,
    source: result.source,
    cursorEventCount: result.cursorEventCount,
    matchDeltaMs: result.matchDeltaMs ?? null,
    settledAt: new Date().toISOString(),
  };

  appendSessionLine(settlement);

  log.debug("Call settled", {
    callId: call.id,
    agent: settlement.agent,
    task: settlement.task || "—",
    step: settlement.step || "—",
    cost: `$${result.costBaseUsd.toFixed(4)}`,
    source: result.source,
    durationSec: `${(durationMs / 1000).toFixed(1)}s`,
  });

  return settlement;
}

/**
 * Aguarda todas as liquidações pendentes (fire-and-forget) antes de sair.
 */
export async function flushPendingSettlements() {
  if (pendingSettlements.length === 0) return;
  log.debug("Flush: aguardando settlements pendentes", {
    count: pendingSettlements.length,
  });
  const results = await Promise.allSettled(pendingSettlements);
  pendingSettlements.length = 0;
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    log.warn("Flush: alguns settlements falharam", { failed: failed.length });
  }
}

/**
 * @param {string} jobId
 * @returns {{ totalCostBaseUsd: number, callCount: number }}
 */
export function readJobBillingTotal(jobId) {
  const sessionPath = getBillingSessionPath(jobId);
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { totalCostBaseUsd: 0, callCount: 0 };
  }

  const lines = fs.readFileSync(sessionPath, "utf-8").split(/\r?\n/);
  let total = 0;
  let callCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "call_settled") {
        total += Number(row.costBaseUsd) || 0;
        callCount += 1;
      }
      if (row.type === "round_settled") {
        total += Number(row.totalCostBaseUsd) || 0;
        callCount += row.callCount || 0;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    totalCostBaseUsd: Math.round(total * 1_000_000) / 1_000_000,
    callCount,
  };
}

/**
 * Remove ficheiro de sessão (opcional, ao iniciar job no worker).
 * @param {string} jobId
 */
export function clearBillingSession(jobId) {
  const sessionPath = getBillingSessionPath(jobId);
  if (sessionPath && fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

export function installBillingSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const onSignal = async (sig) => {
    try {
      await flushPendingSettlements();
    } catch (e) {
      log.warn(`Billing flush on ${sig}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  };

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
