import {
  fetchAllFilteredUsageEvents,
  getCursorAdminApiKey,
  sumChargedUsdInWindow,
} from "./cursor-admin-api.js";

const DEFAULT_CB = Number(process.env.BILLING_CB_ESTIMATE_USD || 0.5);
const START_BUFFER_MS = Number(process.env.CURSOR_USAGE_START_BUFFER_MS || 120_000);
const END_BUFFER_MS = Number(process.env.CURSOR_USAGE_END_BUFFER_MS || 60_000);

/**
 * CB (USD) para completeJob: Cursor Admin API na janela do job ou estimativa.
 * @param {{
 *   startedMs: number,
 *   finishedMs?: number,
 *   email?: string,
 *   headlessOnly?: boolean,
 * }} opts
 */
export async function resolveJobCostBaseUsd(opts) {
  const finishedMs = opts.finishedMs ?? Date.now();
  const startedMs = opts.startedMs;
  const email =
    opts.email?.trim() ||
    process.env.CURSOR_USAGE_EMAIL?.trim() ||
    undefined;

  if (!getCursorAdminApiKey()) {
    return {
      costBaseUsd: DEFAULT_CB,
      source: "estimate",
      detail: { reason: "CURSOR_ADMIN_API_KEY ausente" },
    };
  }

  const queryStart = startedMs - START_BUFFER_MS;
  const queryEnd = finishedMs + END_BUFFER_MS;

  try {
    const { events } = await fetchAllFilteredUsageEvents({
      startDate: queryStart,
      endDate: queryEnd,
      email,
    });

    const summary = sumChargedUsdInWindow(events, {
      startMs: startedMs,
      endMs: finishedMs,
      email,
      headlessOnly: opts.headlessOnly === true,
    });

    if (summary.eventCount === 0) {
      return {
        costBaseUsd: DEFAULT_CB,
        source: "estimate",
        detail: {
          reason: "nenhum evento Cursor na janela do job",
          queryStart,
          queryEnd,
          email: email ?? null,
        },
      };
    }

    return {
      costBaseUsd: Math.max(0.01, summary.costBaseUsd),
      source: "cursor_admin_api",
      detail: {
        ...summary,
        queryStart,
        queryEnd,
        email: email ?? null,
      },
    };
  } catch (e) {
    return {
      costBaseUsd: DEFAULT_CB,
      source: "estimate",
      detail: {
        reason: "falha Cursor Admin API",
        error: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
