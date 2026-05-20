import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearQaVerdict,
  qaVerdictFile,
  readQaVerdict,
} from "./qa-verdict.js";

test("readQaVerdict: missing file is fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qf-"));
  const r = readQaVerdict(dir, "TASK-X");
  assert.strictEqual(r.verdict, "fail");
  assert.strictEqual(r.code, "MISSING");
  fs.rmSync(dir, { recursive: true });
});

test("readQaVerdict: pass and fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qf-"));
  const reports = path.join(dir, "reports", "tasks");
  fs.mkdirSync(reports, { recursive: true });
  const p = qaVerdictFile(dir, "TASK-1");
  fs.writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok" }), "utf-8");
  assert.strictEqual(readQaVerdict(dir, "TASK-1").verdict, "pass");
  fs.writeFileSync(p, JSON.stringify({ verdict: "fail", summary: "bug" }), "utf-8");
  assert.strictEqual(readQaVerdict(dir, "TASK-1").verdict, "fail");
  clearQaVerdict(dir, "TASK-1");
  assert.strictEqual(fs.existsSync(p), false);
  fs.rmSync(dir, { recursive: true });
});
