import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findVisibleErrorInText,
  formatBrowserDiagnosticsError,
  isSignificantConsoleError,
  needsBrowserVerify,
} from "./deploy-browser-verify.js";
import { isRailwayErrorPage, resolveVerifyPaths } from "./deploy-live-verify.js";

describe("needsBrowserVerify", () => {
  it("activa para frontend e fullstack", () => {
    assert.equal(needsBrowserVerify({ appType: "frontend" }), true);
    assert.equal(needsBrowserVerify({ appType: "fullstack" }), true);
    assert.equal(needsBrowserVerify({ appType: "backend" }), false);
  });
});

describe("findVisibleErrorInText", () => {
  it("deteta Illegal invocation como no main-sst", () => {
    const text =
      "Catálogo de APIs\nFailed to execute 'fetch' on 'Window': Illegal invocation\nConfirme que o servidor";
    const hit = findVisibleErrorInText(text);
    assert.ok(hit);
    assert.match(hit, /illegal invocation|failed to execute/i);
  });

  it("ignora texto limpo", () => {
    assert.equal(findVisibleErrorInText("Bem-vindo ao dashboard"), null);
  });
});

describe("isSignificantConsoleError", () => {
  it("ignora favicon e mantém TypeError", () => {
    assert.equal(isSignificantConsoleError("Failed to load resource: favicon.ico"), false);
    assert.equal(isSignificantConsoleError("TypeError: Illegal invocation"), true);
  });
});

describe("formatBrowserDiagnosticsError", () => {
  it("resume erro visível e consola", () => {
    const msg = formatBrowserDiagnosticsError({
      visibleErrors: ["Illegal invocation"],
      consoleErrors: ["TypeError: fetch failed"],
      failedApiRequests: ["502 /api/apis"],
    });
    assert.match(msg, /Erro visível/);
    assert.match(msg, /Consola:/);
    assert.match(msg, /API falhou/);
  });
});

describe("resolveVerifyPaths", () => {
  it("fullstack inclui /, /health e /api/apis", () => {
    const paths = resolveVerifyPaths({ appType: "fullstack" });
    assert.ok(paths.includes("/"));
    assert.ok(paths.includes("/health"));
    assert.ok(paths.includes("/api/apis"));
  });
});

describe("isRailwayErrorPage", () => {
  it("deteta página Railway genérica", () => {
    assert.equal(
      isRailwayErrorPage("<html>Application failed to respond</html>"),
      true
    );
  });
});
