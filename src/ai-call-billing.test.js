import test from "node:test";
import assert from "node:assert/strict";
import {
  matchCallsToUsageEvents,
  filterUsageEvents,
} from "./ai-call-billing.js";
import { cursorEventKey } from "./cursor-admin-api.js";

test("matchCallsToUsageEvents: 1:1 por timestamp mais próximo", () => {
  const calls = [
    { id: "c1", agentFile: "a.md", startedAtMs: 1000, endedAtMs: 5000 },
    { id: "c2", agentFile: "b.md", startedAtMs: 6000, endedAtMs: 10000 },
  ];
  const events = [
    { timestamp: "4800", chargedCents: 10, isChargeable: true },
    { timestamp: "9900", chargedCents: 25, isChargeable: true },
  ];

  const r = matchCallsToUsageEvents(calls, events, {
    maxMatchDeltaMs: 5000,
    callClusterMs: 100,
  });

  assert.equal(r.matchedCount, 2);
  assert.equal(r.unmatchedCount, 0);
  assert.equal(r.matched[0].chargedCents, 10);
  assert.equal(r.matched[1].chargedCents, 25);
  assert.equal(r.totalCostBaseUsd, 0.35);
  assert.equal(r.orphanCents, 0);
});

test("matchCallsToUsageEvents: singleEventOnly não agrupa cluster", () => {
  const calls = [
    { id: "c1", agentFile: "a.md", startedAtMs: 1000, endedAtMs: 5000 },
  ];
  const events = [
    { timestamp: "4900", chargedCents: 10, isChargeable: true },
    { timestamp: "4950", chargedCents: 5, isChargeable: true },
  ];

  const r = matchCallsToUsageEvents(calls, events, {
    maxMatchDeltaMs: 5000,
    callClusterMs: 100,
    singleEventOnly: true,
  });

  assert.equal(r.matched[0].cursorEventCount, 1);
  assert.equal(r.matched[0].chargedCents, 5);
  assert.notEqual(r.matched[0].chargedCents, 15);
});

test("matchCallsToUsageEvents: cluster sem órfãos por defeito", () => {
  const calls = [
    { id: "c1", agentFile: "a.md", startedAtMs: 1000, endedAtMs: 5000 },
  ];
  const events = [
    { timestamp: "4900", chargedCents: 10, isChargeable: true },
    { timestamp: "4950", chargedCents: 5, isChargeable: true },
    { timestamp: "20000", chargedCents: 99, isChargeable: true },
  ];

  const r = matchCallsToUsageEvents(calls, events, {
    maxMatchDeltaMs: 5000,
    callClusterMs: 100,
  });

  assert.equal(r.matched[0].cursorEventCount, 2);
  assert.equal(r.matched[0].chargedCents, 15);
  assert.equal(r.orphanCount, 0);
  assert.equal(r.orphanCents, 0);
  assert.equal(r.totalCostBaseUsd, 0.15);
});

test("matchCallsToUsageEvents: consumedKeys evita evento duplicado", () => {
  const calls = [
    { id: "c2", agentFile: "b.md", startedAtMs: 6000, endedAtMs: 10000 },
  ];
  const events = [
    { timestamp: "9900", chargedCents: 25, isChargeable: true },
  ];
  const key = cursorEventKey(events[0]);
  const consumedKeys = new Set([key]);

  const r = matchCallsToUsageEvents(calls, events, {
    maxMatchDeltaMs: 5000,
    consumedKeys,
    estimateOnUnmatch: false,
  });

  assert.equal(r.unmatchedCount, 1);
  assert.equal(r.matched[0].chargedCents, 0);
});

test("matchCallsToUsageEvents: duas calls não partilham evento", () => {
  const calls = [
    { id: "c1", agentFile: "a.md", startedAtMs: 1000, endedAtMs: 5000 },
    { id: "c2", agentFile: "b.md", startedAtMs: 15000, endedAtMs: 20000 },
  ];
  const events = [
    { id: "e1", timestamp: "4800", chargedCents: 10, isChargeable: true },
    { id: "e2", timestamp: "19900", chargedCents: 25, isChargeable: true },
  ];

  const pass1 = matchCallsToUsageEvents([calls[0]], events, {
    maxMatchDeltaMs: 5000,
    callClusterMs: 100,
  });
  const consumed = pass1.consumedKeys;
  const pass2 = matchCallsToUsageEvents([calls[1]], events, {
    maxMatchDeltaMs: 5000,
    callClusterMs: 100,
    consumedKeys: consumed,
  });

  assert.equal(pass1.matched[0].chargedCents, 10);
  assert.equal(pass2.matched[0].chargedCents, 25);
  assert.notEqual(
    pass1.matched[0].cursorEventKeys[0].key,
    pass2.matched[0].cursorEventKeys[0].key
  );
});

test("matchCallsToUsageEvents: chamada sem evento fica pending (custo 0)", () => {
  const calls = [
    { id: "c1", agentFile: "a.md", startedAtMs: 1000, endedAtMs: 5000 },
  ];
  const events = [
    { timestamp: "500000", chargedCents: 10, isChargeable: true },
  ];

  const r = matchCallsToUsageEvents(calls, events, {
    maxMatchDeltaMs: 1000,
    estimateOnUnmatch: false,
  });

  assert.equal(r.unmatchedCount, 1);
  assert.equal(r.matched[0].costUsd, 0);
  assert.equal(r.matched[0].chargedCents, 0);
});

test("filterUsageEvents: email e chargeable", () => {
  const events = [
    {
      timestamp: "1000",
      chargedCents: 10,
      isChargeable: true,
      userEmail: "a@x.com",
    },
    {
      timestamp: "2000",
      chargedCents: 20,
      isChargeable: true,
      userEmail: "b@x.com",
    },
    { timestamp: "3000", chargedCents: 5, isChargeable: false },
  ];
  const filtered = filterUsageEvents(events, { email: "a@x.com" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].chargedCents, 10);
});

test("cursorEventKey: usa id quando disponível", async () => {
  const { cursorEventKey: keyFn } = await import("./cursor-admin-api.js");
  assert.equal(keyFn({ id: "ev-123", timestamp: "1000" }), "ev-123");
});
