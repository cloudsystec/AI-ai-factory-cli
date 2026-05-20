import fs from "node:fs";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import {
  backlogFile,
  isValidProjectSlug,
  microScopeFile,
} from "./project-paths.js";
import { readBacklogFile, writeBacklogFile } from "./backlog-io.js";
import {
  readMicrosFromPath,
  syncTaskDeliveryFlags,
  getOpenMicro,
} from "./micro-delivery.js";
import { readDevelopSettings } from "./develop-settings.js";
import { DEVELOP_PROMPT_MARKER } from "./pipeline-constants.js";

const project = process.argv[2];
const macroIdArg = process.argv[3];

if (!project || !isValidProjectSlug(project)) {
  console.error("Uso: npm run develop <projeto> [macro-id]");
  console.error("Ex.: npm run develop barber-scheduler barber-scheduler");
  process.exit(1);
}

const backlogPath = backlogFile(project);

if (!fs.existsSync(backlogPath)) {
  console.error(`Backlog não encontrado: ${backlogPath}`);
  process.exit(1);
}

function resolveMacroId() {
  if (macroIdArg && String(macroIdArg).trim().length > 0) {
    return String(macroIdArg).trim();
  }
  const doc = readBacklogFile(backlogPath, { project });
  if (doc.macroId) return doc.macroId;
  console.error(
    "macro-id não encontrado no backlog. Informe: npm run develop <projeto> <macro-id>"
  );
  process.exit(1);
}

const macroId = resolveMacroId();
const microPath = microScopeFile(project, macroId);

function getNextTask() {
  const doc = readBacklogFile(backlogPath, { project, macroId });
  if (!fs.existsSync(microPath)) {
    console.error(`Arquivo de microescopos não encontrado: ${microPath}`);
    process.exit(1);
  }

  syncTaskDeliveryFlags({
    microPath,
    backlogPath,
    project,
    macroId,
  });

  const micros = readMicrosFromPath(microPath);
  const openMicro = getOpenMicro(micros);

  if (!openMicro) {
    console.log(
      "\nNenhum microescopo em estado 'open'. Todas as ondas podem estar concluídas ou ajuste taskDeliveryStatus no arquivo de micros.\n"
    );
    return null;
  }

  const eligible = doc.tasks.filter(
    (t) =>
      t.sourceMicroId === openMicro.id &&
      t.status === "todo" &&
      t.approved === true
  );

  if (eligible.length === 0) {
    const forMicro = doc.tasks.filter((t) => t.sourceMicroId === openMicro.id);
    if (forMicro.length === 0) {
      console.log(
        `\nMicro '${openMicro.id}' está aberto para onda, mas ainda não há tasks no backlog.`
      );
      console.log(
        `Gere o lote com: npm run scope -- ${project} ${macroId} --tasks-only\n`
      );
    } else {
      console.log(
        `\nMicro '${openMicro.id}': nenhuma task 'todo' aprovada. Revise validação Tech Lead ou rode o pipeline de escopo.`
      );
      console.log(
        `Para novo lote após fechar a onda: npm run scope -- ${project} ${macroId} --tasks-only\n`
      );
    }
    return null;
  }

  return eligible.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
}

function updateTaskStatus(taskId, status) {
  const doc = readBacklogFile(backlogPath, { project, macroId });
  const index = doc.tasks.findIndex((task) => task.id === taskId);

  if (index >= 0) {
    doc.tasks[index].status = status;
    doc.tasks[index].updatedAt = new Date().toISOString();
    writeBacklogFile(backlogPath, {
      ...doc,
      updatedAt: new Date().toISOString(),
    });
  }
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  while (true) {
    const task = getNextTask();

    if (!task) {
      break;
    }

    console.log(`\nPróxima task: ${task.id} - ${task.title}\n`);
    console.log(`(micro: ${task.sourceMicroId})\n`);

    updateTaskStatus(task.id, "in_progress");

    execFileSync("node", ["orchestrator/run-task.js", project, task.id], {
      stdio: "inherit",
      cwd: process.cwd(),
      shell: true,
    });

    updateTaskStatus(task.id, "done");

    syncTaskDeliveryFlags({
      microPath,
      backlogPath,
      project,
      macroId,
    });

    if (readDevelopSettings(project).autorun) {
      console.log("\n[autorun] A iniciar a próxima task automaticamente.\n");
      continue;
    }

    if (!process.stdin.isTTY) {
      console.log(DEVELOP_PROMPT_MARKER);
    }

    const answer = await ask(
      "\nIniciar próxima tarefa? (S/N). Se a onda do micro terminou, use depois: npm run scope -- " +
        project +
        " " +
        macroId +
        " --tasks-only\n> "
    );

    if (answer.toUpperCase() !== "S") {
      console.log("Processo pausado.");
      break;
    }
  }
}

main();
