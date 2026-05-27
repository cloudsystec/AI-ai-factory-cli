import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    backlogFile,
    isValidProjectSlug,
    npmTestPrefix,
    repoRelativePosix,
    taskStateFile,
    workspaceRoot,
} from "./project-paths.js";
import { readBacklogFile } from "./backlog-io.js";
import { clearQaVerdict, readQaVerdict, qaVerdictFile } from "./qa-verdict.js";
import { readAgentFile, readGlobalRules, systemSecurityRules } from "./agent-prompts.js";
import { runCursorAgent } from "./cursor-agent-runner.js";
import {
    flushPendingSettlements,
    installBillingSignalHandlers,
} from "../src/ai-call-billing.js";
import {
    setupGitForTask,
    finalizeGitForTask,
    resolveHumanAgentAfterPipeline,
    codePathPrompt,
    npmTestPrefixForTask,
} from "./git/run-task-git.js";
import { getExecutionStateFromBack } from "../src/back-client.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("task");

const STEP_ORDER = ["dev", "qa", "finalize"];

const project = process.argv[2];
const taskId = process.argv[3];

if (!project || !taskId || !isValidProjectSlug(project)) {
    console.error("Uso: node orchestrator/run-task.js <projeto> <TASK-ID>");
    console.error("Ex.: node orchestrator/run-task.js barber-scheduler TASK-001");
    process.exit(1);
}

const backlogPath = backlogFile(project);
const stateFile = taskStateFile(project);
const wsRoot = workspaceRoot(project);
const reportRootPrompt = repoRelativePosix(wsRoot);
const testPrefix = npmTestPrefixForTask(project, taskId);
const codeRootPrompt = codePathPrompt(project, taskId);
const MAX_QA_FAILURE_RETRIES = Number(process.env.MAX_QA_FAILURE_RETRIES ?? 3);
const qaVerdictRel = repoRelativePosix(qaVerdictFile(wsRoot, taskId));

if (!fs.existsSync(backlogPath)) {
    console.error(`Backlog não encontrado: ${backlogPath}`);
    process.exit(1);
}

const backlogDoc = readBacklogFile(backlogPath, { project });
const task = backlogDoc.tasks.find((t) => t.id === taskId);

if (!task) {
    console.error(`Tarefa não encontrada no backlog do projeto "${project}": ${taskId}`);
    process.exit(1);
}

function read(file) {
    return fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
}

function loadState() {
    if (!fs.existsSync(stateFile)) return [];
    return JSON.parse(read(stateFile));
}

function saveState(state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

/** Garante que lastCompletedStep nunca anda para trás. */
function maxStep(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const ia = STEP_ORDER.indexOf(a);
    const ib = STEP_ORDER.indexOf(b);
    return ia >= ib ? a : b;
}

function updateTaskState(status, currentAgent, extra = {}) {
    const state = loadState();
    const index = state.findIndex((t) => t.id === task.id);

    const prev = index >= 0 ? state[index] : {};
    if (extra.lastCompletedStep || prev.lastCompletedStep) {
        extra.lastCompletedStep = maxStep(prev.lastCompletedStep, extra.lastCompletedStep);
    }

    const item = {
        id: task.id,
        title: task.title,
        project,
        status,
        currentAgent,
        updatedAt: new Date().toISOString(),
        ...extra,
    };

    if (index >= 0) {
        state[index] = { ...state[index], ...item };
    } else {
        state.push(item);
    }

    saveState(state);
}

function getTaskState() {
    const state = loadState();
    return state.find((t) => t.id === task.id) || null;
}

class PauseRequestedError extends Error {
    constructor(step) {
        super(`Pause pedido após passo "${step}"`);
        this.step = step;
        this.isPause = true;
    }
}

class InfraError extends Error {
    constructor(step, cause) {
        super(cause?.message || `Erro de infra no passo "${step}"`);
        this.failedStep = step;
        this.blockReason = "infra";
        if (cause) this.cause = cause;
    }
}

function classifyError(error) {
    const msg = String(error?.message || "").toLowerCase();
    if (msg.includes("git push") || msg.includes("non-fast-forward")) return "infra";
    if (msg.includes("git pull") || msg.includes("git fetch")) return "infra";
    if (msg.includes("enoent") || msg.includes("eacces")) return "infra";
    if (msg.includes("fetch failed") || msg.includes("network")) return "infra";
    if (msg.includes("cursor") && msg.includes("auth")) return "infra";
    if (msg.includes("workspace ausente")) return "infra";
    if (msg.includes("stale info") || msg.includes("rejected")) return "infra";
    if (msg.includes("authentication failed")) return "infra";
    return "agent";
}

const STEP_TO_STATUS = {
    dev: "development",
    qa: "testing",
    finalize: "blocked",
};

function resolveErrorState(error, currentState) {
    const lastStep = currentState?.lastCompletedStep || null;
    const msg = String(error?.message || "").toLowerCase();

    if (error instanceof InfraError && error.failedStep === "finalize") {
        const isPrIssue = msg.includes("merge") || msg.includes("conflict")
            || msg.includes("review") || msg.includes("pull request")
            || msg.includes("422") || msg.includes("403");
        return {
            status: "blocked",
            label: isPrIssue ? "Resolver PR" : "Erro Git (push/PR)",
            lastCompletedStep: maxStep(lastStep, "qa"),
            blockReason: "infra",
            failedStep: "finalize",
        };
    }

    if (error instanceof InfraError) {
        return {
            status: "blocked",
            label: `Infra: ${error.failedStep}`,
            lastCompletedStep: lastStep,
            blockReason: "infra",
            failedStep: error.failedStep,
        };
    }

    const reason = classifyError(error);

    if (reason === "infra") {
        const failed = lastStep
            ? STEP_ORDER[STEP_ORDER.indexOf(lastStep) + 1] || "unknown"
            : "unknown";
        return {
            status: "blocked",
            label: `Infra: ${error.message?.slice(0, 80) || "erro"}`,
            lastCompletedStep: lastStep,
            blockReason: "infra",
            failedStep: failed,
        };
    }

    if (msg.includes("qa max retries")) {
        return {
            status: "blocked",
            label: "QA FAIL (max retries)",
            lastCompletedStep: maxStep(lastStep, "dev"),
            blockReason: "agent",
            failedStep: "qa",
        };
    }

    const failed = lastStep
        ? STEP_ORDER[STEP_ORDER.indexOf(lastStep) + 1] || "unknown"
        : STEP_ORDER[0];

    return {
        status: "blocked",
        label: `Falha: ${error.message?.slice(0, 80) || "erro no agente"}`,
        lastCompletedStep: lastStep,
        blockReason: "agent",
        failedStep: failed,
    };
}

async function checkPause(completedStep) {
    updateTaskState("running", `checkpoint:${completedStep}`, { lastCompletedStep: completedStep });
    try {
        const state = await getExecutionStateFromBack(project);
        if (state.pauseAfterCurrent) {
            console.log(`\n=== Pause pedido — parando após "${completedStep}" ===\n`);
            updateTaskState("paused", `Pausado após ${completedStep}`, { lastCompletedStep: completedStep });
            throw new PauseRequestedError(completedStep);
        }
    } catch (err) {
        if (err instanceof PauseRequestedError) throw err;
        console.warn(`[warn] Não foi possível verificar pause: ${err.message}`);
    }
}

const resumeFromStep = process.env.AI_FACTORY_RESUME_STEP || null;
const retryMode = process.env.AI_FACTORY_RETRY_MODE || null;   // "infra" | "agent" | null
const retryFailedStep = process.env.AI_FACTORY_FAILED_STEP || null;

function effectiveResumeStep() {
    if (resumeFromStep) return resumeFromStep;
    const current = getTaskState();
    return current?.lastCompletedStep || null;
}

function shouldSkipStep(stepId) {
    const resume = effectiveResumeStep();
    if (!resume) return false;
    const resumeIdx = STEP_ORDER.indexOf(resume);
    const stepIdx = STEP_ORDER.indexOf(stepId);
    if (resumeIdx < 0 || stepIdx < 0) return false;
    return stepIdx <= resumeIdx;
}

function shouldSkipAgents() {
    const v = process.env.AI_FACTORY_SKIP_AGENTS;
    return v === "1" || v === "true";
}

function runAgent(roleFile, status, agentName, instruction, meta = {}) {
    updateTaskState(status, agentName);
    log.debug(`Preparando agente`, { agent: agentName, role: roleFile, task: task.id });

    const prompt = `
Leia AGENTS.md e ${roleFile}.

Conteúdo de AGENTS.md:
${readGlobalRules()}

Conteúdo de ${roleFile}:
${readAgentFile(roleFile)}

Tarefa:
${JSON.stringify(task, null, 2)}

Diretório do projeto (raiz de todos os artefatos desta task):
${reportRootPrompt}/

Caminhos obrigatórios para documentação (relativos ao diretório do projeto acima):
- docs/tasks/${task.id}.md
- reports/tasks/${task.id}-planner.md
- reports/tasks/${task.id}-dev.md
- reports/tasks/${task.id}-qa.md
- reports/tasks/${task.id}-reviewer.md
- evidence/tests/${task.id}-test-output.txt

Regras obrigatórias:
- Grave a documentação da task em ${reportRootPrompt}/docs/tasks/${task.id}.md.
- Grave o relatório do agente correspondente em ${reportRootPrompt}/reports/tasks/.
- Se rodar testes, grave a saída em ${reportRootPrompt}/evidence/tests/${task.id}-test-output.txt.
- Se não conseguir executar terminal/testes, registre isso no relatório.
- Não diga que passou nos testes sem evidência gravada.

Instrução:
${instruction}

${systemSecurityRules()}
`;

    console.log(`\n=== Rodando ${agentName} ===\n`);

    const agentStartMs = Date.now();
    runCursorAgent({
        agentFile: roleFile,
        agentName,
        prompt,
        skipAgents: shouldSkipAgents(),
        meta: { project, task: task.id, ...meta },
    });
    const agentElapsedMs = Date.now() - agentStartMs;
    log.debug(`Agente finalizado`, {
        agent: agentName,
        task: task.id,
        elapsedMs: agentElapsedMs,
        elapsedSec: `${(agentElapsedMs / 1000).toFixed(1)}s`,
    });
}

function evidenceAbsolutePath(id) {
    return path.join(wsRoot, "evidence", "tests", `${id}-test-output.txt`);
}

function runTests(id) {
    updateTaskState("testing", "Local Test Runner");

    const evidenceFileAbs = evidenceAbsolutePath(id);
    fs.mkdirSync(path.dirname(evidenceFileAbs), { recursive: true });
    const evidenceFile = repoRelativePosix(evidenceFileAbs);
    const effectiveTestPrefix = npmTestPrefixForTask(project, id);

    console.log(`\n=== Rodando testes locais para ${id} ===\n`);

    const testStartMs = Date.now();
    log.debug(`Executando testes`, { task: id, prefix: effectiveTestPrefix });

    const result = spawnSync("npm", ["test", "--prefix", effectiveTestPrefix], {
        cwd: process.cwd(),
        shell: true,
        encoding: "utf-8",
    });

    const output = [
        `TASK: ${id}`,
        `COMMAND: npm test --prefix ${effectiveTestPrefix}`,
        `EXIT_CODE: ${result.status}`,
        "",
        "STDOUT:",
        result.stdout || "",
        "",
        "STDERR:",
        result.stderr || "",
    ].join("\n");

    fs.writeFileSync(evidenceFileAbs, output, "utf-8");

    console.log(output);

    const testElapsedMs = Date.now() - testStartMs;
    log.debug(`Testes finalizados`, {
        task: id,
        exitCode: result.status,
        passed: result.status === 0,
        elapsedMs: testElapsedMs,
        elapsedSec: `${(testElapsedMs / 1000).toFixed(1)}s`,
    });

    return {
        passed: result.status === 0,
        evidenceFile,
        evidenceFileAbs,
        exitCode: result.status,
    };
}

function cleanupTestEvidence(id) {
    const evidenceFileAbs = evidenceAbsolutePath(id);

    if (fs.existsSync(evidenceFileAbs)) {
        fs.unlinkSync(evidenceFileAbs);
        console.log(`\nEvidência bruta removida: ${repoRelativePosix(evidenceFileAbs)}\n`);
    }
}

async function checkPrAlreadyMerged(gitCtx, taskId, onLine = () => {}) {
    const token = gitCtx.githubInstallationToken || process.env.AI_FACTORY_GITHUB_TOKEN;
    const repoFull = gitCtx.git?.repoFullName || process.env.AI_FACTORY_GIT_REPO;
    if (!token || !repoFull) return false;

    const branch = `task/${taskId}`;
    const [owner, repo] = repoFull.split("/");

    try {
        const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=closed`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            }
        );
        if (!res.ok) return false;
        const prs = await res.json();
        const merged = prs.find((pr) => pr.merged_at);
        if (merged) {
            onLine(`[git] PR #${merged.number} já mergeado em ${merged.merged_at}\n`);
            return true;
        }
    } catch {
        onLine(`[git] Não foi possível verificar estado do PR\n`);
    }
    return false;
}

installBillingSignalHandlers();

async function runTaskPipeline() {
    const taskPipelineStartMs = Date.now();
    log.debug(`Pipeline de task iniciado`, { project, task: taskId, title: task.title });

    const jobGitCtx = {
        githubInstallationToken: process.env.AI_FACTORY_GITHUB_TOKEN,
        git: {
            repoFullName: process.env.AI_FACTORY_GIT_REPO,
            techLeadBranch: process.env.AI_FACTORY_TECH_LEAD_BRANCH || "tech-lead",
        },
    };
    if (process.env.AI_FACTORY_GITHUB_TOKEN) {
        const gitSetupStart = Date.now();
        log.debug(`Git setup para task`, { task: taskId });
        await setupGitForTask(project, taskId, {
            git: jobGitCtx,
            onLine: (l) => console.log(l),
        });
        log.debug(`Git setup concluído`, { task: taskId, elapsedMs: Date.now() - gitSetupStart });
    }

    let billingSettled = false;

    const eff = effectiveResumeStep();
    if (retryMode === "infra" && retryFailedStep) {
        console.log(`\n=== Retry infra — re-executar apenas "${retryFailedStep}" ===\n`);
    } else if (retryMode === "agent") {
        console.log(`\n=== Retry agente — re-executar ciclo dev + qa ===\n`);
    } else if (eff) {
        const nextIdx = STEP_ORDER.indexOf(eff) + 1;
        const nextStep = STEP_ORDER[nextIdx] || "?";
        console.log(`\n=== Retomando pipeline após "${eff}" → inicia em "${nextStep}" ===\n`);
    }

    try {
        if (retryMode === "infra" && retryFailedStep === "finalize") {
            updateTaskState("running", "Verificando PR…");

            const prMerged = await checkPrAlreadyMerged(jobGitCtx, taskId, (l) => console.log(l));
            if (prMerged) {
                console.log(`\n=== PR já mergeado — task concluída sem custo ===\n`);
                cleanupTestEvidence(task.id);
                updateTaskState("done", resolveHumanAgentAfterPipeline(project), {
                    lastCompletedStep: "finalize",
                    blockReason: null,
                    failedStep: null,
                });
                await flushPendingSettlements();
                billingSettled = true;
                return;
            }

            updateTaskState("running", "Retry infra (finalize)");
            cleanupTestEvidence(task.id);
            if (process.env.AI_FACTORY_GITHUB_TOKEN) {
                await finalizeGitForTask(project, taskId, task, {
                    jobId: process.env.AI_FACTORY_JOB_ID,
                    git: jobGitCtx,
                    microId: task.sourceMicroId,
                    onLine: (l) => console.log(l),
                });
                console.log("\n=== Aguardando propagação do PR (5s)… ===\n");
                await new Promise((r) => setTimeout(r, 5000));
            }
            updateTaskState("done", resolveHumanAgentAfterPipeline(project), {
                lastCompletedStep: "finalize",
                blockReason: null,
                failedStep: null,
            });
            await flushPendingSettlements();
            billingSettled = true;
            return;
        }

        // --- DEV ---
        if (!shouldSkipStep("dev") || retryMode === "agent") {
            runAgent(
                "agents/dev.md",
                "development",
                "Dev Agent",
                `Implemente a tarefa dentro de ${codeRootPrompt}/ (código da aplicação).
O package.json do projeto deve ficar em ${codeRootPrompt}/package.json.

Contexto da task:
- Descrição: ${task.description}
- Critérios de aceite: ${JSON.stringify(task.acceptance)}
- Estratégia de teste: ${task.testStrategy || "Executar npm test"}

O orquestrador executa \`npm test --prefix ${testPrefix}\` após o Dev encerrar. Garanta que o script "test" no package.json funcione.
Grave relatórios em ${reportRootPrompt}/reports/tasks/${task.id}-dev.md.
Atualize ${reportRootPrompt}/docs/tasks/${task.id}.md com arquivos alterados e decisões.`,
                { step: "development" }
            );
            await checkPause("dev");
        } else {
            console.log(`\n=== Saltando Dev (já concluído) ===\n`);
        }

        // --- QA LOOP (sem pause dentro do ciclo QA-fail → Dev) ---
        if (!shouldSkipStep("qa") || retryMode === "agent") {
            for (let qaRound = 0; ; qaRound++) {
                const testResult = runTests(task.id);

                clearQaVerdict(wsRoot, task.id);

                runAgent(
                    "agents/qa.md",
                    "testing",
                    "QA Agent",
                    `Valide a implementação dentro de ${codeRootPrompt}/.

            O orquestrador já executou os testes localmente.

            Evidência temporária disponível em:
            ${testResult.evidenceFile}

            Resultado técnico:
            - exitCode: ${testResult.exitCode}
            - passed: ${testResult.passed}

            Leia a evidência.
            Grave o relatório final em ${reportRootPrompt}/reports/tasks/${task.id}-qa.md.
            Informe se os testes passaram ou falharam.
            Registre bugs, riscos e observações.
            Não tente rodar npm test novamente.

            OBRIGATÓRIO — gate do orquestrador:
            Crie o ficheiro ${qaVerdictRel} com JSON válido no formato:
            { "verdict": "pass" | "fail", "summary": "uma frase objetiva" }
            - Use "fail" se existir bug, critério de aceite não cumprido, ou exitCode != 0 sem justificativa explícita no relatório QA.
            - Use "pass" só se estiver seguro para seguir para o Reviewer.
            Se gravar "fail", o orquestrador manda o Dev corrigir, volta a correr testes e chama o QA de novo — a task não segue com erro.`,
                    { step: "testing", qaRound }
                );

                const verdict = readQaVerdict(wsRoot, task.id);
                if (verdict.verdict === "pass") {
                    console.log(`\n=== QA aprovou (veredito): ${verdict.summary || "ok"} ===\n`);
                    break;
                }

                if (qaRound >= MAX_QA_FAILURE_RETRIES) {
                    console.error(
                        `\nQA reprovou após ${MAX_QA_FAILURE_RETRIES + 1} ronda(s) de QA. Último motivo: ${verdict.summary}\n`
                    );
                    throw new Error("QA max retries");
                }

                console.warn(
                    `\n=== QA reprovou (ronda ${qaRound + 1}/${MAX_QA_FAILURE_RETRIES + 1}): ${verdict.summary}\n=== Dev: corrigir; em seguida novos testes + QA ===\n`
                );

                runAgent(
                    "agents/dev.md",
                    "development",
                    "Dev Agent",
                    `Correção pós-QA (ciclo ${qaRound + 2}): o QA reprovou.
Leia integralmente:
- ${reportRootPrompt}/reports/tasks/${task.id}-qa.md
- ${qaVerdictRel}
Corrija os problemas reportados no código em ${codeRootPrompt}/.
O orquestrador executa \`npm test --prefix ${testPrefix}\` após esta correção.
Acrescente secção de correção em ${reportRootPrompt}/reports/tasks/${task.id}-dev.md.`,
                    { step: "development_correction", qaRound: qaRound + 1 }
                );
            }
            await checkPause("qa");
        } else {
            console.log(`\n=== Saltando QA (já concluído) ===\n`);
        }

        // --- FINALIZE ---
        cleanupTestEvidence(task.id);

        if (process.env.AI_FACTORY_GITHUB_TOKEN) {
            updateTaskState("running", "Verificando PR…", { lastCompletedStep: "qa" });
            const alreadyMerged = await checkPrAlreadyMerged(jobGitCtx, taskId, (l) => console.log(l));
            if (alreadyMerged) {
                console.log(`\n=== PR já mergeado — task concluída ===\n`);
                updateTaskState("done", resolveHumanAgentAfterPipeline(project), {
                    lastCompletedStep: "finalize",
                    blockReason: null,
                    failedStep: null,
                });
                return;
            }

            updateTaskState("running", "Git push / PR", { lastCompletedStep: "qa" });
            try {
                await finalizeGitForTask(project, taskId, task, {
                    jobId: process.env.AI_FACTORY_JOB_ID,
                    git: jobGitCtx,
                    microId: task.sourceMicroId,
                    onLine: (l) => console.log(l),
                });
            } catch (gitErr) {
                throw new InfraError("finalize", gitErr);
            }
            console.log("\n=== Aguardando propagação do PR (5s)… ===\n");
            await new Promise((r) => setTimeout(r, 5000));
        }

        const pipelineElapsedMs = Date.now() - taskPipelineStartMs;
        log.debug(`Pipeline de task concluído com sucesso`, {
            task: taskId,
            elapsedMs: pipelineElapsedMs,
            elapsedSec: `${(pipelineElapsedMs / 1000).toFixed(1)}s`,
        });
        updateTaskState("done", resolveHumanAgentAfterPipeline(project), { lastCompletedStep: "finalize", blockReason: null, failedStep: null });
    } catch (error) {
        if (error instanceof PauseRequestedError) {
            console.log(`\n=== Pipeline pausado após "${error.step}" — retomável ===\n`);
        } else {
            const resolved = resolveErrorState(error, getTaskState());
            updateTaskState(resolved.status, resolved.label, {
                lastCompletedStep: resolved.lastCompletedStep,
                blockReason: resolved.blockReason,
                failedStep: resolved.failedStep,
            });
            const failElapsedMs = Date.now() - taskPipelineStartMs;
            log.debug(`Pipeline de task falhou`, {
                task: taskId,
                status: resolved.status,
                reason: resolved.blockReason,
                failedStep: resolved.failedStep,
                elapsedMs: failElapsedMs,
                elapsedSec: `${(failElapsedMs / 1000).toFixed(1)}s`,
            });
            console.error(`[${resolved.status}] reason=${resolved.blockReason} failedStep=${resolved.failedStep} label="${resolved.label}" ${error.message}`);
            throw error;
        }
    } finally {
        if (!billingSettled) {
            await flushPendingSettlements();
            billingSettled = true;
        }
    }
}

runTaskPipeline().catch((err) => {
    console.error(err);
    process.exit(1);
});
