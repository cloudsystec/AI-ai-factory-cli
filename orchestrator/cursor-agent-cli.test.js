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

  it("default inclui -p, --force e --trust (headless Docker)", () => {
    assert.deepEqual(cursorAgentArgv(), ["-p", "--force", "--trust"]);
  });

  it("CURSOR_AGENT_TRUST=false remove --trust mas mantém headless", () => {
    process.env.CURSOR_AGENT_TRUST = "false";
    assert.deepEqual(cursorAgentArgv(), ["-p", "--force"]);
  });

  it("CURSOR_AGENT_ARGS faz override", () => {
    process.env.CURSOR_AGENT_ARGS = "--yolo -f";
    assert.deepEqual(cursorAgentArgv(), ["--yolo", "-f"]);
  });
});
