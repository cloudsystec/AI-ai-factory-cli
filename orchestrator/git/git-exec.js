import { spawnSync } from "node:child_process";

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [opts]
 */
export function gitExec(args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    const err = new Error(
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout || r.status}`
    );
    err.exitCode = r.status;
    throw err;
  }
  return (r.stdout || "").trim();
}
