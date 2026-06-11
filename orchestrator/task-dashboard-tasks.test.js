import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  buildDashboardTasks,
  isBacklogKanbanVisible,
  isBacklogTodoApproved,
} from "./task-dashboard-tasks.js";
import { taskStateFile, workspaceRoot } from "./project-paths.js";
import { writeBacklogFile } from "./backlog-io.js";

test("isBacklogTodoApproved", () => {
  assert.strictEqual(
    isBacklogTodoApproved({ status: "todo", validationStatus: "approved" }),
    true
  );
  assert.strictEqual(
    isBacklogTodoApproved({ status: "todo", validationStatus: "pending_validation" }),
    false
  );
  assert.strictEqual(
    isBacklogTodoApproved({ status: "done", validationStatus: "approved" }),
    false
  );
});

test("isBacklogKanbanVisible inclui in_progress", () => {
  assert.strictEqual(
    isBacklogKanbanVisible({ status: "in_progress", validationStatus: "approved" }),
    true
  );
  assert.strictEqual(
    isBacklogKanbanVisible({ status: "todo", validationStatus: "pending_validation" }),
    false
  );
});

test("buildDashboardTasks: inclui todo+approved do backlog sem entrada no runtime", () => {
  const project = `kanban-merge-${Date.now()}`;
  const root = workspaceRoot(project);
  const backlogPath = path.join(root, "backlog", `${project}.tasks.json`);
  const statePath = taskStateFile(project);

  fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
  writeBacklogFile(backlogPath, {
    project,
    macroId: project,
    tasks: [
      {
        id: "bs-ready-01",
        project,
        title: "Pronta no backlog",
        status: "todo",
        validationStatus: "approved",
        approved: true,
      },
      {
        id: "bs-pending-01",
        project,
        title: "Aguarda TL",
        status: "todo",
        validationStatus: "pending_validation",
        approved: false,
      },
      {
        id: "bs-runtime-01",
        project,
        title: "Já em execução",
        status: "todo",
        validationStatus: "approved",
        approved: true,
      },
    ],
  });

  fs.writeFileSync(
    statePath,
    JSON.stringify(
      [
        {
          id: "bs-runtime-01",
          title: "Já em execução",
          project,
          status: "development",
          currentAgent: "Dev Agent",
          updatedAt: "2026-05-18T12:00:00.000Z",
        },
      ],
      null,
      2
    ),
    "utf-8"
  );

  const rows = buildDashboardTasks(project);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.ok(byId["bs-ready-01"], "task pronta deve aparecer");
  assert.strictEqual(byId["bs-ready-01"].status, "todo");
  assert.strictEqual(byId["bs-ready-01"].backlogReady, true);
  assert.strictEqual(byId["bs-pending-01"], undefined, "task sem TL não entra");
  assert.strictEqual(byId["bs-runtime-01"].status, "development", "runtime prevalece");
  assert.strictEqual(byId["bs-runtime-01"].backlogReady, undefined);

  writeBacklogFile(backlogPath, {
    project,
    macroId: project,
    tasks: [
      ...JSON.parse(fs.readFileSync(backlogPath, "utf-8")).tasks,
      {
        id: "bs-inprog-01",
        project,
        title: "A arrancar",
        status: "in_progress",
        validationStatus: "approved",
        approved: true,
      },
    ],
  });
  fs.writeFileSync(statePath, "[]", "utf-8");

  const withInProgress = buildDashboardTasks(project);
  const inProg = withInProgress.find((r) => r.id === "bs-inprog-01");
  assert.ok(inProg, "task in_progress no backlog deve aparecer");
  assert.strictEqual(inProg.status, "in_progress");
  assert.strictEqual(inProg.backlogInProgress, true);

  fs.rmSync(root, { recursive: true, force: true });
});
