import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokensFromText,
  computePreviewCostBaseUsd,
  computePreviewFromPrompt,
  CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS,
} from "./billing-preview.js";

test("estimateTokensFromText: ~4 chars por token", () => {
  assert.equal(estimateTokensFromText(""), 0);
  assert.equal(estimateTokensFromText("abcd"), 1);
  assert.equal(estimateTokensFromText("a".repeat(100)), 25);
});

test("computePreviewCostBaseUsd: charge field ÷ 100 → USD", () => {
  assert.equal(computePreviewCostBaseUsd(0), 0);
  assert.equal(
    computePreviewCostBaseUsd(1_000_000),
    CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS / 100
  );
  assert.equal(computePreviewCostBaseUsd(500_000), 0.004);
});

test("computePreviewFromPrompt", () => {
  const r = computePreviewFromPrompt("x".repeat(4000));
  assert.equal(r.estimatedTokens, 1000);
  assert.equal(r.costBaseUsd, 0.000008);
});
