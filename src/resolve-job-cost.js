import {
  fetchAllFilteredUsageEvents,
  getCursorAdminApiKey,
  sumChargedUsdInWindow,
} from "./cursor-admin-api.js";
import { createLogger } from "./logger.js";

const log = createLogger("cost");

const DEFAULT_CB = Number(process.env.BILLING_CB_ESTIMATE_USD || 0.0);
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

  const jobDurationSec = ((finishedMs - startedMs) / 1000).toFixed(1);
  log.debug(`Resolvendo custo do job`, { email: email || "—", jobDurationSec: `${jobDurationSec}s` });

  if (!getCursorAdminApiKey()) {
    log.debug(`CURSOR_ADMIN_API_KEY ausente, usando estimativa`, { defaultCB: DEFAULT_CB });
    return {
      costBaseUsd: DEFAULT_CB,
      source: "estimate",
      detail: { reason: "CURSOR_ADMIN_API_KEY ausente" },
    };
  }

  const queryStart = startedMs - START_BUFFER_MS;
  const queryEnd = finishedMs + END_BUFFER_MS;
  const fetchStartMs = Date.now();

  try {
    const { events } = await fetchAllFilteredUsageEvents({
      startDate: queryStart,
      endDate: queryEnd,
      email,
    });
    const fetchElapsedMs = Date.now() - fetchStartMs;

    log.debug(`Eventos Cursor buscados`, {
      count: events.length,
      fetchMs: fetchElapsedMs,
      windowMs: queryEnd - queryStart,
    });

    const summary = sumChargedUsdInWindow(events, {
      startMs: startedMs,
      endMs: finishedMs,
      email,
      headlessOnly: opts.headlessOnly === true,
    });

    if (summary.eventCount === 0) {
      log.debug(`Nenhum evento na janela, usando estimativa`, { defaultCB: DEFAULT_CB });
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

    log.debug(`Custo resolvido via Admin API`, {
      CB: `$${summary.costBaseUsd.toFixed(4)}`,
      events: summary.eventCount,
    });

    return {
      costBaseUsd: summary.costBaseUsd,
      source: "cursor_admin_api",
      detail: {
        ...summary,
        queryStart,
        queryEnd,
        email: email ?? null,
      },
    };
  } catch (e) {
    log.warn(`Falha Cursor Admin API`, { error: e instanceof Error ? e.message : String(e), defaultCB: DEFAULT_CB });
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
