import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidProjectSlug } from "./project-paths.js";
import { DEVELOP_PROMPT_MARKER } from "./pipeline-constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {string} */
export const REPO_ROOT = path.resolve(__dirname, "..");

export { DEVELOP_PROMPT_MARKER };

const MAX_MEMORY_LINES = 5000;
const JOBS_LOG_DIR = path.join(REPO_ROOT, "logs", "dashboard-jobs");

/** @typedef {'scope'|'scope-tasks-only'|'develop'|'task'} JobKind */

/** @typedef {'running'|'waiting_input'|'succeeded'|'failed'|'cancelled'} JobStatus */

/**
 * @typedef {object} JobRecord
 * @property {string} id
 * @property {JobKind} kind
 * @property {string} project
 * @property {string} [macroId]
 * @property {string} [taskId]
 * @property {JobStatus} status
 * @property {string} command
 * @property {string[]} argv
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {number|null} exitCode
 * @property {import('node:child_process').ChildProcess|null} child
 * @property {string[]} memoryLines
 * @property {string} logPath
 * @property {EventEmitter} bus
 */

/** @type {Map<string, JobRecord>} */
const jobs = new Map();

/** @type {string|null} */
let activeJobId = null;

/**
 * @param {string} line
 */
export function lineTriggersWaitingInput(line) {
  return (
    line.includes(DEVELOP_PROMPT_MARKER) ||
    /Iniciar próxima tarefa\?\s*\(S\/N\)/i.test(line)
  );
}

/**
 * @param {JobKind} kind
 * @param {string} project
 * @param {string} macroId
 * @param {string} [taskId]
 */
export function buildJobCommand(kind, project, macroId, taskId) {
  switch (kind) {
    case "scope":
      return {
        command: `npm run scope -- ${project} ${macroId}`,
        argv: ["run", "scope", "--", project, macroId],
        executable: "npm",
      };
    case "scope-tasks-only":
      return {
        command: `npm run scope -- ${project} ${macroId} --tasks-only`,
        argv: ["run", "scope", "--", project, macroId, "--tasks-only"],
        executable: "npm",
      };
    case "develop":
      return {
        command: `node orchestrator/develop-next.js ${project} ${macroId}`,
        argv: ["orchestrator/develop-next.js", project, macroId],
        executable: "node",
      };
    case "task":
      if (!taskId) throw new Error("taskId é obrigatório para kind=task");
      return {
        command: `node orchestrator/run-task.js ${project} ${taskId}`,
        argv: ["orchestrator/run-task.js", project, taskId],
        executable: "node",
      };
    case "design-preview":
      return {
        command: `node orchestrator/run-design-preview.js ${project}`,
        argv: ["orchestrator/run-design-preview.js", project],
        executable: "node",
      };
    case "design-infra":
      return {
        command: `node orchestrator/run-design-infra.js ${project}`,
        argv: ["orchestrator/run-design-infra.js", project],
        executable: "node",
      };
    case "planning-chat-layout":
      return {
        command: `node orchestrator/run-planning-chat.js ${project} layout`,
        argv: ["orchestrator/run-planning-chat.js", project, "layout"],
        executable: "node",
      };
    case "planning-chat-infra":
      return {
        command: `node orchestrator/run-planning-chat.js ${project} infra`,
        argv: ["orchestrator/run-planning-chat.js", project, "infra"],
        executable: "node",
      };
    default:
      throw new Error(`kind de job inválido: ${kind}`);
  }
}

/**
 * @returns {JobRecord|null}
 */
export function getActiveJob() {
  if (!activeJobId) return null;
  const job = jobs.get(activeJobId);
  if (!job) {
    activeJobId = null;
    return null;
  }
  if (
    job.status === "running" ||
    job.status === "waiting_input"
  ) {
    return job;
  }
  activeJobId = null;
  return null;
}

/**
 * @param {string} jobId
 * @returns {JobRecord|undefined}
 */
export function getJob(jobId) {
  return jobs.get(jobId);
}

/**
 * @param {JobRecord} job
 */
function jobToPublic(job) {
  return {
    id: job.id,
    kind: job.kind,
    project: job.project,
    macroId: job.macroId,
    taskId: job.taskId,
    status: job.status,
    command: job.command,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    exitCode: job.exitCode ?? null,
  };
}

export function getActiveJobPublic() {
  const job = getActiveJob();
  return job ? jobToPublic(job) : null;
}

/**
 * @param {string} jobId
 */
export function getJobPublic(jobId) {
  const job = jobs.get(jobId);
  return job ? jobToPublic(job) : null;
}

/**
 * @param {JobRecord} job
 * @param {JobStatus} status
 */
function setJobStatus(job, status) {
  job.status = status;
  job.bus.emit("event", { type: "status", status });
}

/**
 * @param {JobRecord} job
 * @param {'stdout'|'stderr'} stream
 * @param {string} text
 */
function appendLine(job, stream, text) {
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!line) return;

  const entry = stream === "stderr" ? `[stderr] ${line}` : line;
  job.memoryLines.push(entry);
  if (job.memoryLines.length > MAX_MEMORY_LINES) {
    job.memoryLines.shift();
  }

  try {
    fs.appendFileSync(job.logPath, entry + "\n", "utf-8");
  } catch {
    /* ignore */
  }

  if (lineTriggersWaitingInput(line)) {
    if (job.status === "running") {
      setJobStatus(job, "waiting_input");
    }
  }

  job.bus.emit("event", { type: "line", stream, text: line });
}

/**
 * @param {JobRecord} job
 * @param {Buffer|string} chunk
 * @param {'stdout'|'stderr'} stream
 * @param {string} pendingKey
 */
function handleChunk(job, chunk, stream, pendingKey) {
  const prev = job[pendingKey] || "";
  const combined = prev + String(chunk);
  const parts = combined.split(/\r?\n/);
  job[pendingKey] = parts.pop() ?? "";
  for (const part of parts) {
    appendLine(job, stream, part);
  }
}

/**
 * @param {JobRecord} job
 */
function flushPending(job) {
  if (job._stdoutPending) {
    appendLine(job, "stdout", job._stdoutPending);
    job._stdoutPending = "";
  }
  if (job._stderrPending) {
    appendLine(job, "stderr", job._stderrPending);
    job._stderrPending = "";
  }
}

/**
 * @param {JobRecord} job
 * @param {number|null} code
 * @param {string} signal
 */
function finalizeJob(job, code, signal) {
  flushPending(job);
  job.finishedAt = new Date().toISOString();
  job.exitCode = code;

  if (job.status === "cancelled") {
    job.bus.emit("event", { type: "exit", code, signal: signal || null });
    activeJobId = null;
    return;
  }

  if (code === 0) {
    setJobStatus(job, "succeeded");
  } else {
    setJobStatus(job, "failed");
  }

  job.bus.emit("event", { type: "exit", code, signal: signal || null });
  activeJobId = null;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (!child.pid) {
    child.kill("SIGTERM");
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/**
 * @param {{ kind: JobKind, project: string, macroId?: string, taskId?: string }} opts
 * @returns {{ jobId: string, command: string }}
 */
export function startJob(opts) {
  const { kind, project, macroId, taskId } = opts;

  if (!project || !isValidProjectSlug(project)) {
    throw new Error("project inválido");
  }

  const active = getActiveJob();
  if (active) {
    throw new Error(
      `Já existe um job em execução (${active.id}). Cancele-o antes de iniciar outro.`
    );
  }

  if (kind === "task" && (!taskId || typeof taskId !== "string")) {
    throw new Error("taskId é obrigatório para executar uma task");
  }

  if (
    (kind === "scope" || kind === "scope-tasks-only" || kind === "develop") &&
    (!macroId || typeof macroId !== "string")
  ) {
    throw new Error("macroId é obrigatório para scope e develop");
  }

  const built = buildJobCommand(kind, project, macroId ?? "", taskId);
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  fs.mkdirSync(JOBS_LOG_DIR, { recursive: true });
  const logPath = path.join(JOBS_LOG_DIR, `${jobId}.log`);
  fs.writeFileSync(
    logPath,
    `# ${built.command}\n# started ${new Date().toISOString()}\n`,
    "utf-8"
  );

  const useStdinPipe = kind === "develop";

  const child = spawn(built.executable, built.argv, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: useStdinPipe ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  /** @type {JobRecord} */
  const job = {
    id: jobId,
    kind,
    project,
    macroId,
    taskId,
    status: "running",
    command: built.command,
    argv: built.argv,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    exitCode: null,
    child,
    memoryLines: [],
    logPath,
    bus: new EventEmitter(),
    _stdoutPending: "",
    _stderrPending: "",
  };

  jobs.set(jobId, job);
  activeJobId = jobId;

  child.stdout?.on("data", (chunk) =>
    handleChunk(job, chunk, "stdout", "_stdoutPending")
  );
  child.stderr?.on("data", (chunk) =>
    handleChunk(job, chunk, "stderr", "_stderrPending")
  );

  child.on("close", (code, signal) => {
    job.child = null;
    finalizeJob(job, code, signal ?? "");
  });

  child.on("error", (err) => {
    appendLine(job, "stderr", `Erro ao iniciar processo: ${err.message}`);
    finalizeJob(job, 1, "");
  });

  job.bus.emit("event", { type: "status", status: "running" });

  return { jobId, command: built.command };
}

/**
 * @param {string} jobId
 * @param {'S'|'N'} answer
 */
export function sendInput(jobId, answer) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job não encontrado");
  if (job.status !== "waiting_input") {
    throw new Error("Job não está à espera de input");
  }
  if (!job.child?.stdin) {
    throw new Error("stdin do processo não disponível");
  }

  const line = `${answer}\n`;
  job.child.stdin.write(line);
  setJobStatus(job, "running");
}

/**
 * @param {string} jobId
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job não encontrado");
  if (
    job.status !== "running" &&
    job.status !== "waiting_input"
  ) {
    throw new Error("Job já terminou");
  }

  setJobStatus(job, "cancelled");
  if (job.child) {
    killProcessTree(job.child);
  }
}

/**
 * @param {string} jobId
 * @param {(event: object) => void} listener
 */
export function subscribeJobEvents(jobId, listener) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job não encontrado");
  job.bus.on("event", listener);
  return () => job.bus.off("event", listener);
}

/**
 * @param {string} jobId
 */
export function readJobLog(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job não encontrado");
  if (fs.existsSync(job.logPath)) {
    return fs.readFileSync(job.logPath, "utf-8");
  }
  return job.memoryLines.join("\n");
}

/**
 * @param {string} jobId
 */
export function readJobMemoryLog(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job não encontrado");
  return job.memoryLines.join("\n");
}

export function cancelActiveJobOnShutdown() {
  const active = getActiveJob();
  if (active) {
    try {
      cancelJob(active.id);
    } catch {
      /* ignore */
    }
  }
}

process.on("exit", cancelActiveJobOnShutdown);
