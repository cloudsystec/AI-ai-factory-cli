import fs from "node:fs";
import path from "node:path";
import { gitExec } from "./git-exec.js";
import { taskCodeDir, taskBranchName } from "./task-workspace.js";
import { workspaceRoot } from "../project-paths.js";
import { runCursorAgent } from "../cursor-agent-runner.js";

function refreshRemoteToken(project, repoFullName, token) {
  const cacheDir = path.join(workspaceRoot(project), ".git-cache");
  if (!token || !repoFullName || !fs.existsSync(cacheDir)) return;
  const url = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  gitExec(["remote", "set-url", "origin", url], { cwd: cacheDir });
}

function hasConflictMarkers(cwd) {
  const out = gitExec(["diff", "--name-only", "--diff-filter=U"], { cwd });
  return out.trim().length > 0;
}

function getConflictFiles(cwd) {
  return gitExec(["diff", "--name-only", "--diff-filter=U"], { cwd })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * @param {object} opts
 * @param {(line: string) => void} [onLine]
 */
export async function publishTaskPullRequest(opts, onLine = () => {}) {
  const {
    project,
    taskId,
    title,
    body,
    techLeadBranch = "tech-lead",
    createPrFn,
    token,
    repoFullName,
  } = opts;

  const codeDir = taskCodeDir(project, taskId);
  if (!fs.existsSync(codeDir)) {
    throw new Error(`Task workspace ausente: ${codeDir}`);
  }

  if (token && repoFullName) {
    refreshRemoteToken(project, repoFullName, token);
  }

  const branch = taskBranchName(taskId);

  // 1) Commit local changes
  gitExec(["add", "-A"], { cwd: codeDir });
  const status = gitExec(["status", "--porcelain"], { cwd: codeDir });
  if (status) {
    gitExec(
      ["commit", "-m", `[${project}/${taskId}] implementação concluída`],
      { cwd: codeDir }
    );
  }
  onLine(`[git] commit local OK\n`);

  // 2) Fetch latest origin (tech-lead may have new merges from parallel PRs)
  onLine(`[git] fetch origin (atualizar ${techLeadBranch})…\n`);
  gitExec(["fetch", "origin"], { cwd: codeDir });

  // 3) Merge origin/tech-lead into the task branch
  onLine(`[git] merge origin/${techLeadBranch} na task branch…\n`);
  let mergeClean = true;
  try {
    gitExec(["merge", `origin/${techLeadBranch}`, "--no-edit"], {
      cwd: codeDir,
    });
    onLine(`[git] merge OK — sem conflitos\n`);
  } catch {
    mergeClean = false;
  }

  // 4) If conflicts, resolve with AI
  if (!mergeClean) {
    const conflicts = getConflictFiles(codeDir);
    onLine(`[git] CONFLITO em ${conflicts.length} arquivo(s): ${conflicts.join(", ")}\n`);

    const conflictDetails = conflicts
      .map((f) => {
        try {
          const content = fs.readFileSync(path.join(codeDir, f), "utf-8");
          return `--- ${f} ---\n${content}`;
        } catch {
          return `--- ${f} --- (não foi possível ler)`;
        }
      })
      .join("\n\n");

    const prompt = `Você DEVE resolver conflitos de merge nos seguintes arquivos.

Os marcadores de conflito estão no formato:
<<<<<<< HEAD (mudanças da task branch)
=======
>>>>>>> origin/${techLeadBranch} (mudanças da tech-lead)

Resolva mantendo a lógica de AMBOS os lados quando possível.
Se a task adicionou funcionalidade nova, mantenha-a.
Se a tech-lead tem correções ou features de outra task, preserve-as também.
Remova TODOS os marcadores de conflito (<<<<<<, =======, >>>>>>>).

Após resolver, salve cada arquivo no caminho correto.

Arquivos com conflito:
${conflictDetails}
`;

    onLine(`[git] resolvendo conflitos com IA…\n`);
    try {
      runCursorAgent({
        agentFile: "agents/dev.md",
        agentName: "Conflict Resolver",
        prompt,
        skipAgents: process.env.SKIP_AGENTS === "true",
        meta: { project, task: taskId, step: "conflict_resolution" },
      });

      gitExec(["add", "-A"], { cwd: codeDir });

      if (hasConflictMarkers(codeDir)) {
        onLine(`[git] conflitos persistem após IA — abort merge, reset para HEAD\n`);
        gitExec(["merge", "--abort"], { cwd: codeDir });
        onLine(`[git] prosseguindo com push sem merge da tech-lead (PR pode ter conflito no GitHub)\n`);
      } else {
        gitExec(["commit", "--no-edit"], { cwd: codeDir });
        onLine(`[git] conflitos resolvidos com sucesso\n`);
      }
    } catch (e) {
      onLine(`[git] resolução de conflito falhou: ${e.message}\n`);
      try {
        gitExec(["merge", "--abort"], { cwd: codeDir });
      } catch { /* ignore */ }
      onLine(`[git] prosseguindo com push sem merge (PR pode ter conflito no GitHub)\n`);
    }
  }

  // 5) Push
  try {
    gitExec(["push", "-u", "origin", branch], { cwd: codeDir });
  } catch {
    gitExec(["fetch", "origin"], { cwd: codeDir });
    try {
      gitExec(["push", "-u", "--force-with-lease", "origin", branch], {
        cwd: codeDir,
      });
    } catch {
      gitExec(["push", "-u", "--force", "origin", branch], { cwd: codeDir });
    }
  }
  onLine(`[git] push ${branch}\n`);

  // 6) Create PR
  if (!createPrFn) {
    throw new Error("createPrFn obrigatório (API GitHub)");
  }

  const pr = await createPrFn({
    title: title || `[${project}/${taskId}]`,
    body: body || "",
    head: branch,
    base: techLeadBranch,
  });

  onLine(`[git] PR #${pr.number} ${pr.url}\n`);
  return pr;
}
