import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  buildTaskDetail,
  isValidTaskId,
  normalizeBacklogTextField,
} from "./task-dashboard-detail.js";
import { workspaceRoot } from "./project-paths.js";
import { writeBacklogFile } from "./backlog-io.js";

test("normalizeBacklogTextField: array vira markdown", () => {
  const out = normalizeBacklogTextField(["Critério A", "Critério B"]);
  assert.ok(out?.includes("- Critério A"));
  assert.ok(out?.includes("- Critério B"));
});

test("isValidTaskId", () => {
  assert.strictEqual(isValidTaskId("bs-001-01"), true);
  assert.strictEqual(isValidTaskId("../evil"), false);
  assert.strictEqual(isValidTaskId(""), false);
});

test("buildTaskDetail: backlog + doc artifact", () => {
  const project = `detail-test-${Date.now()}`;
  const taskId = "bs-test-01";
  const root = workspaceRoot(project);
  const backlogPath = path.join(root, "backlog", `${project}.tasks.json`);

  fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
  fs.mkdirSync(path.dirname(backlogPath), { recursive: true });

  writeBacklogFile(backlogPath, {
    project,
    macroId: project,
    tasks: [
      {
        id: taskId,
        project,
        sourceMicroId: "bs-mic-001",
        title: "Task de teste",
        description: "Descrição curta",
        acceptance: ["Aceite 1", "Aceite 2"],
        status: "todo",
        approved: true,
      },
    ],
  });

  const docPath = path.join(root, "docs", "tasks", `${taskId}.md`);
  fs.writeFileSync(docPath, "# Task de teste\n\nConteúdo.", "utf-8");

  try {
    const detail = buildTaskDetail(project, taskId);
    assert.ok(detail);
    assert.strictEqual(detail.taskId, taskId);
    assert.strictEqual(detail.backlog?.title, "Task de teste");
    assert.ok(detail.backlog?.acceptance?.includes("- Aceite 1"));
    assert.strictEqual(detail.runtime, null);
    const docArtifact = detail.artifacts.find((a) => a.kind === "doc");
    assert.ok(docArtifact?.exists);
    assert.ok(docArtifact.preview?.includes("Task de teste"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildTaskDetail: null quando task inexistente", () => {
  const project = `detail-miss-${Date.now()}`;
  const root = workspaceRoot(project);
  fs.mkdirSync(root, { recursive: true });
  try {
    assert.strictEqual(buildTaskDetail(project, "bs-missing-99"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
