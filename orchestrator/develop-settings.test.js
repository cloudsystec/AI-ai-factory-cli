import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  readDevelopSettings,
  writeDevelopSettings,
} from "./develop-settings.js";
import { developSettingsFile, workspaceRoot } from "./project-paths.js";

test("readDevelopSettings: default false sem ficheiro", () => {
  const project = `test-${Date.now()}`;
  const root = workspaceRoot(project);
  fs.mkdirSync(root, { recursive: true });
  try {
    assert.strictEqual(readDevelopSettings(project).autorun, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDevelopSettings: round-trip autorun", () => {
  const project = `test-${Date.now()}`;
  const root = workspaceRoot(project);
  fs.mkdirSync(root, { recursive: true });
  const filePath = developSettingsFile(project);
  try {
    writeDevelopSettings(project, { autorun: true });
    assert.strictEqual(fs.existsSync(filePath), true);
    assert.strictEqual(readDevelopSettings(project).autorun, true);
    writeDevelopSettings(project, { autorun: false });
    assert.strictEqual(readDevelopSettings(project).autorun, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDevelopSettings: rejeita autorun não boolean", () => {
  assert.throws(
    () => writeDevelopSettings("valid-slug", { autorun: "yes" }),
    /boolean/
  );
});
