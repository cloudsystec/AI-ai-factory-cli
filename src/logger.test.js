import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, formatJobLine, redactForClient } from "./logger.js";

describe("logger", () => {
  it("stripAnsi remove códigos de cor", () => {
    assert.equal(stripAnsi("\x1b[31mhello\x1b[0m"), "hello");
  });

  it("formatJobLine preserva texto de fase", () => {
    const out = stripAnsi(formatJobLine("=== FASE 1: Gerando microescopos ==="));
    assert.match(out, /FASE 1/);
  });
});

describe("redactForClient", () => {
  it("remove CURSOR_API_KEY=valor", () => {
    assert.equal(redactForClient("CURSOR_API_KEY=sk-abc123"), "[REDACTED]");
  });

  it("substitui CURSOR por Agent", () => {
    const out = redactForClient("Executando CURSOR agent");
    assert.ok(!out.includes("CURSOR"), `should not contain CURSOR: ${out}`);
    assert.ok(out.includes("Agent"), `should contain Agent: ${out}`);
  });

  it("remove linhas de billing", () => {
    const out = redactForClient("[billing] CB=$0.1234 (round_settlement) | rodadas=3");
    assert.equal(out, "");
  });

  it("substitui AI_FACTORY por System", () => {
    const out = redactForClient("AI_FACTORY_SKIP_AGENTS ignorado");
    assert.ok(!out.includes("AI_FACTORY"), `should not contain AI_FACTORY: ${out}`);
    assert.ok(out.includes("System"), `should contain System: ${out}`);
  });

  it("remove chaves sk-*", () => {
    const out = redactForClient("token: sk-1234567890abcdef");
    assert.ok(!out.includes("sk-1234567890"), `should not contain key: ${out}`);
  });

  it("preserva linhas normais", () => {
    const out = redactForClient("=== FASE 1: Gerando microescopos ===");
    assert.equal(out, "=== FASE 1: Gerando microescopos ===");
  });
});
