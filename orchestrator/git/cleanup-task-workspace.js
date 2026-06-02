import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../project-paths.js";
import { gitExec } from "./git-exec.js";
import { taskCodeDir } from "./task-workspace.js";

/**
 * @param {string} project
 * @param {string} taskId
 * @param {(line: string) => void} [onLine]
 */
export function cleanupTaskWorkspace(project, taskId, onLine = () => {}) {
  const ws = workspaceRoot(project);
  const cacheDir = path.join(ws, ".git-cache");
  const codeDir = taskCodeDir(project, taskId);
  const taskDir = path.join(ws, "tasks", taskId);

  if (fs.existsSync(cacheDir)) {
    try {
      gitExec(["worktree", "remove", "--force", codeDir], { cwd: cacheDir });
      onLine(`[git] worktree removido\n`);
    } catch (e) {
      onLine(`[git] worktree remove warn: ${e.message}\n`);
      try {
        gitExec(["worktree", "prune"], { cwd: cacheDir });
        onLine(`[git] worktree prune\n`);
      } catch {
        /* ignore */
      }
    }
  }

  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
    onLine(`[git] pasta tasks/${taskId} apagada\n`);
  }
}
