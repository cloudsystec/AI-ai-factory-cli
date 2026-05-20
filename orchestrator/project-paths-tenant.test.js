import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("project-paths tenant env", () => {
  /** @type {string|undefined} */
  let tmp;
  /** @type {NodeJS.ProcessEnv} */
  let prev;

  beforeEach(() => {
    prev = { ...process.env };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aif-tenant-"));
    process.env.AI_FACTORY_TENANT_ROOT = tmp;
    process.env.AI_FACTORY_WORKSPACES_DIR = path.join(tmp, "workspaces");
    process.env.AI_FACTORY_AGENTS_DIR = path.join(tmp, "agents");
    process.env.AI_FACTORY_MACRO_DIR = path.join(tmp, "scopes", "macro");
  });

  afterEach(() => {
    process.env = prev;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolve agent paths no volume do tenant", async () => {
    const { agentFilePath, globalAgentsFile, npmTestPrefix, workspaceRoot } =
      await import("./project-paths.js");

    fs.mkdirSync(path.join(tmp, "agents"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "rules", "utf-8");
    fs.writeFileSync(path.join(tmp, "agents", "dev.md"), "dev", "utf-8");
    fs.mkdirSync(path.join(tmp, "workspaces", "proj"), { recursive: true });

    assert.equal(globalAgentsFile(), path.join(tmp, "AGENTS.md"));
    assert.equal(agentFilePath("agents/dev.md"), path.join(tmp, "agents", "dev.md"));
    assert.equal(workspaceRoot("proj"), path.join(tmp, "workspaces", "proj"));
    const prefix = npmTestPrefix("proj");
    assert.ok(prefix.includes("workspaces"));
    assert.ok(prefix.includes("proj"));
  });
});
