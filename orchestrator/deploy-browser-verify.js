/** @typedef {{ consoleErrors: string[], visibleErrors: string[], failedApiRequests: string[] }} BrowserDiagnostics */

const PAGE_LOAD_TIMEOUT_MS = 35_000;
const POST_LOAD_WAIT_MS = 4_000;

/** Texto visível típico de app com front/back desligados ou bug JS. */
export const FRONTEND_ERROR_TEXT_PATTERNS = [
  /failed to execute .fetch. on .window/i,
  /illegal invocation/i,
  /failed to fetch/i,
  /network error/i,
  /load failed/i,
  /confirme que o servidor/i,
  /something went wrong/i,
  /unexpected error/i,
  /cannot connect/i,
  /erro ao carregar/i,
  /não foi possível (carregar|conectar|obter)/i,
  /error:\s*\S/i,
  /typeerror:/i,
  /referenceerror:/i,
];

/** Erros de consola que indicam app quebrada (não warnings benignos). */
export const CONSOLE_ERROR_IGNORE = [
  /^failed to load resource/i,
  /^net::err_/i,
  /favicon\.ico/i,
  /manifest\.json/i,
];

/**
 * @param {Record<string, unknown>} readiness
 */
export function needsBrowserVerify(readiness) {
  const appType = String(readiness?.appType || "");
  return appType === "frontend" || appType === "fullstack";
}

/**
 * @param {string} text
 */
export function findVisibleErrorInText(text) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  for (const re of FRONTEND_ERROR_TEXT_PATTERNS) {
    const m = body.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * @param {string} msg
 */
export function isSignificantConsoleError(msg) {
  const t = String(msg || "").trim();
  if (!t) return false;
  return !CONSOLE_ERROR_IGNORE.some((re) => re.test(t));
}

/**
 * @param {BrowserDiagnostics} diag
 */
export function formatBrowserDiagnosticsError(diag) {
  /** @type {string[]} */
  const parts = [];

  if (diag.visibleErrors.length) {
    parts.push(`Erro visível na página: ${diag.visibleErrors[0]}`);
  }
  const consoleHits = diag.consoleErrors.filter(isSignificantConsoleError);
  if (consoleHits.length) {
    parts.push(`Consola: ${consoleHits[0]}`);
  }
  if (diag.failedApiRequests.length) {
    parts.push(`API falhou: ${diag.failedApiRequests[0]}`);
  }

  if (!parts.length) {
    return "Frontend com erros na página ou consola (verificar ligação front→back)";
  }

  let msg = parts.join(" | ");
  const extra = [
    ...diag.visibleErrors.slice(1, 3),
    ...consoleHits.slice(1, 3),
    ...diag.failedApiRequests.slice(1, 3),
  ];
  if (extra.length) {
    msg += `\n${extra.join("\n")}`;
  }
  return msg;
}

/**
 * @param {import('playwright-core').Page} page
 */
async function collectVisibleErrors(page) {
  /** @type {string[]} */
  const found = [];

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const fromBody = findVisibleErrorInText(bodyText);
  if (fromBody) found.push(fromBody);

  const selectors = [
    '[role="alert"]',
    '[class*="error" i]',
    '[class*="alert-danger" i]',
    '[data-testid*="error" i]',
  ];

  for (const sel of selectors) {
    const els = page.locator(sel);
    const count = await els.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i += 1) {
      const text = await els
        .nth(i)
        .innerText()
        .catch(() => "");
      const hit = findVisibleErrorInText(text);
      if (hit && !found.includes(hit)) found.push(hit);
    }
  }

  return found;
}

/**
 * Resolve caminho Chromium (Docker: apt chromium; local: PLAYWRIGHT ou default).
 */
function resolveChromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  if (process.platform === "linux") return "/usr/bin/chromium";
  return undefined;
}

/**
 * Verifica SPA/fullstack no browser: texto visível, consola e pedidos /api.
 * @param {string} baseUrl
 * @param {Record<string, unknown>} readiness
 * @param {(line: string) => void} [onLine]
 */
export async function verifyFrontendBrowser(baseUrl, readiness, onLine = () => {}) {
  if (!needsBrowserVerify(readiness)) {
    return { ok: true, error: null, skipped: true };
  }

  if (process.env.DEPLOY_VERIFY_BROWSER === "0") {
    onLine("[verify-browser] ignorado (DEPLOY_VERIFY_BROWSER=0)\n");
    return { ok: true, error: null, skipped: true };
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    onLine(
      "[verify-browser] playwright-core não instalado — instale dependência ou use worker Docker\n"
    );
    return {
      ok: false,
      error:
        "Verificação browser indisponível (playwright-core em falta) — não foi possível validar erros na página",
    };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/`;
  /** @type {BrowserDiagnostics} */
  const diag = {
    consoleErrors: [],
    visibleErrors: [],
    failedApiRequests: [],
  };

  /** @type {import('playwright-core').Browser | null} */
  let browser = null;

  try {
    const executablePath = resolveChromiumExecutable();
    onLine(
      `[verify-browser] abrir ${url}${executablePath ? ` (chromium: ${executablePath})` : ""}…\n`
    );

    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        diag.consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      diag.consoleErrors.push(err.message || String(err));
    });
    page.on("response", (res) => {
      try {
        const reqUrl = res.url();
        const path = new URL(reqUrl).pathname;
        if (
          (path.startsWith("/api") || path.includes("/api/")) &&
          res.status() >= 400 &&
          res.request().resourceType() !== "preflight"
        ) {
          diag.failedApiRequests.push(`${res.status()} ${path}`);
        }
      } catch {
        /* ignore bad url */
      }
    });

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    }).catch(async () => {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
    });
    await page.waitForTimeout(POST_LOAD_WAIT_MS);

    diag.visibleErrors = await collectVisibleErrors(page);

    const consoleHits = diag.consoleErrors.filter(isSignificantConsoleError);
    const hasProblem =
      diag.visibleErrors.length > 0 ||
      consoleHits.length > 0 ||
      diag.failedApiRequests.length > 0;

    if (hasProblem) {
      const error = formatBrowserDiagnosticsError({
        ...diag,
        consoleErrors: consoleHits,
      });
      onLine(`[verify-browser] FALHOU: ${error.split("\n")[0]}\n`);
      return { ok: false, error, diagnostics: diag };
    }

    onLine("[verify-browser] OK — página sem erros visíveis nem consola crítica\n");
    return { ok: true, error: null, diagnostics: diag };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/executable doesn't exist|ENOENT|failed to launch/i.test(msg)) {
      onLine(
        `[verify-browser] Chromium indisponível (${msg.slice(0, 100)}) — instale chromium no worker\n`
      );
      return {
        ok: false,
        error: `Verificação browser indisponível (Chromium em falta): ${msg.slice(0, 200)}`,
      };
    }
    onLine(`[verify-browser] erro: ${msg}\n`);
    return { ok: false, error: `Verificação browser falhou: ${msg}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}
