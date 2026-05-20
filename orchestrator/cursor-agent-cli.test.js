import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { cursorAgentArgv } from "./cursor-agent-cli.js";

describe("cursorAgentArgv", () => {
  /** @type {NodeJS.ProcessEnv} */
  let prev;

  beforeEach(() => {
    prev = { ...process.env };
    delete process.env.CURSOR_AGENT_ARGS;
    delete process.env.CURSOR_AGENT_TRUST;
  });

  afterEach(() => {
    process.env = prev;
  });

  it("default inclui --trust", () => {
    assert.deepEqual(cursorAgentArgv(), ["--trust"]);
  });

  it("CURSOR_AGENT_TRUST=false desativa flags", () => {
    process.env.CURSOR_AGENT_TRUST = "false";
    assert.deepEqual(cursorAgentArgv(), []);
  });

  it("CURSOR_AGENT_ARGS faz override", () => {
    process.env.CURSOR_AGENT_ARGS = "--yolo -f";
    assert.deepEqual(cursorAgentArgv(), ["--yolo", "-f"]);
  });
});
