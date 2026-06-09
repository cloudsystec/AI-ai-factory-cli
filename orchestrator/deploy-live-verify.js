import {
  needsBrowserVerify,
  verifyFrontendBrowser,
} from "./deploy-browser-verify.js";

/** Espera inicial após provision Railway antes da primeira verificação HTTP. */
export const VERIFY_INITIAL_WAIT_MS = 120_000;

const VERIFY_CHECK_INTERVAL_MS = 30_000;
const VERIFY_MAX_CHECKS = 6;
const FETCH_TIMEOUT_MS = 20_000;

const RAILWAY_ERROR_MARKERS = [
  "application failed to respond",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
  "deploy failed",
  "crashed",
  "not found",
  "error deploying",
];

/**
 * @param {string} html
 */
export function isRailwayErrorPage(html) {
  const lower = String(html || "").toLowerCase();
  if (!lower.trim()) return true;
  return RAILWAY_ERROR_MARKERS.some((m) => lower.includes(m));
}

/**
 * @param {Record<string, unknown>} readiness
 * @returns {string[]}
 */
export function resolveVerifyPaths(readiness) {
  /** @type {string[]} */
  const paths = ["/health"];
  const appType = String(readiness.appType || "");
  if (appType === "fullstack" || appType === "frontend") {
    paths.push("/");
  }
  if (appType === "fullstack" || appType === "backend") {
    paths.push("/api/apis");
  }
  return [...new Set(paths)];
}

export { needsBrowserVerify } from "./deploy-browser-verify.js";

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} readiness
 * @param {(line: string) => void} onLine
 */
async function runBrowserVerifyIfNeeded(baseUrl, readiness, onLine) {
  if (!needsBrowserVerify(readiness)) return;
  const browser = await verifyFrontendBrowser(baseUrl, readiness, onLine);
  if (!browser.ok && !browser.skipped) {
    throw new Error(browser.error || "verificação browser falhou");
  }
}

/**
 * @param {string} baseUrl
 * @param {string} path
 */
async function fetchCheck(baseUrl, path) {
  const url = `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: path === "/" ? { Accept: "text/html" } : { Accept: "application/json" },
  });

  if (path === "/") {
    const html = await res.text();
    if (!res.ok) {
      throw new Error(
        `/ → HTTP ${res.status} (página Railway ou deploy em falha — não é a app)`
      );
    }
    if (isRailwayErrorPage(html)) {
      throw new Error(
        "/ → página de erro Railway (deploy ainda não funcional — corrigir e republicar)"
      );
    }
    return true;
  }

  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}`);
  }

  if (path === "/health") {
    const body = await res.json().catch(() => null);
    if (!body || body.status !== "ok") {
      throw new Error("/health sem status ok");
    }
  }

  return true;
}

/**
 * Aguarda o deploy Railway ficar acessível e funcional.
 * @param {string} publicUrl
 * @param {Record<string, unknown>} readiness
 * @param {(line: string) => void} [onLine]
 * @param {{ skipInitialWait?: boolean }} [options]
 */
export async function verifyDeployLive(publicUrl, readiness, onLine = () => {}, options = {}) {
  const base = String(publicUrl || "").trim();
  if (!base) {
    return { ok: false, error: "URL pública em falta" };
  }

  const paths = resolveVerifyPaths(readiness);
  if (options.skipInitialWait) {
    onLine(`[verify] URL já conhecida — testar ${base} sem espera inicial…\n`);
  } else {
    onLine(
      `[verify] aguardando ${VERIFY_INITIAL_WAIT_MS / 1000}s antes de testar ${base}…\n`
    );
    await new Promise((r) => setTimeout(r, VERIFY_INITIAL_WAIT_MS));
  }

  /** @type {string | null} */
  let lastError = null;

  for (let attempt = 1; attempt <= VERIFY_MAX_CHECKS; attempt += 1) {
    try {
      for (const path of paths) {
        await fetchCheck(base, path);
      }
      if (needsBrowserVerify(readiness)) {
        onLine(`[verify] frontend/fullstack — validar página e consola…\n`);
        await runBrowserVerifyIfNeeded(base, readiness, onLine);
      }
      onLine(`[verify] OK — app online (${paths.join(", ")})\n`);
      return { ok: true, error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      onLine(
        `[verify] tentativa ${attempt}/${VERIFY_MAX_CHECKS} falhou: ${lastError}\n`
      );
      if (attempt < VERIFY_MAX_CHECKS) {
        await new Promise((r) => setTimeout(r, VERIFY_CHECK_INTERVAL_MS));
      }
    }
  }

  return {
    ok: false,
    error: lastError || "Verificação HTTP falhou",
  };
}
