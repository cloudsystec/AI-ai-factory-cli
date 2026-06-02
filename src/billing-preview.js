import { cursorChargedFieldToCostBaseUsd } from "./cursor-admin-api.js";

/**
 * Taxa na mesma escala que `chargedCents` da Cursor (ex.: 0.8 ≈ US$ 0,008 / 1M tokens;
 * 80 ≈ US$ 0,80 / 1M tokens). Override: CURSOR_PREVIEW_CHARGE_FIELD_PER_MILLION.
 */
export const CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS = Number(
  process.env.CURSOR_PREVIEW_CHARGE_FIELD_PER_MILLION ??
    process.env.CURSOR_USD_PER_MILLION_TOKENS ??
    0.8
);

/** @deprecated use CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS */
export const CURSOR_USD_PER_MILLION_TOKENS = CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS;

/**
 * Estima tokens a partir do texto do prompt (~4 caracteres por token).
 * @param {string|null|undefined} text
 */
export function estimateTokensFromText(text) {
  const s = String(text || "");
  if (!s.length) return 0;
  return Math.ceil(s.length / 4);
}

/**
 * CB de prévia local (sem API externa), alinhado a chargedCents ÷ 100.
 * @param {number} tokenCount
 */
export function computePreviewCostBaseUsd(tokenCount) {
  const n = Number(tokenCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const chargeField =
    (n / 1_000_000) * CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS;
  return cursorChargedFieldToCostBaseUsd(chargeField);
}

/**
 * @param {string|null|undefined} prompt
 */
export function computePreviewFromPrompt(prompt) {
  const estimatedTokens = estimateTokensFromText(prompt);
  const costBaseUsd = computePreviewCostBaseUsd(estimatedTokens);
  return { estimatedTokens, costBaseUsd };
}
