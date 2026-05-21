import fs from "node:fs";
import path from "node:path";
import {
  fetchAllFilteredUsageEvents,
  eventTimestampMs,
} from "./cursor-admin-api.js";

const DEFAULT_PER_CALL_USD = Number(
  process.env.BILLING_CB_ESTIMATE_PER_CALL || 0.05
);
const MAX_MATCH_DELTA_MS = Number(
  process.env.BILLING_MAX_MATCH_DELTA_MS || 120_000
);
const CALL_CLUSTER_MS = Number(process.env.BILLING_CALL_CLUSTER_MS || 30_000);
const START_BUFFER_MS = Number(
  process.env.CURSOR_USAGE_START_BUFFER_MS || 120_000
);
const END_BUFFER_MS = Number(process.env.CURSOR_USAGE_END_BUFFER_MS || 60_000);

/** @type {{ roundId: string, kind: string, label?: string, meta?: object, startedAtMs: number, calls: object[] } | null} */
let currentRound = null;

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

/**
 * @param {{ kind: string, label?: string, meta?: object }} opts
 */
export function beginBillingRound(opts) {
  if (currentRound) {
    endBillingRoundSync({ status: "interrupted", reason: "nova_rodada" });
  }
  const roundId = `round-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  currentRound = {
    roundId,
    kind: opts.kind,
    label: opts.label,
    meta: opts.meta ?? {},
    startedAtMs: Date.now(),
    calls: [],
  };
  return roundId;
}

/**
 * @param {{ agentFile: string, agentName?: string, skipped?: boolean }} opts
 * @returns {string} callId
 */
export function recordAiCallStart(opts) {
  const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id: callId,
    agentFile: opts.agentFile,
    agentName: opts.agentName ?? null,
    startedAtMs: Date.now(),
    endedAtMs: null,
    skipped: opts.skipped === true,
  };
  if (currentRound) {
    currentRound.calls.push(record);
  }
  return callId;
}

/**
 * @param {string} callId
 */
export function recordAiCallEnd(callId) {
  if (!currentRound) return;
  const call = currentRound.calls.find((c) => c.id === callId);
  if (call) {
    call.endedAtMs = Date.now();
  }
}

/**
 * Liquidação síncrona (sem API) — uso interno ao trocar rodada.
 * @param {{ status: string, reason?: string }} opts
 */
function endBillingRoundSync(opts) {
  if (!currentRound) return null;
  const round = currentRound;
  currentRound = null;
  const settlement = {
    type: "round_settled",
    roundId: round.roundId,
    kind: round.kind,
    label: round.label,
    status: opts.status,
    reason: opts.reason,
    callCount: round.calls.length,
    totalCostBaseUsd: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    source: "empty",
    settledAt: new Date().toISOString(),
  };
  appendSessionLine(settlement);
  console.log(
    `[billing-round] ${round.kind} status=${opts.status} chamadas=0 CB=$0.0000`
  );
  return settlement;
}

/**
 * @param {{ status?: string, headlessOnly?: boolean }} [opts]
 */
export async function endBillingRound(opts = {}) {
  const status = opts.status || "completed";
  if (!currentRound) {
    return null;
  }

  const round = currentRound;
  currentRound = null;

  const calls = round.calls.filter((c) => !c.skipped);
  const email =
    process.env.CURSOR_USAGE_EMAIL?.trim() || undefined;
  const headlessOnly = opts.headlessOnly === true;

  if (calls.length === 0) {
    const settlement = {
      type: "round_settled",
      roundId: round.roundId,
      kind: round.kind,
      label: round.label,
      status,
      callCount: 0,
      totalCostBaseUsd: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      orphanCents: 0,
      source: "empty",
      settledAt: new Date().toISOString(),
    };
    appendSessionLine(settlement);
    console.log(
      `[billing-round] ${round.kind} status=${status} chamadas=0 CB=$0.0000`
    );
    return settlement;
  }

  const roundStartMs = Math.min(...calls.map((c) => c.startedAtMs));
  const roundEndMs = Math.max(
    ...calls.map((c) => c.endedAtMs ?? c.startedAtMs)
  );
  const queryStart = roundStartMs - START_BUFFER_MS;
  const queryEnd = roundEndMs + END_BUFFER_MS;

  let matchResult;
  let source = "estimate";

  try {
    const { events, source: apiSource } = await fetchAllFilteredUsageEvents({
      startDate: queryStart,
      endDate: queryEnd,
      email,
    });

    if (apiSource === "cursor_admin_api" && events.length > 0) {
      const filtered = filterUsageEvents(events, { email, headlessOnly });
      matchResult = matchCallsToUsageEvents(calls, filtered, {});
      source = "cursor_admin_api";
    } else {
      matchResult = {
        matched: calls.map((c) => ({
          callId: c.id,
          agentFile: c.agentFile,
          unmatched: true,
          costUsd: DEFAULT_PER_CALL_USD,
          chargedCents: Math.round(DEFAULT_PER_CALL_USD * 100),
        })),
        orphanCents: 0,
        orphanCount: 0,
        totalCostBaseUsd:
          Math.round(calls.length * DEFAULT_PER_CALL_USD * 1_000_000) /
          1_000_000,
        matchedCount: 0,
        unmatchedCount: calls.length,
      };
      source = "estimate";
    }
  } catch (e) {
    matchResult = {
      matched: calls.map((c) => ({
        callId: c.id,
        agentFile: c.agentFile,
        unmatched: true,
        costUsd: DEFAULT_PER_CALL_USD,
        chargedCents: Math.round(DEFAULT_PER_CALL_USD * 100),
      })),
      orphanCents: 0,
      orphanCount: 0,
      totalCostBaseUsd:
        Math.round(calls.length * DEFAULT_PER_CALL_USD * 1_000_000) /
        1_000_000,
      matchedCount: 0,
      unmatchedCount: calls.length,
    };
    source = "estimate";
    console.warn(
      `[billing-round] falha Admin API: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const totalCostBaseUsd = Math.max(0.01, matchResult.totalCostBaseUsd);

  const settlement = {
    type: "round_settled",
    roundId: round.roundId,
    kind: round.kind,
    label: round.label,
    status,
    callCount: calls.length,
    totalCostBaseUsd,
    matchedCount: matchResult.matchedCount,
    unmatchedCount: matchResult.unmatchedCount,
    orphanCents: matchResult.orphanCents,
    orphanCount: matchResult.orphanCount,
    source,
    queryStart,
    queryEnd,
    calls: matchResult.matched,
    settledAt: new Date().toISOString(),
  };

  appendSessionLine(settlement);

  console.log(
    `[billing-round] ${round.kind} status=${status} chamadas=${calls.length} matched=${matchResult.matchedCount} unmatched=${matchResult.unmatchedCount} CB=$${totalCostBaseUsd.toFixed(4)} (${source})`
  );

  return settlement;
}

/**
 * @param {string} jobId
 * @returns {{ totalCostBaseUsd: number, roundCount: number }}
 */
export function readJobBillingTotal(jobId) {
  const sessionPath = getBillingSessionPath(jobId);
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { totalCostBaseUsd: 0, roundCount: 0 };
  }

  const lines = fs.readFileSync(sessionPath, "utf-8").split(/\r?\n/);
  let total = 0;
  let roundCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "round_settled") {
        total += Number(row.totalCostBaseUsd) || 0;
        roundCount += 1;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    totalCostBaseUsd: Math.round(total * 1_000_000) / 1_000_000,
    roundCount,
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

export function getOpenBillingRound() {
  return currentRound;
}

export function installBillingSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const onSignal = async (sig) => {
    if (currentRound) {
      try {
        await endBillingRound({ status: "interrupted" });
      } catch (e) {
        console.warn(
          `[billing] settle on ${sig}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  };

  process.on("SIGINT", () => {
    onSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    onSignal("SIGTERM");
  });
}
