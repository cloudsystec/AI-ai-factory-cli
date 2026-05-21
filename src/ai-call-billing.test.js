import test from "node:test";
import assert from "node:assert/strict";
import {
  matchCallsToUsageEvents,
  filterUsageEvents,
} from "./ai-call-billing.js";

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
});

test("matchCallsToUsageEvents: cluster de eventos próximos numa chamada", () => {
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
  assert.equal(r.orphanCount, 1);
  assert.equal(r.orphanCents, 99);
  assert.equal(r.totalCostBaseUsd, 1.14);
});

test("matchCallsToUsageEvents: chamada sem evento usa estimate", () => {
  const calls = [
    { id: "c1", agentFile: "a.md", startedAtMs: 1000, endedAtMs: 5000 },
  ];
  const events = [
    { timestamp: "500000", chargedCents: 10, isChargeable: true },
  ];

  const r = matchCallsToUsageEvents(calls, events, {
    maxMatchDeltaMs: 1000,
    estimatePerCallUsd: 0.07,
  });

  assert.equal(r.unmatchedCount, 1);
  assert.equal(r.matched[0].costUsd, 0.07);
  assert.equal(r.orphanCount, 1);
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
