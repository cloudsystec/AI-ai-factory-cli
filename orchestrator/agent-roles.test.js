import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ROLES,
  allRoleKeys,
  fileForRole,
  roleKeyForAgentPath,
} from "./agent-roles.js";

describe("agent-roles", () => {
  it("tem global e roles de task/scope", () => {
    assert.equal(AGENT_ROLES.length, 13);
    assert.ok(allRoleKeys().includes("planner"));
    assert.equal(fileForRole("global"), "AGENTS.md");
    assert.equal(roleKeyForAgentPath("agents/dev.md"), "dev");
  });
});
