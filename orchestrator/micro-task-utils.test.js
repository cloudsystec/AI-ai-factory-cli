import test from "node:test";
import assert from "node:assert/strict";
import {
  isMicroCloserTask,
  getMicroCloserTask,
  getNonCloserTasks,
  allNonCloserTasksDone,
  shouldRunTaskQa,
  filterEligibleForMicroCloser,
  isCloserEligible,
} from "./micro-task-utils.js";

const isDone = (task, stateByTaskId) =>
  stateByTaskId.get(task.id)?.status === "done" || task.status === "done";

test("isMicroCloserTask e shouldRunTaskQa", () => {
  assert.equal(isMicroCloserTask({ isMicroCloser: true }), true);
  assert.equal(isMicroCloserTask({}), false);
  assert.equal(shouldRunTaskQa({ isMicroCloser: true }, { id: "M1" }), true);
  assert.equal(shouldRunTaskQa({ isMicroCloser: false }, { id: "M1" }), false);
  assert.equal(shouldRunTaskQa({ isMicroCloser: true }, null), false);
});

test("getMicroCloserTask e getNonCloserTasks", () => {
  const tasks = [
    { id: "T1" },
    { id: "T2", isMicroCloser: true },
    { id: "T3" },
  ];
  assert.equal(getMicroCloserTask(tasks)?.id, "T2");
  assert.deepEqual(getNonCloserTasks(tasks).map((t) => t.id), ["T1", "T3"]);
});

test("allNonCloserTasksDone", () => {
  const tasks = [
    { id: "T1", status: "done" },
    { id: "T2", isMicroCloser: true },
    { id: "T3", status: "todo" },
  ];
  const state = new Map([["T1", { status: "done" }], ["T3", { status: "done" }]]);
  assert.equal(allNonCloserTasksDone(tasks, state, isDone), true);
  state.set("T3", { status: "development" });
  assert.equal(allNonCloserTasksDone(tasks, state, isDone), false);
});

test("filterEligibleForMicroCloser: exclui closer até irmãs done + PRs", async () => {
  const microTasks = [
    { id: "T1", status: "done" },
    { id: "T2", status: "todo" },
    { id: "C", isMicroCloser: true, status: "todo" },
  ];
  const state = new Map([
    ["T1", { status: "done" }],
    ["T2", { status: "todo" }],
    ["C", { status: "todo" }],
  ]);
  const eligible = [{ id: "T2" }, { id: "C" }];

  const blocked = await filterEligibleForMicroCloser(
    eligible,
    microTasks,
    state,
    isDone,
    async () => false
  );
  assert.deepEqual(blocked.map((t) => t.id), ["T2"]);

  const onlyCloser = await filterEligibleForMicroCloser(
    eligible,
    microTasks.map((t) => (t.id === "T2" ? { ...t, status: "done" } : t)),
    new Map([
      ["T1", { status: "done" }],
      ["T2", { status: "done" }],
      ["C", { status: "todo" }],
    ]),
    isDone,
    async () => true
  );
  assert.deepEqual(onlyCloser.map((t) => t.id), ["C"]);
});

test("isCloserEligible", async () => {
  const microTasks = [
    { id: "T1", status: "done" },
    { id: "C", isMicroCloser: true, status: "todo" },
  ];
  const state = new Map([
    ["T1", { status: "done" }],
    ["C", { status: "todo" }],
  ]);
  assert.equal(
    await isCloserEligible(microTasks, state, isDone, async () => true),
    true
  );
  assert.equal(
    await isCloserEligible(microTasks, state, isDone, async () => false),
    false
  );
});
