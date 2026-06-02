import fs from "node:fs";
import {
  backlogFile,
  macroScopeFile,
  microScopeFile,
  repoRelativePosix,
} from "./project-paths.js";
import { readBacklogFile } from "./backlog-io.js";
import {
  readMicrosFromPath,
  computeWaveDeliveryFromData,
} from "./micro-delivery.js";

/**
 * @param {string} project
 */
export function resolveMacroIdForProject(project) {
  const bp = backlogFile(project);
  if (fs.existsSync(bp)) {
    const doc = readBacklogFile(bp, { project });
    if (doc.macroId) return doc.macroId;
  }
  return project;
}

/**
 * @param {unknown[]} items tasks-state entries
 */
export function devPipelineAnyRunning(items) {
  if (!Array.isArray(items)) return false;
  return items.some((t) =>
    ["planning", "development", "testing", "review"].includes(t.status)
  );
}

/**
 * @param {string} abs
 */
function toPosix(abs) {
  try {
    return repoRelativePosix(abs);
  } catch {
    return abs;
  }
}

/**
 * @param {string} macroAbs
 */
function readMacroScopeBody(macroAbs) {
  if (!fs.existsSync(macroAbs)) return "";
  const raw = fs.readFileSync(macroAbs, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  let bodyStart = 0;
  if (lines[0]?.startsWith("# ")) {
    bodyStart = 1;
    while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
      bodyStart += 1;
    }
  }
  return lines.slice(bodyStart).join("\n").trim();
}

/**
 * @param {object[]} tasks
 */
function backlogDevInProgress(tasks) {
  return tasks.some((t) =>
    ["in_progress", "planning", "development", "testing", "review"].includes(t.status)
  );
}

/**
 * Estado agregado do pipeline de escopo + hint da onda atual (read-only).
 * @param {string} project
 * @param {{ tasksState?: unknown[] }} [opts]
 */
export function getScopeDashboardState(project, opts = {}) {
  const macroId = resolveMacroIdForProject(project);
  const macroAbs = macroScopeFile(project, macroId);
  const microAbs = microScopeFile(project, macroId);
  const backlogAbs = backlogFile(project);

  const macroExists = fs.existsSync(macroAbs);
  const micros = readMicrosFromPath(microAbs);
  const doc = readBacklogFile(backlogAbs, { project, macroId });
  const tasks = doc.tasks;

  const runtimeState = Array.isArray(opts.tasksState) ? opts.tasksState : [];
  const runtimeStateById = new Map(runtimeState.map((t) => [t.id, t]));

  const pendingPo = micros.filter((m) => m.validationStatus !== "approved").length;
  const approvedMicros = micros.filter(
    (m) => m.validationStatus === "approved" && m.approved === true
  );
  const microPoDone =
    micros.length > 0 && pendingPo === 0 && approvedMicros.length > 0;

  const { openMicro, deliveryStatusById } = computeWaveDeliveryFromData(
    micros,
    tasks,
    runtimeStateById
  );

  const wavesCompleteScenario = microPoDone && !openMicro;

  const allTasksSuccessful =
    tasks.length > 0 &&
    tasks.every((t) => {
      const rt = runtimeStateById.get(t.id);
      const st = rt?.status || t.status;
      return st === "done" && !rt?.blockReason;
    });

  const projectCompleted =
    Boolean(opts.projectCompleted) ||
    (wavesCompleteScenario && allTasksSuccessful);

  const subsetOpen = openMicro
    ? tasks.filter((t) => t.sourceMicroId === openMicro.id)
    : [];

  const pendingTl = subsetOpen.filter((t) => t.approved !== true).length;
  const todoApproved = subsetOpen.filter(
    (t) => t.approved === true && t.status === "todo"
  ).length;
  const allOpenDone =
    openMicro &&
    subsetOpen.length > 0 &&
    subsetOpen.every((t) => t.status === "done");

  const devRunning = devPipelineAnyRunning(opts.tasksState);
  const backlogWaveDev = openMicro ? backlogDevInProgress(subsetOpen) : false;

  let currentKey = "idle";
  let currentLabel = "Sem passo de escopo identificado";
  let hint = "";

  if (!macroExists) {
    currentKey = "no_macro";
    currentLabel = "Definir escopo macro";
    hint = toPosix(macroAbs);
  } else if (micros.length === 0) {
    currentKey = "micro_generate";
    currentLabel = "Gerar microescopos (FASE 1)";
    hint = `npm run scope -- ${project} ${macroId}`;
  } else if (!microPoDone) {
    currentKey = "micro_po";
    currentLabel = "Micros — validação PO / refino (FASE 2)";
    hint =
      pendingPo > 0
        ? `${pendingPo} micro(s) sem validationStatus approved`
        : "Nenhum micro aprovado pelo PO";
  } else if (projectCompleted) {
    currentKey = "project_completed";
    currentLabel = "Projeto concluído — todas as micros e tasks executadas";
    hint = "Execução desactivada. Consulte o resumo de finalização.";
  } else if (wavesCompleteScenario) {
    currentKey = "waves_done";
    currentLabel = "Ondas de escopo concluídas (nenhum micro open)";
    hint =
      "Todas as ondas fechadas ou ficheiro desatualizado — rode `npm run scope` para sincronizar ondas.";
  } else if (openMicro && allOpenDone) {
    currentKey = "wave_advance";
    currentLabel = "Onda atual: todas as tasks done — próxima onda";
    hint = `npm run scope -- ${project} ${macroId} --tasks-only`;
  } else if (openMicro && subsetOpen.length === 0) {
    currentKey = "tasks_generate";
    currentLabel = "Tasking — gerar tasks (FASE 4)";
    hint = `${openMicro.id} — ${openMicro.title}`;
  } else if (pendingTl > 0) {
    currentKey = "tasks_tl";
    currentLabel = "Tasking — validação Tech Lead (FASE 5–6)";
    hint = `${pendingTl} task(s) ainda não approved pelo TL`;
  } else if (devRunning || backlogWaveDev) {
    currentKey = "dev_running";
    currentLabel = "Implementação em curso";
    hint = devRunning
      ? "Agentes Planner/Dev/QA/Reviewer (tasks-state.json)"
      : "Estados no backlog (in_progress / testing / …)";
  } else if (todoApproved > 0) {
    currentKey = "dev_queue";
    currentLabel = "Pronto para desenvolvimento";
    hint = `npm run develop ${project} ${macroId}`;
  } else {
    currentKey = "tasks_in_flight";
    currentLabel = "Tasks da onda (outros estados no backlog)";
    hint = openMicro ? `${subsetOpen.length} task(s) em ${openMicro.id}` : "";
  }

  /** @type {{ key: string, label: string, state: "done" | "active" | "pending" }[]} */
  const scopeSteps = [
    { key: "macro", label: "Macro", state: "pending" },
    { key: "micro", label: "Micros & PO", state: "pending" },
    { key: "tasking", label: "Tasks (onda)", state: "pending" },
    { key: "dev", label: "Implementação", state: "pending" },
  ];

  scopeSteps[0].state = macroExists ? "done" : "active";

  if (!macroExists) {
    scopeSteps[1].state = "pending";
  } else if (!microPoDone) {
    scopeSteps[1].state = "active";
  } else {
    scopeSteps[1].state = "done";
  }

  if (projectCompleted) {
    scopeSteps[0].state = "done";
    scopeSteps[1].state = "done";
    scopeSteps[2].state = "done";
    scopeSteps[3].state = "done";
  } else if (!microPoDone) {
    scopeSteps[2].state = "pending";
    scopeSteps[3].state = "pending";
  } else if (wavesCompleteScenario) {
    scopeSteps[2].state = "done";
    scopeSteps[3].state = "done";
  } else if (openMicro && (subsetOpen.length === 0 || pendingTl > 0 || allOpenDone)) {
    scopeSteps[2].state = "active";
    scopeSteps[3].state = "pending";
  } else if (openMicro && subsetOpen.length > 0 && pendingTl === 0) {
    scopeSteps[2].state = "done";
    const devStepActive = devRunning || todoApproved > 0 || backlogWaveDev;
    scopeSteps[3].state = devStepActive ? "active" : "pending";
  } else {
    scopeSteps[2].state = "pending";
    scopeSteps[3].state = "pending";
  }

  if (!projectCompleted && devRunning) {
    scopeSteps[0].state = "done";
    scopeSteps[1].state = "done";
    scopeSteps[2].state = "done";
    scopeSteps[3].state = "active";
  }

  const macroScopeMd = macroExists ? readMacroScopeBody(macroAbs) : "";

  return {
    project,
    macroId,
    macroScopeMd,
    macroEditable: micros.length === 0,
    paths: {
      macro: toPosix(macroAbs),
      micro: toPosix(microAbs),
      backlog: toPosix(backlogAbs),
    },
    macroExists,
    microCount: micros.length,
    microsPendingPo: pendingPo,
    microsApproved: approvedMicros.length,
    micros: approvedMicros.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description || null,
      risks: m.risks || null,
      dependencies: m.dependencies || [],
      priority: m.priority ?? null,
      poScore: m.poScore ?? null,
      taskDeliveryStatus: deliveryStatusById.get(m.id) || m.taskDeliveryStatus || "locked",
      tasks: tasks
        .filter((t) => t.sourceMicroId === m.id)
        .map((t) => {
          const rt = runtimeStateById.get(t.id);
          return {
            id: t.id,
            title: t.title,
            status: rt?.status || t.status,
            lastCompletedStep: rt?.lastCompletedStep || null,
            blockReason: rt?.blockReason || null,
            failedStep: rt?.failedStep || null,
            approved: t.approved,
          };
        }),
    })),
    openMicro: openMicro
      ? {
          id: openMicro.id,
          title: openMicro.title,
          delivery:
            deliveryStatusById.get(openMicro.id) ??
            openMicro.taskDeliveryStatus ??
            null,
        }
      : null,
    waveTaskStats: {
      total: subsetOpen.length,
      pendingTl,
      todoApproved,
      allDone: Boolean(allOpenDone),
    },
    current: {
      key: currentKey,
      label: currentLabel,
      hint,
    },
    scopeSteps,
    devPipelineActive: projectCompleted ? false : devRunning,
    wavesCompleteScenario,
    projectCompleted,
    allTasksSuccessful,
  };
}
