/**
 * Logging para worker / orquestrador — stdout para Docker (`docker logs -f`).
 * Portal/redis: texto sem ANSI (use stripAnsi).
 *
 * AI_FACTORY_LOG_COLOR=1  cores (default em Docker)
 * AI_FACTORY_LOG_LEVEL=debug|info|warn|error
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function useColor() {
  if (process.env.AI_FACTORY_LOG_COLOR === "0") return false;
  if (process.env.AI_FACTORY_LOG_COLOR === "1") return true;
  return process.env.FORCE_COLOR === "1" || Boolean(process.stdout.isTTY);
}

function minLevel() {
  const v = (process.env.AI_FACTORY_LOG_LEVEL || "debug").toLowerCase();
  return LEVELS[v] ?? LEVELS.info;
}

/**
 * @param {string} s
 * @param {string} [code]
 */
function paint(s, code) {
  if (!useColor() || !code) return s;
  return `${code}${s}${C.reset}`;
}

function ts() {
  return new Date().toISOString();
}

/**
 * @param {string} text
 */
export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

const REDACT_PATTERNS = [
  [/^\d{4}-\d{2}-\d{2}T\S+\s+DEBUG\s/, ""],
  [/\bCURSOR_API_KEY\b[=:]\S*/gi, "[REDACTED]"],
  [/\bCURSOR_ADMIN_API_KEY\b[=:]\S*/gi, "[REDACTED]"],
  [/\bcursor[-_ ]?api[-_ ]?key\b/gi, "api-key"],
  [/\bCURSOR\b/g, "Agent"],
  [/\bcursor\b(?!\s*([:=]|de|do))/gi, "agent"],
  [/AI[_\s]?FACTORY/gi, "System"],
  [/\b(sk-|key_)[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/\[billing\]\s*CB=\$[\d.]+.*/gi, ""],
  [/costBaseUsd[=:]\s*[\d.]+/gi, "[REDACTED]"],
  [/\b\d+\.\d{2,4}\s*USD\b/gi, "[REDACTED]"],
  [/tokens?[_ ]?(in|out)[=:]\s*\d+/gi, "[REDACTED]"],
  [/rodadas=\d+/gi, "[REDACTED]"],
  [/round_settlement|cursor_admin_api/gi, "[REDACTED]"],
  [/CURSOR_USAGE_EMAIL[=:]\S*/gi, "[REDACTED]"],
  [/AI_FACTORY_EXECUTOR_USER_ID[=:]\S*/gi, "[REDACTED]"],
];

/**
 * Remove informações sensíveis (custos, chaves, nomes de ferramentas internas)
 * das linhas que serão expostas ao cliente via Redis/portal.
 * @param {string} line
 */
export function redactForClient(line) {
  let out = line;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim() ? out : "";
}

/**
 * Coloriza linhas de saída de jobs (scope, git, agent, etc.).
 * @param {string} line
 */
export function formatJobLine(line) {
  const raw = stripAnsi(line).replace(/\r?\n$/, "");
  if (!raw) return "";

  if (/^===\s/.test(raw)) {
    return paint(raw, `${C.bold}${C.cyan}`);
  }
  if (/^\[stderr\]/i.test(raw) || /Error:|Authentication required/i.test(raw)) {
    return paint(raw, C.red);
  }
  if (/^\[(git|tech-lead|micro-release|micro-integration|billing|warn)\]/i.test(raw)) {
    const tag = raw.match(/^\[([^\]]+)\]/i)?.[1]?.toLowerCase() || "";
    const color =
      tag === "git"
        ? C.blue
        : tag === "tech-lead"
          ? C.magenta
          : tag === "billing"
            ? C.yellow
            : tag === "warn"
              ? C.yellow
              : C.cyan;
    return paint(raw, color);
  }
  if (/^(\$ |Provisionando|Job finalizado|OK —|Tudo OK)/i.test(raw)) {
    return paint(raw, C.green);
  }
  if (/^claimed\b/i.test(raw)) {
    return paint(raw, `${C.bold}${C.green}`);
  }
  if (/^claim error|falhou|Erro:/i.test(raw)) {
    return paint(raw, C.red);
  }
  return raw;
}

/**
 * @param {string} component ex: worker, scope, back
 */
export function createLogger(component) {
  const tag = `[${component}]`;

  /**
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} msg
   * @param {Record<string, unknown>} [meta]
   */
  function write(level, msg, meta) {
    if (LEVELS[level] < minLevel()) return;
    const levelColors = {
      debug: C.gray,
      info: C.green,
      warn: C.yellow,
      error: C.red,
    };
    const lvl = level.toUpperCase().padEnd(5);
    const paintedLvl = paint(lvl, levelColors[level]);
    const paintedTag = paint(tag, C.dim);
    let line = `${paint(ts(), C.gray)} ${paintedLvl} ${paintedTag} ${msg}`;
    if (meta && Object.keys(meta).length > 0) {
      const extra = Object.entries(meta)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      line += paint(` ${extra}`, C.dim);
    }
    const out = level === "error" ? process.stderr : process.stdout;
    out.write(line + "\n");
  }

  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
    /** Retorna startMs; usar com timerEnd. */
    timerStart: (label) => {
      const now = Date.now();
      write("debug", `⏱ ${label} [início]`);
      return now;
    },
    /** @param {string} label @param {number} startMs */
    timerEnd: (label, startMs) => {
      const elapsed = Date.now() - startMs;
      const sec = (elapsed / 1000).toFixed(1);
      write("debug", `⏱ ${label} [fim]`, { elapsedMs: elapsed, elapsedSec: `${sec}s` });
    },
    /** Banner de fase (scope pipeline). */
    phase: (title) => {
      const bar = "─".repeat(Math.min(56, Math.max(20, title.length + 4)));
      write("info", paint(`┌${bar}┐`, C.cyan));
      write("info", paint(`│ ${title}`, `${C.bold}${C.cyan}`));
      write("info", paint(`└${bar}┘`, C.cyan));
    },
    /** Linha de job → Docker colorido; devolver texto com ANSI para Redis (frontend converte). */
    jobLine: (line) => {
      const plain = stripAnsi(line).replace(/\r?\n$/, "");
      if (!plain) return "";
      const colored = formatJobLine(plain);
      process.stdout.write(colored + "\n");
      return colored.endsWith("\n") ? colored : `${colored}\n`;
    },
  };
}
