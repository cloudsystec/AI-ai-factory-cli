import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecoverableError,
  maxErrorRecoveryAttempts,
} from "../orchestrator/error-recovery.js";

test("isRecoverableError: ETIMEDOUT", () => {
  assert.equal(isRecoverableError({ code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" }), true);
});

test("isRecoverableError: agent exit", () => {
  assert.equal(isRecoverableError(new Error("agent exit 1: boom")), true);
});

test("isRecoverableError: git push não é recuperável aqui", () => {
  assert.equal(isRecoverableError(new Error("git push rejected")), false);
});

test("maxErrorRecoveryAttempts default", () => {
  assert.equal(maxErrorRecoveryAttempts() >= 0, true);
});
