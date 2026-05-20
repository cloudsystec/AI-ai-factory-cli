/**
 * Passos do pipeline de `orchestrator/run-task.js` (dashboard + API de detalhe).
 * "testing" divide-se por `currentAgent`: runner local vs QA.
 */
export const PIPELINE_STEPS = [
  { key: "planning", label: "Plano", short: "📋" },
  { key: "development", label: "Dev", short: "⚙" },
  { key: "test_run", label: "Testes", short: "🧪" },
  { key: "qa", label: "QA", short: "✅" },
  { key: "review", label: "Revisão", short: "👁" },
  { key: "done", label: "Entrega", short: "🚀" },
];

/**
 * Índice do passo em execução (0-based), ou -1 se bloqueado, -2 se desconhecido/fora do fluxo.
 * @param {{ status?: string, currentAgent?: string } | null | undefined} task
 */
export function getActiveStepIndex(task) {
  if (!task || task.status === "blocked") return -1;
  const { status, currentAgent } = task;
  const agent = String(currentAgent || "");

  if (status === "done") return 5;
  if (status === "review") return 4;
  if (status === "testing") {
    if (agent.includes("QA")) return 3;
    return 2;
  }
  if (status === "development") return 1;
  if (status === "planning") return 0;
  return -2;
}

/**
 * @param {{ status?: string, currentAgent?: string } | null | undefined} task
 * @param {number} stepIndex
 * @returns {"completed" | "active" | "pending" | "failed"}
 */
export function getStepVisualState(task, stepIndex) {
  if (!task) return "pending";

  if (task.status === "blocked") {
    return "pending";
  }

  const active = getActiveStepIndex(task);

  if (task.status === "done") {
    return "completed";
  }

  if (active === -2) {
    return "pending";
  }

  if (stepIndex < active) return "completed";
  if (stepIndex === active) return "active";
  return "pending";
}

/**
 * @param {{ status?: string } | null | undefined} task
 */
export function isPipelineRunning(task) {
  if (!task || task.status === "blocked") return false;
  return ["planning", "development", "testing", "review"].includes(task.status);
}

/**
 * @param {{ status?: string, currentAgent?: string } | null | undefined} runtime
 */
export function buildPipelineSummary(runtime) {
  const activeStepIndex = runtime ? getActiveStepIndex(runtime) : -2;
  const steps = PIPELINE_STEPS.map((step, i) => ({
    key: step.key,
    label: step.label,
    short: step.short,
    state: getStepVisualState(runtime, i),
  }));
  const activeStep =
    activeStepIndex >= 0 && activeStepIndex < PIPELINE_STEPS.length
      ? PIPELINE_STEPS[activeStepIndex]
      : null;
  return {
    activeStepIndex,
    activeLabel: activeStep?.label ?? null,
    steps,
  };
}
