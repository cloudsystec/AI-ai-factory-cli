import test from "node:test";
import assert from "node:assert/strict";
import {
  eventTimestampMs,
  sumChargedUsdInWindow,
  normalizeCursorChargeToCents,
  cursorChargedFieldToCostBaseUsd,
} from "./cursor-admin-api.js";

test("cursorChargedFieldToCostBaseUsd: centavos de USD da API", () => {
  assert.equal(cursorChargedFieldToCostBaseUsd(66.12), 0.6612);
  assert.equal(cursorChargedFieldToCostBaseUsd(18.8993), 0.188993);
  assert.equal(cursorChargedFieldToCostBaseUsd(0.15), 0.0015);
  assert.equal(cursorChargedFieldToCostBaseUsd(10), 0.1);
  assert.equal(cursorChargedFieldToCostBaseUsd(0), 0);
});

test("normalizeCursorChargeToCents", () => {
  assert.equal(normalizeCursorChargeToCents(66.12), 66);
  assert.equal(normalizeCursorChargeToCents(10), 10);
  assert.equal(normalizeCursorChargeToCents(0), 0);
});

test("sumChargedUsdInWindow: soma chargedCents na janela", () => {
  const events = [
    {
      timestamp: "1000",
      userEmail: "a@x.com",
      isChargeable: true,
      chargedCents: 10,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    },
    {
      timestamp: "5000",
      userEmail: "a@x.com",
      isChargeable: true,
      chargedCents: 20,
    },
    {
      timestamp: "9000",
      userEmail: "b@x.com",
      isChargeable: true,
      chargedCents: 99,
    },
  ];

  const r = sumChargedUsdInWindow(events, {
    startMs: 0,
    endMs: 6000,
    email: "a@x.com",
  });

  assert.equal(r.eventCount, 2);
  assert.equal(r.chargedCents, 30);
  assert.equal(r.costBaseUsd, 0.3);
  assert.equal(r.tokensIn, 100);
  assert.equal(r.tokensOut, 50);
});

test("eventTimestampMs", () => {
  assert.equal(eventTimestampMs({ timestamp: "1779317509185" }), 1779317509185);
});
