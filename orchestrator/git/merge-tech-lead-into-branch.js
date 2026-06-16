import fs from "node:fs";
import path from "node:path";
import { gitExec } from "./git-exec.js";
import { workspaceRoot } from "../project-paths.js";
import { runAgent } from "../agent-runner.js";

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
 * Faz merge de origin/{techLeadBranch} na branch actual do cwd, resolve conflitos com IA, commit.
 * @param {object} opts
 * @param {(line: string) => void} [onLine]
 * @returns {Promise<{ merged: boolean, pushed: boolean }>}
 */
export async function mergeTechLeadIntoBranch(opts, onLine = () => {}) {
  const {
    project,
    taskId,
    codeDir,
    techLeadBranch = "tech-lead",
    token,
    repoFullName,
    headBranch,
  } = opts;

  if (!codeDir || !fs.existsSync(codeDir)) {
    throw new Error(`Diretório git ausente: ${codeDir}`);
  }

  if (token && repoFullName) {
    refreshRemoteToken(project, repoFullName, token);
  }

  const branch = headBranch || gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: codeDir }).trim();

  onLine(`[git] fetch origin (atualizar ${techLeadBranch})…\n`);
  gitExec(["fetch", "origin"], { cwd: codeDir });

  onLine(`[git] merge origin/${techLeadBranch} em ${branch}…\n`);
  let mergeClean = true;
  try {
    gitExec(["merge", `origin/${techLeadBranch}`, "--no-edit"], { cwd: codeDir });
    onLine(`[git] merge OK — sem conflitos\n`);
  } catch {
    mergeClean = false;
  }

  if (!mergeClean) {
    const conflicts = getConflictFiles(codeDir);
    onLine(
      `[git] CONFLITO em ${conflicts.length} arquivo(s): ${conflicts.join(", ")}\n`
    );

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
<<<<<<< HEAD (mudanças da branch da task/PR)
=======
>>>>>>> origin/${techLeadBranch} (mudanças da tech-lead)

Resolva mantendo a lógica de AMBOS os lados quando possível.
Remova TODOS os marcadores de conflito (<<<<<<, =======, >>>>>>>).

Arquivos com conflito:
${conflictDetails}
`;

    onLine(`[git] resolvendo conflitos com IA…\n`);
    try {
      await runAgent({
        agentFile: "agents/dev.md",
        agentName: "Conflict Resolver",
        prompt,
        skipAgents: process.env.SKIP_AGENTS === "true",
        meta: {
          project,
          task: taskId || "pr-resolve",
          step: "conflict_resolution",
        },
      });

      gitExec(["add", "-A"], { cwd: codeDir });

      if (hasConflictMarkers(codeDir)) {
        onLine(`[git] conflitos persistem — abort merge\n`);
        gitExec(["merge", "--abort"], { cwd: codeDir });
        return { merged: false, pushed: false };
      }

      gitExec(["commit", "--no-edit"], { cwd: codeDir });
      onLine(`[git] conflitos resolvidos com sucesso\n`);
    } catch (e) {
      onLine(`[git] resolução de conflito falhou: ${e.message}\n`);
      try {
        gitExec(["merge", "--abort"], { cwd: codeDir });
      } catch {
        /* ignore */
      }
      return { merged: false, pushed: false };
    }
  }

  onLine(`[git] push ${branch}…\n`);
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
  onLine(`[git] push concluído\n`);
  return { merged: true, pushed: true };
}
