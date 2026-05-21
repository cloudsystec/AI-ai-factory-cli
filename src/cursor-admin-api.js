const CURSOR_API_BASE = "https://api.cursor.com";

/**
 * @returns {string|null}
 */
export function getCursorAdminApiKey() {
  const key = process.env.CURSOR_ADMIN_API_KEY?.trim();
  return key || null;
}

/**
 * @param {string} apiKey
 */
function basicAuthHeader(apiKey) {
  const token = Buffer.from(`${apiKey}:`, "utf-8").toString("base64");
  return `Basic ${token}`;
}

/**
 * POST /teams/filtered-usage-events (uma página).
 * @param {{
 *   apiKey: string,
 *   startDate: number,
 *   endDate: number,
 *   page?: number,
 *   pageSize?: number,
 *   email?: string,
 * }} opts
 */
export async function fetchFilteredUsageEventsPage(opts) {
  const {
    apiKey,
    startDate,
    endDate,
    page = 1,
    pageSize = 100,
    email,
  } = opts;

  const body = { startDate, endDate, page, pageSize };
  if (email) body.email = email;

  const res = await fetch(`${CURSOR_API_BASE}/teams/filtered-usage-events`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cursor Admin API ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

/**
 * Todas as páginas no intervalo (máx. 30 dias).
 * @param {{
 *   startDate: number,
 *   endDate: number,
 *   email?: string,
 *   pageSize?: number,
 *   maxPages?: number,
 * }} opts
 */
export async function fetchAllFilteredUsageEvents(opts) {
  const apiKey = getCursorAdminApiKey();
  if (!apiKey) {
    return { events: [], source: "none", reason: "CURSOR_ADMIN_API_KEY ausente" };
  }

  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 120;
  const events = [];
  let page = 1;
  let hasNextPage = true;
  let period = null;

  while (hasNextPage && page <= maxPages) {
    const data = await fetchFilteredUsageEventsPage({
      apiKey,
      startDate: opts.startDate,
      endDate: opts.endDate,
      page,
      pageSize,
      email: opts.email,
    });
    if (data.period) period = data.period;
    if (Array.isArray(data.usageEvents)) {
      events.push(...data.usageEvents);
    }
    hasNextPage = data.pagination?.hasNextPage === true;
    page += 1;
  }

  return {
    events,
    period,
    totalUsageEventsCount: events.length,
    source: "cursor_admin_api",
  };
}

/**
 * @param {object} ev
 */
export function eventTimestampMs(ev) {
  const ts = Number(ev?.timestamp);
  return Number.isFinite(ts) ? ts : NaN;
}

/**
 * Soma chargedCents dos eventos na janela [startMs, endMs].
 * @param {object[]} events
 * @param {{
 *   startMs: number,
 *   endMs: number,
 *   email?: string,
 *   headlessOnly?: boolean,
 * }} filter
 */
export function sumChargedUsdInWindow(events, filter) {
  const { startMs, endMs, email, headlessOnly } = filter;
  let cents = 0;
  let matched = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const ev of events) {
    const ts = eventTimestampMs(ev);
    if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
    if (email && ev.userEmail && ev.userEmail !== email) continue;
    if (headlessOnly && ev.isHeadless !== true) continue;
    if (ev.isChargeable === false) continue;

    cents += Number(ev.chargedCents) || 0;
    matched += 1;
    const tu = ev.tokenUsage;
    if (tu && typeof tu === "object") {
      tokensIn += Number(tu.inputTokens) || 0;
      tokensOut += Number(tu.outputTokens) || 0;
    }
  }

  return {
    costBaseUsd: Math.round((cents / 100) * 1_000_000) / 1_000_000,
    chargedCents: cents,
    eventCount: matched,
    tokensIn,
    tokensOut,
  };
}
