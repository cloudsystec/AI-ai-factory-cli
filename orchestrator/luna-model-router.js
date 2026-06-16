/**
 * Resolve provedor (Cursor/Luna) e perfil para jobs CLI/worker.
 * Suporta valores legacy (string = perfil Luna) e rotas { provider, lunaProfile? }.
 */

/**
 * @param {unknown} raw
 */
function normalizeRouteValue(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === "cursor") {
      return { provider: "cursor" };
    }
    return { provider: "luna", lunaProfile: trimmed };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const provider = String(raw.provider || "luna").toLowerCase();
    if (provider === "cursor") return { provider: "cursor" };
    return {
      provider: "luna",
      lunaProfile: String(raw.lunaProfile || raw.profile || "planning").trim(),
    };
  }
  return null;
}

function parseRouting() {
  const routingRaw = process.env.AI_FACTORY_LUNA_ROUTING;
  /** @type {Record<string, unknown>} */
  let routing = { defaultProvider: "luna", defaultProfile: "planning" };
  if (routingRaw) {
    try {
      routing = JSON.parse(routingRaw);
    } catch {
      /* fallback */
    }
  }
  if (!routing.defaultProvider) {
    const botMode = String(process.env.AI_FACTORY_BOT_MODE || "cursor").toLowerCase();
    routing.defaultProvider = botMode === "luna" ? "luna" : "cursor";
  }
  return routing;
}

/**
 * @param {{
 *   agentName?: string,
 *   agentFile?: string,
 *   jobKind?: string,
 *   meta?: { jobKind?: string, [k: string]: unknown },
 * }} input
 */
export function resolveWorkerAiProvider(input) {
  const routing = parseRouting();
  const agentName = String(input.agentName || "").trim();
  if (agentName && routing.byAgentName?.[agentName]) {
    const route = normalizeRouteValue(routing.byAgentName[agentName]);
    if (route) return route;
  }

  const agentFile = String(input.agentFile || "").replace(/\\/g, "/").trim();
  if (agentFile && routing.byAgentFile?.[agentFile]) {
    const route = normalizeRouteValue(routing.byAgentFile[agentFile]);
    if (route) return route;
  }

  const jobKind = String(
    input.jobKind || input.meta?.jobKind || process.env.AI_FACTORY_JOB_KIND || ""
  ).trim();
  if (jobKind && routing.byJobKind?.[jobKind]) {
    const route = normalizeRouteValue(routing.byJobKind[jobKind]);
    if (route) return route;
  }

  const defaultProvider = String(routing.defaultProvider || "luna").toLowerCase();
  if (defaultProvider === "cursor") {
    return { provider: "cursor" };
  }
  return {
    provider: "luna",
    lunaProfile: String(routing.defaultProfile || "planning"),
  };
}

/**
 * @param {{
 *   agentName?: string,
 *   agentFile?: string,
 *   jobKind?: string,
 *   meta?: object,
 * }} input
 * @returns {{ profileKey: string }}
 */
export function resolveLunaProfile(input) {
  const resolved = resolveWorkerAiProvider(input);
  if (resolved.provider === "cursor") {
    return { profileKey: "planning" };
  }
  return { profileKey: resolved.lunaProfile || "planning" };
}
