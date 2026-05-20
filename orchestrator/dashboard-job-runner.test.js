import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobCommand,
  startJob,
  lineTriggersWaitingInput,
  DEVELOP_PROMPT_MARKER,
} from "./dashboard-job-runner.js";
import { DEVELOP_PROMPT_MARKER as MARKER_FROM_CONSTANTS } from "./pipeline-constants.js";

describe("buildJobCommand", () => {
  it("monta comandos scope, develop e task", () => {
    const scope = buildJobCommand("scope", "barber-scheduler", "barber-scheduler");
    assert.match(scope.command, /npm run scope/);
    assert.deepEqual(scope.argv.slice(-2), ["barber-scheduler", "barber-scheduler"]);

    const tasksOnly = buildJobCommand(
      "scope-tasks-only",
      "barber-scheduler",
      "barber-scheduler"
    );
    assert.ok(tasksOnly.argv.includes("--tasks-only"));

    const develop = buildJobCommand("develop", "barber-scheduler", "barber-scheduler");
    assert.match(develop.command, /develop-next\.js/);

    const task = buildJobCommand(
      "task",
      "barber-scheduler",
      "barber-scheduler",
      "bs-001-01"
    );
    assert.match(task.command, /run-task\.js/);
    assert.match(task.command, /bs-001-01/);
  });

  it("exige taskId para kind task", () => {
    assert.throws(() => buildJobCommand("task", "barber-scheduler", "m"), /taskId/);
  });
});

describe("lineTriggersWaitingInput", () => {
  it("deteta marker e pergunta S/N", () => {
    assert.equal(lineTriggersWaitingInput(DEVELOP_PROMPT_MARKER), true);
    assert.equal(
      lineTriggersWaitingInput("Iniciar próxima tarefa? (S/N)"),
      true
    );
    assert.equal(lineTriggersWaitingInput("Próxima task: bs-001-02"), false);
  });
});

describe("DEVELOP_PROMPT_MARKER", () => {
  it("é o mesmo em pipeline-constants e job-runner", () => {
    assert.equal(DEVELOP_PROMPT_MARKER, MARKER_FROM_CONSTANTS);
  });
});

describe("startJob validação", () => {
  it("rejeita project inválido", () => {
    assert.throws(
      () =>
        startJob({
          kind: "develop",
          project: "INVALID SLUG",
          macroId: "x",
        }),
      /inválido/
    );
  });

  it("rejeita task sem taskId", () => {
    assert.throws(
      () =>
        startJob({
          kind: "task",
          project: "barber-scheduler",
          macroId: "barber-scheduler",
        }),
      /taskId/
    );
  });
});
