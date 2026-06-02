import fs from "node:fs";
import path from "node:path";
import {
  fetchAllFilteredUsageEvents,
  eventTimestampMs,
  cursorEventKey,
  normalizeCursorChargeToCents,
} from "./cursor-admin-api.js";
import { computePreviewFromPrompt } from "./billing-preview.js";
import { createLogger } from "./logger.js";

const log = createLogger("billing");

export { cursorEventKey };

/**
 * Contexto útil para logs no Docker (worker vs subprocesso do job).
 * @param {string} [jobId]
 */
function billingLogContext(jobId) {
  const jid = (jobId || process.env.AI_FACTORY_JOB_ID || "").trim() || null;
  const sessionPath = getBillingSessionPath(jid || undefined);
  return {
    pid: process.pid,
    jobId: jid || "(ausente)",
    sessionPath: sessionPath || "(ausente)",
    sessionExists: sessionPath ? fs.existsSync(sessionPath) : false,
    backUrl: process.env.BACK_URL?.trim() ? "ok" : "ausente",
    usageEmail: process.env.CURSOR_USAGE_EMAIL?.trim() || "(ausente)",
  };
}

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
const RECONCILE_PASS2_DELAY_MS = Number(
  process.env.BILLING_RECONCILE_PASS2_DELAY_MS || 10_000
);

/** @type {Set<string>} */
const CONFIRMED_CHARGE_SOURCES = new Set(["cursor_admin_api"]);

/**
 * @param {string[]} sources
 */
export function aggregateJobChargeSource(sources) {
  const list = sources.filter(Boolean);
  if (list.length === 0) return "estimate";
  if (list.every((s) => CONFIRMED_CHARGE_SOURCES.has(s))) return "cursor_admin_api";
  if (list.some((s) => s === "estimate_reconcile" || s === "estimate_error"))
    return "estimate_reconcile";
  if (list.some((s) => s === "token_preview")) return "token_preview";
  if (list.some((s) => s.startsWith("estimate"))) return "estimate";
  if (list.some((s) => s === "pending")) return "pending";
  if (list.some((s) => s === "fee_minimum")) return "fee_minimum";
  if (list.every((s) => s === "skipped")) return "skipped";
  return "estimate";
}

/**
 * @param {string} source
 */
export function isChargeConfirmed(source) {
  return CONFIRMED_CHARGE_SOURCES.has(source);
}

/** @type {Map<string, object>} */
const activeCalls = new Map();
/** @type {Promise[]} */
const pendingSettlements = [];

let signalHandlersInstalled = false;
let backClientPromise = null;

async function getBackClient() {
  if (!process.env.BACK_URL?.trim()) return null;
  if (!backClientPromise) {
    backClientPromise = import("./back-client.js");
  }
  return backClientPromise;
}

/**
 * @param {string} fn
 * @param {(...args: unknown[]) => Promise<unknown>} call
 */
/**
 * @param {string} fn
 * @param {(...args: unknown[]) => Promise<unknown>} call
 * @param {string} [jobId]
 */
async function syncToBack(fn, call, jobId) {
  const ctx = billingLogContext(jobId);
  if (!process.env.BACK_URL?.trim()) {
    log.warn(`Sync back ignorado (${fn}): BACK_URL não definido`, ctx);
    return false;
  }
  log.info(`Sync back início → ${fn}`, ctx);
  try {
    const mod = await getBackClient();
    if (!mod) {
      log.warn(`Sync back falhou (${fn}): módulo back-client indisponível`, ctx);
      return false;
    }
    await call(mod);
    log.info(`Sync back ok ✓ ${fn}`, ctx);
    return true;
  } catch (e) {
    log.warn(`Sync back erro ✗ ${fn}`, {
      ...ctx,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

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
 * @param {object[]} events
 * @param {Set<string>} [consumedKeys]
 */
function availableEvents(events, consumedKeys) {
  if (!consumedKeys?.size) return events;
  return events.filter((ev) => !consumedKeys.has(cursorEventKey(ev)));
}

/**
 * @param {object[]} clusterEvents
 */
function keysFromEvents(clusterEvents) {
  return clusterEvents.map((ev) => ({
    key: cursorEventKey(ev),
    eventTimestampMs: eventTimestampMs(ev),
    chargedCents: normalizeCursorChargeToCents(ev.chargedCents),
  }));
}

/**
 * Match chamadas locais a eventos Cursor por timestamp mais próximo (+ cluster).
 * @param {object[]} calls
 * @param {object[]} events — já filtrados
 * @param {{
 *   maxMatchDeltaMs?: number,
 *   callClusterMs?: number,
 *   estimatePerCallUsd?: number,
 *   consumedKeys?: Set<string>,
 *   includeOrphans?: boolean,
 *   estimateOnUnmatch?: boolean,
 *   singleEventOnly?: boolean,
 * }} [opts]
 */
export function matchCallsToUsageEvents(calls, events, opts = {}) {
  const maxDelta = opts.maxMatchDeltaMs ?? MAX_MATCH_DELTA_MS;
  const singleEventOnly = opts.singleEventOnly === true;
  const clusterMs = singleEventOnly
    ? 0
    : (opts.callClusterMs ?? CALL_CLUSTER_MS);
  const estimateUsd = opts.estimatePerCallUsd ?? DEFAULT_PER_CALL_USD;
  const includeOrphans = opts.includeOrphans === true;
  const estimateOnUnmatch = opts.estimateOnUnmatch === true;

  const pool = availableEvents(events, opts.consumedKeys);
  const sortedCalls = [...calls].sort(
    (a, b) => (a.endedAtMs ?? a.startedAtMs) - (b.endedAtMs ?? b.startedAtMs)
  );

  const usedEventIndices = new Set();
  const matched = [];
  const batchConsumedKeys = new Set(opts.consumedKeys || []);

  for (const call of sortedCalls) {
    const anchorMs = call.endedAtMs ?? call.startedAtMs ?? Date.now();
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < pool.length; i++) {
      if (usedEventIndices.has(i)) continue;
      const ts = eventTimestampMs(pool[i]);
      if (!Number.isFinite(ts)) continue;
      const dist = Math.abs(ts - anchorMs);
      if (dist <= maxDelta && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) {
      const cents = estimateOnUnmatch ? Math.round(estimateUsd * 100) : 0;
      matched.push({
        callId: call.id,
        agentFile: call.agentFile,
        agentName: call.agentName,
        startedAtMs: call.startedAtMs,
        endedAtMs: call.endedAtMs,
        unmatched: true,
        costUsd: estimateOnUnmatch ? estimateUsd : 0,
        chargedCents: cents,
        cursorEventCount: 0,
        cursorEventKeys: [],
        matchDeltaMs: null,
      });
      continue;
    }

    const clusterIndices = [bestIdx];
    if (!singleEventOnly && clusterMs > 0) {
      const pivotTs = eventTimestampMs(pool[bestIdx]);
      for (let i = 0; i < pool.length; i++) {
        if (i === bestIdx || usedEventIndices.has(i)) continue;
        const ts = eventTimestampMs(pool[i]);
        if (!Number.isFinite(ts)) continue;
        if (Math.abs(ts - pivotTs) <= clusterMs) {
          clusterIndices.push(i);
        }
      }
    }

    const clusterEvents = clusterIndices.map((i) => pool[i]);
    let cents = 0;
    for (const idx of clusterIndices) {
      usedEventIndices.add(idx);
      cents += normalizeCursorChargeToCents(pool[idx].chargedCents);
    }

    const eventKeys = keysFromEvents(clusterEvents);
    for (const k of eventKeys) batchConsumedKeys.add(k.key);

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
      cursorEventKeys: eventKeys,
      matchDeltaMs: bestDist,
    });
  }

  let orphanCents = 0;
  let orphanCount = 0;
  if (includeOrphans) {
    for (let i = 0; i < pool.length; i++) {
      if (usedEventIndices.has(i)) continue;
      orphanCents += normalizeCursorChargeToCents(pool[i].chargedCents);
      orphanCount += 1;
    }
  }

  const callsCents = matched.reduce((s, m) => s + (m.chargedCents || 0), 0);
  const totalCents = callsCents + orphanCents;

  return {
    matched,
    orphanCents,
    orphanCount,
    consumedKeys: batchConsumedKeys,
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
  if (!sessionPath) {
    log.warn("JSONL billing: não gravado (sem jobId / TENANT_ROOT)", {
      ...billingLogContext(),
      recordType: record.type,
      callId: record.callId,
    });
    return;
  }
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.appendFileSync(sessionPath, `${JSON.stringify(record)}\n`, "utf-8");
  log.debug("JSONL billing: linha gravada", {
    type: record.type,
    callId: record.callId,
    path: sessionPath,
  });
}

/**
 * @param {string} jobId
 */
function readSessionLines(jobId) {
  const sessionPath = getBillingSessionPath(jobId);
  if (!sessionPath || !fs.existsSync(sessionPath)) return [];
  const lines = fs.readFileSync(sessionPath, "utf-8").split(/\r?\n/);
  /** @type {object[]} */
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
  return rows;
}

/**
 * Resumo da sessão JSONL sem efeitos secundários (para logs do worker).
 * @param {string} jobId
 */
export function describeBillingSession(jobId) {
  const sessionPath = getBillingSessionPath(jobId);
  const lines =
    sessionPath && fs.existsSync(sessionPath) ? readSessionLines(jobId) : [];
  const callIds = new Set();
  for (const row of lines) {
    if (row.callId) callIds.add(row.callId);
  }
  return {
    sessionPath: sessionPath || null,
    exists: Boolean(sessionPath && fs.existsSync(sessionPath)),
    lineCount: lines.length,
    callCount: callIds.size,
    callIds: [...callIds],
  };
}

/**
 * @param {string} jobId
 * @returns {Set<string>}
 */
export function loadConsumedEventKeysFromSession(jobId) {
  const keys = new Set();
  for (const row of readSessionLines(jobId)) {
    if (row.type === "call_settled" && Array.isArray(row.cursorEventKeys)) {
      for (const k of row.cursorEventKeys) {
        if (typeof k === "string") keys.add(k);
        else if (k?.key) keys.add(k.key);
      }
    }
  }
  return keys;
}

/**
 * @param {string} jobId
 * @param {{ botEmail?: string, sinceMs?: number, untilMs?: number }} [opts]
 */
export async function loadConsumedEventKeys(jobId, opts = {}) {
  const keys = loadConsumedEventKeysFromSession(jobId);
  const botEmail = opts.botEmail || process.env.CURSOR_USAGE_EMAIL?.trim();
  if (botEmail && opts.sinceMs != null && opts.untilMs != null) {
    await syncToBack(
      "GET consumed-keys",
      async (mod) => {
        const remote = await mod.fetchConsumedBillingKeys({
          botEmail,
          sinceMs: opts.sinceMs,
          untilMs: opts.untilMs,
        });
        for (const k of remote.keys || []) keys.add(k);
      },
      jobId
    );
  }
  return keys;
}

/**
 * @param {string} jobId
 */
export function loadCallsFromSession(jobId) {
  const lines = readSessionLines(jobId);
  /** @type {Map<string, object>} */
  const byId = new Map();

  for (const row of lines) {
    if (row.type === "call_started") {
      byId.set(row.callId, {
        id: row.callId,
        agentFile: row.agentFile,
        agentName: row.agentName,
        meta: row.meta || {},
        startedAtMs: row.startedAtMs,
        endedAtMs: row.endedAtMs ?? null,
      });
    }
    if (row.type === "call_preview") {
      const existing = byId.get(row.callId) || {
        id: row.callId,
        agentFile: row.agentFile,
        agentName: row.agentName,
        meta: row.meta || {},
        startedAtMs: row.startedAtMs,
        endedAtMs: row.endedAtMs ?? null,
      };
      existing.preview = row;
      existing.previewCostBaseUsd = row.costBaseUsd;
      existing.previewTokens = row.estimatedTokens;
      byId.set(row.callId, existing);
    }
    if (row.type === "call_settled") {
      const existing = byId.get(row.callId) || {
        id: row.callId,
        agentFile: row.agentFile,
        agentName: row.agentName,
        meta: row.meta || {},
        startedAtMs: row.startedAtMs,
        endedAtMs: row.endedAtMs,
      };
      existing.endedAtMs = row.endedAtMs ?? existing.endedAtMs;
      existing.settled = row;
      byId.set(row.callId, existing);
    }
  }

  for (const call of activeCalls.values()) {
    if (!byId.has(call.id)) {
      byId.set(call.id, { ...call });
    }
  }

  const result = [...byId.values()];
  const sessionPath = getBillingSessionPath(jobId);
  const lineCount = readSessionLines(jobId).length;
  log.info("Sessão billing lida", {
    ...billingLogContext(jobId),
    lineCount,
    callCount: result.length,
    callIds: result.map((c) => c.id).join(",") || "(nenhuma)",
  });
  return result;
}

/**
 * @param {string} jobId
 */
export function loadOpenCalls(jobId) {
  return loadCallsFromSession(jobId).filter((c) => {
    const settled = c.settled;
    if (!settled) return true;
    return (
      settled.source === "pending" ||
      (Number(settled.costBaseUsd) || 0) === 0
    );
  });
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
 *   prompt?: string,
 * }} opts
 * @returns {string} callId
 */
export function recordAiCallStart(opts) {
  const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  const preview = computePreviewFromPrompt(opts.prompt);
  const record = {
    id: callId,
    agentFile: opts.agentFile,
    agentName: opts.agentName ?? null,
    meta: opts.meta || {},
    startedAtMs,
    endedAtMs: null,
    skipped: opts.skipped === true,
    previewCostBaseUsd: preview.costBaseUsd,
    previewTokens: preview.estimatedTokens,
  };
  activeCalls.set(callId, record);

  appendSessionLine({
    type: "call_started",
    callId,
    agentFile: opts.agentFile,
    agentName: opts.agentName ?? null,
    meta: opts.meta || {},
    startedAtMs,
  });

  if (preview.costBaseUsd > 0) {
    publishCallTokenPreview(record, preview);
  }

  const jobId = process.env.AI_FACTORY_JOB_ID?.trim();
  log.info("Chamada IA iniciada (billing)", {
    ...billingLogContext(jobId),
    callId,
    agent: opts.agentName || opts.agentFile,
    previewTokens: preview.estimatedTokens,
    previewCostUsd: preview.costBaseUsd,
    skipped: record.skipped,
  });
  if (jobId) {
    void syncToBack(
      "POST register-call",
      (mod) =>
        mod.registerBillingCall(jobId, {
          callId,
          agentFile: opts.agentFile,
          agentName: opts.agentName,
          startedAtMs,
          meta: opts.meta || {},
          botEmail: process.env.CURSOR_USAGE_EMAIL?.trim() || undefined,
          previewCostBaseUsd: preview.costBaseUsd,
          previewTokens: preview.estimatedTokens,
          previewSource: preview.costBaseUsd > 0 ? "token_preview" : undefined,
        }),
      jobId
    );
  } else {
    log.warn("Sync register-call omitido: AI_FACTORY_JOB_ID ausente", {
      callId,
      ...billingLogContext(),
    });
  }
  return callId;
}

/**
 * Prévia local por tokens (sem API Cursor).
 * @param {object} call
 * @param {{ estimatedTokens: number, costBaseUsd: number }} preview
 */
function publishCallTokenPreview(call, preview) {
  appendSessionLine({
    type: "call_preview",
    callId: call.id,
    agentFile: call.agentFile,
    agentName: call.agentName,
    meta: call.meta || {},
    startedAtMs: call.startedAtMs,
    estimatedTokens: preview.estimatedTokens,
    costBaseUsd: preview.costBaseUsd,
    source: "token_preview",
    previewedAt: new Date().toISOString(),
  });

  log.debug("Prévia de tokens publicada", {
    callId: call.id,
    tokens: preview.estimatedTokens,
    cost: `$${preview.costBaseUsd.toFixed(6)}`,
  });
}

/**
 * @param {object} call
 */
function fallbackPreviewSettlement(call) {
  const previewCb = Number(call.previewCostBaseUsd) || 0;
  return {
    costBaseUsd: previewCb,
    chargedCents: 0,
    source: previewCb > 0 ? "token_preview" : "pending",
    cursorEventKeys: [],
    matchDeltaMs: null,
  };
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
      cursorEventKeys: [],
    });
    activeCalls.delete(callId);
    return Promise.resolve(settlement);
  }

  const promise = finalizeCallEnd(call);
  pendingSettlements.push(promise);
  return promise;
}

/**
 * Fecha chamada no back; match Cursor fica a cargo do poller no back.
 * @param {object} call
 */
async function finalizeCallEnd(call) {
  const jobId = process.env.AI_FACTORY_JOB_ID?.trim();
  const botEmail = process.env.CURSOR_USAGE_EMAIL?.trim() || undefined;
  const endedAtMs = call.endedAtMs || Date.now();

  appendSessionLine({
    type: "call_ended",
    callId: call.id,
    agentFile: call.agentFile,
    agentName: call.agentName,
    startedAtMs: call.startedAtMs,
    endedAtMs,
    previewCostBaseUsd: call.previewCostBaseUsd,
    endedAt: new Date().toISOString(),
  });

  if (jobId) {
    await syncToBack(
      `PATCH end-call/${call.id}`,
      (mod) =>
        mod.endBillingCall(jobId, call.id, {
          endedAtMs,
          botEmail,
        }),
      jobId
    );
  } else {
    log.warn("Sync end-call omitido: AI_FACTORY_JOB_ID ausente", {
      callId: call.id,
      ...billingLogContext(),
    });
  }

  log.info("Chamada encerrada (poller fará settle Cursor)", {
    ...billingLogContext(jobId),
    callId: call.id,
    endedAtMs,
    botEmail: botEmail || "(ausente)",
  });

  activeCalls.delete(call.id);
  return { callId: call.id, endedAtMs };
}

/**
 * @param {object} call
 * @param {{
 *   costBaseUsd: number,
 *   chargedCents: number,
 *   source: string,
 *   cursorEventKeys?: Array<string|{ key: string, eventTimestampMs: number, chargedCents: number }>,
 *   matchDeltaMs?: number|null,
 * }} result
 */
function writeCallSettlement(call, result) {
  const durationMs = (call.endedAtMs || Date.now()) - call.startedAtMs;
  const normalizedKeys = (result.cursorEventKeys || []).map((k) =>
    typeof k === "string"
      ? { key: k, eventTimestampMs: 0, chargedCents: 0 }
      : k
  );

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
    cursorEventKeys: normalizedKeys.map((k) => k.key),
    cursorEventClaims: normalizedKeys,
    matchDeltaMs: result.matchDeltaMs ?? null,
    syncedToDb: false,
    settledAt: new Date().toISOString(),
  };

  appendSessionLine(settlement);

  const jobId = process.env.AI_FACTORY_JOB_ID?.trim();
  const botEmail = process.env.CURSOR_USAGE_EMAIL?.trim();
  log.info("Call settled (JSONL)", {
    ...billingLogContext(jobId),
    callId: call.id,
    agent: settlement.agent,
    task: settlement.task,
    step: settlement.step,
    costUsd: result.costBaseUsd.toFixed(4),
    source: result.source,
    cursorKeys: normalizedKeys.length,
    durationSec: `${(durationMs / 1000).toFixed(1)}s`,
  });
  if (jobId) {
    void syncToBack(
      `PATCH settle-call/${call.id}`,
      async (mod) => {
        await mod.settleBillingCall(jobId, call.id, {
          endedAtMs: call.endedAtMs,
          costBaseUsd: result.costBaseUsd,
          source: result.source,
          matchDeltaMs: result.matchDeltaMs ?? null,
          status:
            result.source === "pending"
              ? "pending"
              : result.source === "token_preview"
                ? "estimated"
                : result.source === "estimate_reconcile"
                  ? "estimated"
                  : "settled",
          botEmail,
          cursorEventKeys: normalizedKeys,
        });
        settlement.syncedToDb = true;
      },
      jobId
    );
  } else {
    log.warn("Sync settle-call omitido: AI_FACTORY_JOB_ID ausente", {
      callId: call.id,
      ...billingLogContext(),
    });
  }

  return settlement;
}

/**
 * Soma billing do job a partir da BD (poller no back faz match Cursor).
 * @param {string} jobId
 * @param {{ startedMs?: number, finishedMs?: number, email?: string }} [_opts]
 */
export async function reconcileJobBilling(jobId, _opts = {}) {
  await flushPendingSettlements();

  log.info("Billing job: resumo via back", { ...billingLogContext(jobId) });

  try {
    const mod = await getBackClient();
    if (!mod) {
      return { totalCostBaseUsd: 0, callCount: 0, chargeSource: "pending" };
    }
    const summary = await mod.getJobBillingSummary(jobId);
    appendSessionLine({
      type: "job_reconciled",
      jobId,
      totalCostBaseUsd: summary.totalCostBaseUsd,
      chargeSource: summary.chargeSource,
      callCount: summary.callCount,
      openCount: summary.openCount,
      reconciledAt: new Date().toISOString(),
    });
    log.info("Billing job: resumo obtido", {
      jobId,
      totalCostBaseUsd: summary.totalCostBaseUsd,
      chargeSource: summary.chargeSource,
      callCount: summary.callCount,
      openCount: summary.openCount,
    });
    return {
      totalCostBaseUsd: Number(summary.totalCostBaseUsd) || 0,
      callCount: summary.callCount || 0,
      chargeSource: summary.chargeSource || "pending",
    };
  } catch (e) {
    log.warn("Billing job: resumo back falhou", {
      jobId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { totalCostBaseUsd: 0, callCount: 0, chargeSource: "pending" };
  }
}

export async function flushPendingSettlements() {
  if (pendingSettlements.length === 0) return;
  log.info("Flush: aguardando settlements pendentes", {
    ...billingLogContext(),
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
 */
export function readJobBillingTotal(jobId) {
  const lines = readSessionLines(jobId);
  const reconciled = lines.find((r) => r.type === "job_reconciled");
  if (reconciled) {
    return {
      totalCostBaseUsd: Number(reconciled.totalCostBaseUsd) || 0,
      callCount: reconciled.callCount || 0,
    };
  }

  let total = 0;
  let callCount = 0;
  for (const row of lines) {
    if (row.type === "call_settled") {
      total += Number(row.costBaseUsd) || 0;
      callCount += 1;
    }
    if (row.type === "round_settled") {
      total += Number(row.totalCostBaseUsd) || 0;
      callCount += row.callCount || 0;
    }
  }

  return {
    totalCostBaseUsd: Math.round(total * 1_000_000) / 1_000_000,
    callCount,
  };
}

/**
 * @param {string} jobId
 */
export function clearBillingSession(jobId) {
  const sessionPath = getBillingSessionPath(jobId);
  if (sessionPath && fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
    return sessionPath;
  }
  return null;
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
