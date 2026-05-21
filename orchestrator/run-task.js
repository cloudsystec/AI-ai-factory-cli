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
import { readAgentFile, readGlobalRules } from "./agent-prompts.js";
import { runCursorAgent } from "./cursor-agent-runner.js";
import {
    beginBillingRound,
    endBillingRound,
    installBillingSignalHandlers,
} from "../src/ai-call-billing.js";

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
const projectRootPrompt = repoRelativePosix(wsRoot);
const MAX_QA_FAILURE_RETRIES = Number(process.env.MAX_QA_FAILURE_RETRIES ?? 5);
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

function updateTaskState(status, currentAgent) {
    const state = loadState();
    const index = state.findIndex((t) => t.id === task.id);

    const item = {
        id: task.id,
        title: task.title,
        project,
        status,
        currentAgent,
        updatedAt: new Date().toISOString(),
    };

    if (index >= 0) {
        state[index] = { ...state[index], ...item };
    } else {
        state.push(item);
    }

    saveState(state);
}

function shouldSkipAgents() {
    const v = process.env.AI_FACTORY_SKIP_AGENTS;
    return v === "1" || v === "true";
}

function runAgent(roleFile, status, agentName, instruction) {
    updateTaskState(status, agentName);

    const prompt = `
Leia AGENTS.md e ${roleFile}.

Conteúdo de AGENTS.md:
${readGlobalRules()}

Conteúdo de ${roleFile}:
${readAgentFile(roleFile)}

Tarefa:
${JSON.stringify(task, null, 2)}

Diretório do projeto (raiz de todos os artefatos desta task):
${projectRootPrompt}/

Caminhos obrigatórios para documentação (relativos ao diretório do projeto acima):
- docs/tasks/${task.id}.md
- reports/tasks/${task.id}-planner.md
- reports/tasks/${task.id}-dev.md
- reports/tasks/${task.id}-qa.md
- reports/tasks/${task.id}-reviewer.md
- evidence/tests/${task.id}-test-output.txt

Regras obrigatórias:
- Grave a documentação da task em ${projectRootPrompt}/docs/tasks/${task.id}.md.
- Grave o relatório do agente correspondente em ${projectRootPrompt}/reports/tasks/.
- Se rodar testes, grave a saída em ${projectRootPrompt}/evidence/tests/${task.id}-test-output.txt.
- Se não conseguir executar terminal/testes, registre isso no relatório.
- Não diga que passou nos testes sem evidência gravada.

Instrução:
${instruction}
`;

    console.log(`\n=== Rodando ${agentName} ===\n`);

    runCursorAgent({
        agentFile: roleFile,
        agentName,
        prompt,
        skipAgents: shouldSkipAgents(),
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
    const testPrefix = npmTestPrefix(project);

    console.log(`\n=== Rodando testes locais para ${id} ===\n`);

    const result = spawnSync("npm", ["test", "--prefix", testPrefix], {
        cwd: process.cwd(),
        shell: true,
        encoding: "utf-8",
    });

    const output = [
        `TASK: ${id}`,
        `COMMAND: npm test --prefix ${testPrefix}`,
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

installBillingSignalHandlers();

async function runTaskPipeline() {
    beginBillingRound({
        kind: "task",
        label: `task ${taskId}`,
        meta: { project, taskId },
    });

    let roundStatus = "completed";
    let billingSettled = false;

    try {
        runAgent(
            "agents/planner.md",
            "planning",
            "Planner Agent",
            `Planeje a execução da tarefa.
        Grave o plano em ${projectRootPrompt}/reports/tasks/${task.id}-planner.md.
        Atualize ${projectRootPrompt}/docs/tasks/${task.id}.md com escopo, critérios de aceite e plano.
        Não altere código.`
        );

        runAgent(
            "agents/dev.md",
            "development",
            "Dev Agent",
            `Implemente a tarefa dentro de ${projectRootPrompt}/ (código da aplicação e artefatos do projeto).
        Crie ou atualize testes.
        Antes de finalizar: o projeto deve **compilar** (npm run build --prefix ${npmTestPrefix(project)}). Só encerre com exit code 0.
        Registe o resultado na secção **## Compilação** do relatório dev. Não deixe erros de compilação para o QA.
        Rode npm test se possível (a partir da raiz do monorepo: npm test --prefix ${npmTestPrefix(project)}).
        Grave o relatório em ${projectRootPrompt}/reports/tasks/${task.id}-dev.md.
        Se rodar testes, grave a saída em ${projectRootPrompt}/evidence/tests/${task.id}-test-output.txt.
        Atualize ${projectRootPrompt}/docs/tasks/${task.id}.md com arquivos alterados, decisões e pendências.`
        );

        for (let qaRound = 0; ; qaRound++) {
            const testResult = runTests(task.id);

            clearQaVerdict(wsRoot, task.id);

            runAgent(
                "agents/qa.md",
                "testing",
                "QA Agent",
                `Valide a implementação dentro de ${projectRootPrompt}/.

        O orquestrador já executou os testes localmente.

        Evidência temporária disponível em:
        ${testResult.evidenceFile}

        Resultado técnico:
        - exitCode: ${testResult.exitCode}
        - passed: ${testResult.passed}

        Leia a evidência.
        Grave o relatório final em ${projectRootPrompt}/reports/tasks/${task.id}-qa.md.
        Informe se os testes passaram ou falharam.
        Registre bugs, riscos e observações.
        Não tente rodar npm test novamente.

        OBRIGATÓRIO — gate do orquestrador:
        Crie o ficheiro ${qaVerdictRel} com JSON válido no formato:
        { "verdict": "pass" | "fail", "summary": "uma frase objetiva" }
        - Use "fail" se existir bug, critério de aceite não cumprido, ou exitCode != 0 sem justificativa explícita no relatório QA.
        - Use "pass" só se estiver seguro para seguir para o Reviewer.
        Se gravar "fail", o orquestrador manda o Dev corrigir, volta a correr testes e chama o QA de novo — a task não segue com erro.`
            );

            const verdict = readQaVerdict(wsRoot, task.id);
            if (verdict.verdict === "pass") {
                console.log(`\n=== QA aprovou (veredito): ${verdict.summary || "ok"} ===\n`);
                break;
            }

            if (qaRound >= MAX_QA_FAILURE_RETRIES) {
                updateTaskState("blocked", "QA FAIL (max retries)");
                console.error(
                    `\nQA reprovou após ${MAX_QA_FAILURE_RETRIES + 1} ronda(s) de QA. Último motivo: ${verdict.summary}\n`
                );
                roundStatus = "failed";
                throw new Error("QA max retries");
            }

            console.warn(
                `\n=== QA reprovou (ronda ${qaRound + 1}/${MAX_QA_FAILURE_RETRIES + 1}): ${verdict.summary}\n=== Dev: corrigir; em seguida novos testes + QA ===\n`
            );

            runAgent(
                "agents/dev.md",
                "development",
                "Dev Agent",
                `Correção obrigatória pós-QA (ciclo ${qaRound + 2}): o QA reprovou com veredito "fail".
        Leia integralmente:
        - ${projectRootPrompt}/reports/tasks/${task.id}-qa.md
        - ${qaVerdictRel}
        Corrija todos os problemas reportados; não minimize bugs.
        Se a falha for de compilação, corrija o build primeiro (npm run build --prefix ${npmTestPrefix(project)}) e atualize **## Compilação** no dev.md.
        Antes de encerrar: o projeto deve **compilar** (exit code 0). Não deixe erros de compilação para o QA.
        Atualize código e testes; rode npm test se possível (npm test --prefix ${npmTestPrefix(project)}).
        Acrescente ao relatório ${projectRootPrompt}/reports/tasks/${task.id}-dev.md uma secção clara desta correção.
        Atualize ${projectRootPrompt}/docs/tasks/${task.id}.md.`
            );
        }

        runAgent(
            "agents/reviewer.md",
            "review",
            "Reviewer Agent",
            `Revise a entrega.
        Leia ${projectRootPrompt}/docs/tasks/${task.id}.md.
        Confirme que existe ${qaVerdictRel} com "verdict":"pass" (o orquestrador só chama o Reviewer após QA passar).
        Leia ${projectRootPrompt}/evidence/tests/${task.id}-test-output.txt (se ainda existir após o QA).
        Grave o parecer em ${projectRootPrompt}/reports/tasks/${task.id}-reviewer.md.
        Aprove apenas se critérios e evidências estiverem suficientes.`
        );

        cleanupTestEvidence(task.id);

        updateTaskState("done", "Human Approval Pending");
    } catch (error) {
        if (roundStatus !== "failed") {
            updateTaskState("blocked", "Error");
        }
        console.error(error.message);
        roundStatus = "failed";
        throw error;
    } finally {
        if (!billingSettled) {
            await endBillingRound({ status: roundStatus });
            billingSettled = true;
        }
    }
}

runTaskPipeline().catch((err) => {
    console.error(err);
    process.exit(1);
});
