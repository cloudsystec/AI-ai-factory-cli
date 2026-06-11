import fs from "node:fs";
import path from "node:path";
import {
  macroScopeFile,
  ensureScopePipelineDirs,
  workspaceRoot,
  backlogFile as backlogFilePath,
  microScopeFile,
} from "./project-paths.js";
import { readAgentFile, readGlobalRules, systemSecurityRules } from "./agent-prompts.js";
import { runCursorAgent } from "./cursor-agent-runner.js";
import {
  flushPendingSettlements,
  installBillingSignalHandlers,
} from "../src/ai-call-billing.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("scope");
import { readBacklogFile, writeBacklogFile } from "./backlog-io.js";
import {
  readMicrosFromPath,
  writeMicrosToPath,
  syncTaskDeliveryFlags,
  getOpenMicro,
} from "./micro-delivery.js";

const argvRaw = process.argv.slice(2);
const tasksOnly = argvRaw.includes("--tasks-only");
const positionalArgs = argvRaw.filter((a) => !a.startsWith("--"));

const project = positionalArgs[0];
const macroId = positionalArgs[1];

const MAX_VALIDATION_ROUNDS = 3;

if (!project || !macroId) {
  console.error("Uso: npm run scope -- <projeto> <macro-id> [--tasks-only]");
  console.error("Exemplo: npm run scope -- barber-scheduler barber-scheduler");
  console.error(
    "  --tasks-only  Executa apenas FASEs 4–6 (tasks) para o micro em estado 'open'."
  );
  process.exit(1);
}

const projectWsRoot = workspaceRoot(project);
const macroFile = macroScopeFile(project, macroId);
const microFile = microScopeFile(project, macroId);
const backlogFile = backlogFilePath(project);
const reportsScopesDir = path.join(projectWsRoot, "reports", "scopes");

function ensureFolders() {
  ensureScopePipelineDirs(project);
}

function read(file) {
  return fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
}

function write(file, content) {
  fs.writeFileSync(file, content, "utf-8");
}

function readJson(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(read(file));
}

function writeJson(file, data) {
  write(file, JSON.stringify(data, null, 2));
}

function asArray(value, label) {
  if (Array.isArray(value)) return value;

  if (value && Array.isArray(value.tasks)) return value.tasks;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.microScopes)) return value.microScopes;

  console.warn(`${label} não está em formato de array. Usando lista vazia.`);
  return [];
}

function readMicros() {
  return readMicrosFromPath(microFile);
}

function writeMicros(micros) {
  writeMicrosToPath(microFile, micros);
}

function readBacklog() {
  return readBacklogFile(backlogFile, { project, macroId });
}

function writeBacklog(tasks) {
  const prev = readBacklog();
  writeBacklogFile(backlogFile, {
    project: prev.project || project,
    macroId: prev.macroId || macroId,
    tasks,
    updatedAt: new Date().toISOString(),
  });
}

function shouldSkipAgents() {
  const v = process.env.AI_FACTORY_SKIP_AGENTS;
  return v === "1" || v === "true";
}

function runAgent(agentFile, prompt, agentName, meta = {}) {
  const label = agentName || agentFile;
  log.debug(`Preparando agente`, { agent: label, file: agentFile, promptLen: prompt.length });

  const fullPrompt = `
Leia AGENTS.md e ${agentFile}.

Conteúdo de AGENTS.md:
${readGlobalRules()}

Conteúdo de ${agentFile}:
${readAgentFile(agentFile)}

${prompt}

${systemSecurityRules()}
`;

  const startMs = log.timerStart(`Agente ${label}`);
  runCursorAgent({
    agentFile,
    agentName,
    prompt: fullPrompt,
    skipAgents: shouldSkipAgents(),
    debugPromptDir: path.join(process.cwd(), "logs", "scope-debug"),
    meta: { project, macroId, ...meta },
  });
  log.timerEnd(`Agente ${label}`, startMs);
}

installBillingSignalHandlers();

function freezeApprovedMicros(currentMicros, updatedMicros) {
  const approvedMap = new Map();

  currentMicros.forEach((micro) => {
    if (micro.approved === true && micro.validationStatus === "approved") {
      approvedMap.set(micro.id, micro);
    }
  });

  return updatedMicros.map((micro) => {
    if (approvedMap.has(micro.id)) {
      return approvedMap.get(micro.id);
    }

    return micro;
  });
}

function freezeApprovedTasks(currentTasks, updatedTasks) {
  const frozenMap = new Map();

  currentTasks.forEach((task) => {
    if (
      task.status === "done" ||
      task.approved === true ||
      task.validationStatus === "approved"
    ) {
      frozenMap.set(task.id, task);
    }
  });

  return updatedTasks.map((task) => {
    if (frozenMap.has(task.id)) {
      return frozenMap.get(task.id);
    }

    return task;
  });
}

function normalizeMicroApproval() {
  const currentMicros = readMicros();

  const normalized = currentMicros.map((micro) => {
    if (micro.approved === true || micro.validationStatus === "approved") {
      return {
        ...micro,
        status: "validated",
        approved: true,
        validationStatus: "approved",
      };
    }

    return {
      ...micro,
      approved: false,
      status: micro.status || "needs_refinement",
      validationStatus: micro.validationStatus || "pending_validation",
    };
  });

  writeMicros(freezeApprovedMicros(currentMicros, normalized));
}

function normalizeTaskApproval() {
  const currentTasks = readBacklog().tasks;

  const normalized = currentTasks.map((task) => {
    if (task.status === "done") {
      return task;
    }

    if (task.approved === true || task.validationStatus === "approved") {
      return {
        ...task,
        status: "todo",
        approved: true,
        validationStatus: "approved",
      };
    }

    return {
      ...task,
      approved: false,
      status: task.status || "needs_refinement",
      validationStatus: task.validationStatus || "pending_validation",
    };
  });

  writeBacklog(freezeApprovedTasks(currentTasks, normalized));
}

function getApprovedMicros() {
  return readMicros().filter(
    (micro) => micro.approved === true && micro.validationStatus === "approved"
  );
}

function getMicrosToValidate() {
  return readMicros().filter(
    (micro) => micro.validationStatus !== "approved"
  );
}

function getTasksToValidate() {
  return readBacklog().tasks.filter(
    (task) =>
      task.validationStatus !== "approved" &&
      task.status !== "done"
  );
}

function getTasksToValidateForMicro(microId) {
  return readBacklog().tasks.filter(
    (task) =>
      task.sourceMicroId === microId &&
      task.validationStatus !== "approved" &&
      task.status !== "done"
  );
}

if (tasksOnly) {
  log.phase("Modo --tasks-only: FASEs 4–6 (micro open)");
}

async function runScopePipeline() {
const pipelineStartMs = Date.now();
log.debug("Pipeline de escopo iniciado", { project, macroId, tasksOnly });
ensureFolders();

if (!fs.existsSync(macroFile)) {
  console.error(`Escopo macro não encontrado: ${macroFile}`);
  process.exit(1);
}

function isMacroSimple(macroContent) {
  const lines = macroContent.trim().split("\n").filter(l => l.trim().length > 0);
  return lines.length <= 5 || macroContent.trim().length < 200;
}

const macroContent = read(macroFile);
const macroSimple = isMacroSimple(macroContent);

/**
 * FASE 1 — Gerar microescopos apenas se ainda não existir arquivo.
 */
if (!tasksOnly && !fs.existsSync(microFile)) {
  log.phase("FASE 1: Gerando microescopos");

  runAgent(
    "agents/macro-to-micro.md",
    `
Projeto:
${project}

Macro ID:
${macroId}

Escopo macro:
${read(macroFile)}

Crie o arquivo JSON:
${microFile}

Crie o relatório:
${path.join(reportsScopesDir, `${macroId}-macro-to-micro.md`)}

Regras:
- Avalie a complexidade do macro:
  - Se o macro descreve uma única feature ou sistema simples (ex.: "API com health e swagger"), gere **1 micro** (no máximo 2) com descrição ampla que comporte várias tasks.
  - Se o macro descreve múltiplas features independentes ou sistema complexo, gere **3 a 5 microescopos** (máximo 7).
- Cada micro = "fluxo de entrega" (wave), NÃO uma camada técnica isolada.
- Um micro deve comportar **2-5 tasks** de implementação; se gerar um micro que só teria 1 task, o micro é estreito demais — agrupe.
- NÃO atomize em camadas (ex.: "só bootstrap HTTP", "só health", "só config") — junte num único micro "API mínima utilizável".
- Evite micros que só produzem papel sem caminho claro para código/testes.
- Não gere tasks ainda.
- Não implemente código.
- O arquivo deve ser JSON válido com **array na raiz** (ex.: [{ "id": "...", ... }]), não um objeto envelope com chave microscopes.
- Cada microescopo deve ter:
  - id
  - project
  - macroId
  - title
  - description
  - dependencies
  - risks
  - status
  - approved
  - validationStatus
  - priority

Valores iniciais obrigatórios:
- status: "pending_validation"
- approved: false
- validationStatus: "pending_validation"
- priority: null
`,
    "Macro to Micro",
    { step: "macro_to_micro" }
  );
}

if (tasksOnly && !fs.existsSync(microFile)) {
  console.error(`Arquivo de microescopos não encontrado: ${microFile}`);
  process.exit(1);
}

if (!tasksOnly) {
/**
 * FASE 2 — Validar microescopos somente se houver algo não aprovado.
 */
log.phase("FASE 2: Validação PO dos microescopos");

const microCountAfterPhase1 = readMicros().length;
if (microCountAfterPhase1 === 0) {
  console.error(
    "\nNenhum microescopo legível em " +
      microFile +
      ". O JSON deve ser um array na raiz ou um objeto com campo microscopes/microScopes. " +
      "Corrija o ficheiro ou apague-o e volte a executar Gerar escopo.\n"
  );
  process.exit(1);
}

if (getMicrosToValidate().length === 0) {
  console.log("Todos os microescopos já estão aprovados. Pulando validação PO.");
} else if (macroSimple) {
  log.info("Macro simples — auto-aprovando micros (skip PO)");
  const all = readMicros().map((m, i) => ({
    ...m,
    approved: true,
    status: "validated",
    validationStatus: "approved",
    poScore: 95,
    priority: i + 1,
  }));
  writeMicros(all);
} else {
  for (let round = 1; round <= MAX_VALIDATION_ROUNDS; round++) {
    console.log(`\n--- Rodada PO ${round}/${MAX_VALIDATION_ROUNDS} ---\n`);

    const micros = readMicros();
    const microsToValidate = micros.filter(
      (micro) => micro.validationStatus !== "approved"
    );
    const frozenMicros = micros.filter(
      (micro) => micro.validationStatus === "approved"
    );

    const poReport = path.join(
      reportsScopesDir,
      `${macroId}-po-validation-round-${round}.json`
    );

    runAgent(
      "agents/po-micro-validator.md",
      `
Projeto:
${project}

Macro ID:
${macroId}

Escopo macro:
${read(macroFile)}

Arquivo de microescopos:
${microFile}

Microescopos para validar:
${JSON.stringify(microsToValidate, null, 2)}

Microescopos já aprovados e congelados:
${JSON.stringify(frozenMicros, null, 2)}

Crie o parecer JSON:
${poReport}

Regras:
- Validação orientada a **sistema utilizável**: reprove micro que não desemboca em implementação testável (só reorganizar texto sem entrega de software).
- Valide somente microescopos que NÃO estão approved.
- NÃO revalide itens com validationStatus="approved".
- NÃO altere itens já aprovados.
- Reprove escopos vagos, duplicados, grandes demais, pequenos demais ou sem valor funcional claro.
- Verifique alinhamento com o escopo macro.
- Verifique se cada microescopo tem fronteira clara.
- Verifique dependências.
- O parecer deve ser JSON válido.
- Se um microescopo estiver bom, atualize no arquivo ${microFile}:
  - approved: true
  - status: "validated"
  - validationStatus: "approved"
  - poScore: número >= 90
- Se precisar ajuste, mantenha:
  - approved: false
  - status: "needs_refinement"
  - validationStatus: "rejected"
  - poScore: número abaixo de 90
`,
      undefined,
      { step: "po_validation", round }
    );

    normalizeMicroApproval();

    if (getMicrosToValidate().length === 0) {
      console.log("\nTodos os microescopos foram aprovados pelo PO.\n");
      break;
    }

    if (round === MAX_VALIDATION_ROUNDS) {
      console.log("\nAinda há microescopos não aprovados após o limite de rodadas.");
      console.log("O pipeline continuará apenas com os microescopos aprovados.");
      break;
    }

    const allMicros = readMicros();
    const refinableMicros = allMicros.filter(
      (micro) => micro.validationStatus !== "approved"
    );
    const approvedMicrosFrozen = allMicros.filter(
      (micro) => micro.validationStatus === "approved"
    );

    runAgent(
      "agents/micro-refiner.md",
      `
Projeto:
${project}

Macro ID:
${macroId}

Escopo macro:
${read(macroFile)}

Arquivo de microescopos:
${microFile}

Microescopos refináveis:
${JSON.stringify(refinableMicros, null, 2)}

Microescopos congelados:
${JSON.stringify(approvedMicrosFrozen, null, 2)}

Parecer do PO:
${fs.existsSync(poReport) ? read(poReport) : "Parecer não encontrado."}

Atualize o arquivo:
${microFile}

Crie o relatório:
${path.join(reportsScopesDir, `${macroId}-micro-refiner-round-${round}.md`)}

Regras:
- Corrija somente microescopos rejected ou pending_validation.
- NUNCA altere microescopos congelados/aprovados.
- Preserve IDs existentes sempre que possível.
- Não recrie microescopos aprovados.
- Remova duplicidades.
- Divida microescopos grandes demais.
- Una microescopos pequenos demais quando fizer sentido.
- Melhore descrições vagas.
- Declare dependências.
- Mantenha JSON válido.
- Não crie tasks.
- Deixe itens corrigidos com:
  - status: "pending_validation"
  - approved: false
  - validationStatus: "pending_validation"
`,
      undefined,
      { step: "micro_refiner", round }
    );
  }
}

const approvedMicros = getApprovedMicros();

if (approvedMicros.length === 0) {
  console.error("\nNenhum microescopo aprovado. Pipeline encerrado.");
  process.exit(1);
}

/**
 * FASE 3 — Priorizar microescopos aprovados.
 */
log.phase("FASE 3: Priorizando microescopos aprovados");

runAgent(
  "agents/micro-prioritizer.md",
  `
Projeto:
${project}

Macro ID:
${macroId}

Arquivo de microescopos:
${microFile}

Microescopos aprovados:
${JSON.stringify(approvedMicros, null, 2)}

Crie o relatório:
${path.join(reportsScopesDir, `${macroId}-micro-prioritizer.md`)}

Regras:
- Priorize somente microescopos aprovados.
- NÃO altere microescopos rejeitados.
- NÃO altere validationStatus de microescopos aprovados.
- Defina priority numérica.
- Ordene por dependência, risco e valor.
- Mantenha JSON válido.
- Preserve o campo taskDeliveryStatus quando já existir (ondas de entrega); o orquestrador sincroniza open/locked/closed após esta fase.
`,
  "Micro Prioritizer",
  { step: "micro_prioritization" }
);
}

log.phase("Sincronizando ondas de entrega");
syncTaskDeliveryFlags({ microPath: microFile, backlogPath: backlogFile, project, macroId });
const microsForTarget = readMicrosFromPath(microFile);
const forcedMicroId = String(process.env.AI_FACTORY_TARGET_MICRO_ID || "").trim();
let targetMicro = null;
if (forcedMicroId) {
  targetMicro = microsForTarget.find((m) => m.id === forcedMicroId) ?? null;
  if (!targetMicro) {
    console.error(
      `Micro alvo "${forcedMicroId}" não encontrado em ${microFile}. Micros disponíveis: ${microsForTarget.map((m) => m.id).join(", ") || "(nenhum)"}`
    );
    process.exit(1);
  }
  log.info("Micro alvo (job payload)", { microId: forcedMicroId });
} else {
  targetMicro = getOpenMicro(microsForTarget);
}

if (!targetMicro) {
  console.log(
    "\nNenhum microescopo em estado 'open'. Possivelmente todas as ondas foram concluídas."
  );
  console.log("Revise", microFile, "e o backlog.");
  process.exit(0);
}

console.log(
  `\nMicro ativo para esta onda de tasks: ${targetMicro.id} — ${targetMicro.title}\n`
);

/**
 * FASE 4 — Gerar tasks entregáveis.
 */
log.phase("FASE 4: Gerando tasks entregáveis");

const currentBacklog = readBacklog();

const copilotInstructions = String(
  process.env.AI_FACTORY_COPILOT_INSTRUCTIONS || ""
).trim();
const replaceMicroTasks =
  process.env.AI_FACTORY_REPLACE_MICRO_TASKS === "1";

runAgent(
  "agents/micro-to-tasks.md",
  `
Projeto:
${project}

Macro ID:
${macroId}

Backlog atual:
${JSON.stringify(currentBacklog, null, 2)}

Microescopo ALVO desta onda (único permitido para NOVAS tasks):
${JSON.stringify(targetMicro, null, 2)}

Contexto — microescopos aprovados (somente leitura; não crie tasks fora do alvo):
${JSON.stringify(getApprovedMicros(), null, 2)}
${copilotInstructions ? `\nInstruções do utilizador (Copiloto):\n${copilotInstructions}\n` : ""}${replaceMicroTasks ? `\nModo replaceMicroTasks: o backlog deste micro foi limpo pelo painel — gere um conjunto NOVO de tasks (2-5) para o micro alvo.\n` : ""}

Crie ou atualize o backlog:
${backlogFile}

Crie o relatório:
${path.join(reportsScopesDir, `${macroId}-micro-to-tasks.md`)}

Formato obrigatório do backlog:
{
  "project": "${project}",
  "macroId": "${macroId}",
  "tasks": []
}

Regras:
- **2-5 tasks por micro** (mínimo 2, máximo 5); se o micro só teria 1 task, o micro deveria ter sido maior.
- Cada task deve ser entregável de forma independente dentro do contexto do micro.
- NÃO crie tasks "de documentação" ou "setup" isoladas — integre-as na task funcional.
- Tasks devem gerar **mudança em código** (\`src/\` ou equivalente) ou **testes**; \`docs/\` só como suporte, não entrega única.
- Critérios de aceite claros mas não hiper-prescritivos (sem listar cada ficheiro salvo quando crítico).
- Gere tasks entregáveis **somente** para o microescopo ALVO (id: ${targetMicro.id}).
- Toda task nova deve ter sourceMicroId exatamente igual a "${targetMicro.id}".
- Não crie tasks para outros microescopos nesta execução.
- Não duplique tasks existentes.
- Preserve tasks done.
- Preserve tasks já approved=true.
- Preserve tasks em development, testing e review.
- Cada task deve ter:
  - id
  - project
  - sourceMicroId
  - title
  - description
  - acceptance
  - dependencies
  - testStrategy
  - status
  - approved
  - validationStatus
  - priority

Valores iniciais para task nova:
- status: "pending_validation"
- approved: false
- validationStatus: "pending_validation"
`,
  undefined,
  { step: "task_generation", microId: targetMicro.id }
);

/**
 * FASE 5 — Validar tasks somente se houver algo não aprovado.
 */
log.phase("FASE 5: Validação Tech Lead das tasks");

if (getTasksToValidateForMicro(targetMicro.id).length === 0) {
  console.log(
    "Todas as tasks elegíveis do micro atual já estão aprovadas. Pulando validação Tech Lead."
  );
} else if (macroSimple) {
  log.info("Macro simples — auto-aprovando tasks (skip TL)");
  const current = readBacklog();
  const updated = current.tasks.map((t, i) => {
    if (t.sourceMicroId !== targetMicro.id) return t;
    if (t.validationStatus === "approved") return t;
    return {
      ...t,
      status: "todo",
      approved: true,
      validationStatus: "approved",
      techLeadScore: 95,
      priority: i + 1,
    };
  });
  writeBacklog(updated);
} else {
  for (let round = 1; round <= MAX_VALIDATION_ROUNDS; round++) {
    console.log(`\n--- Rodada Tech Lead ${round}/${MAX_VALIDATION_ROUNDS} ---\n`);

    const allTasks = readBacklog().tasks;
    const tasksToValidate = allTasks.filter(
      (task) =>
        task.sourceMicroId === targetMicro.id &&
        task.validationStatus !== "approved" &&
        task.status !== "done"
    );
    const frozenTasks = allTasks.filter((task) => {
      if (task.sourceMicroId !== targetMicro.id) return true;
      return task.validationStatus === "approved" || task.status === "done";
    });

    const techLeadReport = path.join(
      reportsScopesDir,
      `${macroId}-techlead-validation-round-${round}.json`
    );

    runAgent(
      "agents/techlead-task-validator.md",
      `
Projeto:
${project}

Macro ID:
${macroId}

Backlog:
${backlogFile}

Microescopo alvo (Tech Lead só neste micro):
${targetMicro.id}

Tasks para validar:
${JSON.stringify(tasksToValidate, null, 2)}

Tasks congeladas (outros micros ou já aprovadas/done):
${JSON.stringify(frozenTasks, null, 2)}

Crie o parecer JSON:
${techLeadReport}

Regras:
- Reprove tasks **só markdown** em \`docs/\` sem impacto em build ou testes executáveis, salvo exceção explícita no texto da task.
- Valide **apenas** tasks do micro ${targetMicro.id} listadas em "Tasks para validar".
- Valide somente tasks que NÃO estão approved e NÃO estão done.
- NÃO revalide tasks com validationStatus="approved".
- NÃO altere tasks done.
- NÃO altere tasks já aprovadas.
- Reprove tasks vagas, grandes demais ou sem critério de aceite testável.
- Reprove tasks sem estratégia de teste.
- Reprove tasks que misturam responsabilidades.
- Reprove tasks desalinhadas com a arquitetura do projeto.
- Se uma task estiver boa, atualize no backlog:
  - status: "todo"
  - approved: true
  - validationStatus: "approved"
  - techLeadScore: número >= 90
- Se uma task estiver ruim, atualize:
  - status: "needs_refinement"
  - approved: false
  - validationStatus: "rejected"
  - techLeadScore: número abaixo de 90
- Preserve o formato:
{
  "project": "${project}",
  "macroId": "${macroId}",
  "tasks": []
}
`,
      undefined,
      { step: "tl_validation", microId: targetMicro.id, round }
    );

    normalizeTaskApproval();

    if (getTasksToValidateForMicro(targetMicro.id).length === 0) {
      console.log("\nTodas as tasks foram aprovadas pelo Tech Lead.\n");
      break;
    }

    if (round === MAX_VALIDATION_ROUNDS) {
      console.log("\nAinda há tasks não aprovadas após o limite de rodadas.");
      console.log("Somente tasks approved=true e status=todo entrarão no desenvolvimento.");
      break;
    }

    const latestTasks = readBacklog().tasks;
    const refinableTasks = latestTasks.filter(
      (task) =>
        task.sourceMicroId === targetMicro.id &&
        task.validationStatus !== "approved" &&
        task.status !== "done"
    );
    const frozenTasksAfterValidation = latestTasks.filter((task) => {
      if (task.sourceMicroId !== targetMicro.id) return true;
      return task.validationStatus === "approved" || task.status === "done";
    });

    runAgent(
      "agents/task-refiner.md",
      `
Projeto:
${project}

Macro ID:
${macroId}

Backlog:
${backlogFile}

Tasks refináveis:
${JSON.stringify(refinableTasks, null, 2)}

Tasks congeladas:
${JSON.stringify(frozenTasksAfterValidation, null, 2)}

Parecer do Tech Lead:
${fs.existsSync(techLeadReport) ? read(techLeadReport) : "Parecer não encontrado."}

Atualize:
${backlogFile}

Crie o relatório:
${path.join(reportsScopesDir, `${macroId}-task-refiner-round-${round}.md`)}

Regras:
- Corrija somente tasks rejected ou pending_validation do micro ${targetMicro.id}.
- NUNCA altere tasks congeladas/aprovadas.
- NUNCA altere tasks done.
- Preserve IDs existentes sempre que possível.
- Não recrie tasks aprovadas.
- Divida tasks grandes demais.
- Melhore critérios de aceite.
- Adicione estratégia de teste.
- Declare dependências.
- Remova duplicidades.
- Mantenha JSON válido.
- Preserve o formato:
{
  "project": "${project}",
  "macroId": "${macroId}",
  "tasks": []
}
- Tasks corrigidas devem voltar para:
  - status: "pending_validation"
  - approved: false
  - validationStatus: "pending_validation"
`,
      undefined,
      { step: "task_refiner", microId: targetMicro.id, round }
    );
  }
}

/**
 * FASE 6 — Priorização final do backlog.
 */
log.phase("FASE 6: Priorizando backlog final");

runAgent(
  "agents/task-prioritizer.md",
  `
Projeto:
${project}

Backlog:
${backlogFile}

Conteúdo atual:
${JSON.stringify(readBacklog(), null, 2)}

Crie o relatório:
${path.join(reportsScopesDir, `${macroId}-task-prioritizer.md`)}

Regras:
- No micro "${targetMicro.id}", priorize tasks approved=true por dependência, risco e valor; garanta priority numérica coerente.
- Para tasks de outros micros, não altere ordem ou priority salvo ajuste mínimo inevitável para JSON válido.
- Preserve tasks done.
- Preserve tasks em andamento.
- NÃO altere tasks com validationStatus="approved", exceto priority no micro alvo.
- Preserve o formato:
{
  "project": "${project}",
  "macroId": "${macroId}",
  "tasks": []
}
`,
  undefined,
  { step: "task_prioritization", microId: targetMicro.id }
);

const pipelineElapsedMs = Date.now() - pipelineStartMs;
log.info("Pipeline de escopo concluído", { elapsedMs: pipelineElapsedMs, elapsedSec: `${(pipelineElapsedMs / 1000).toFixed(1)}s` });
syncTaskDeliveryFlags({ microPath: microFile, backlogPath: backlogFile, project, macroId });
console.log(`Backlog atualizado: ${backlogFile}`);
console.log("\nPara iniciar desenvolvimento (informe o macro-id):");
console.log(`npm run develop ${project} ${macroId}`);
console.log("\nPróximo lote de tasks do próximo micro (após fechar a onda atual):");
console.log(`npm run scope -- ${project} ${macroId} --tasks-only`);
await flushPendingSettlements();
}

runScopePipeline().catch((err) => {
  console.error(err);
  process.exit(1);
});