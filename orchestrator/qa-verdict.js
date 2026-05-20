import fs from "node:fs";
import path from "node:path";

/**
 * Caminho do veredito machine-readable do QA (usado pelo orquestrador).
 * @param {string} workspaceRootAbs
 * @param {string} taskId
 */
export function qaVerdictFile(workspaceRootAbs, taskId) {
  return path.join(workspaceRootAbs, "reports", "tasks", `${taskId}-qa-verdict.json`);
}

/**
 * Remove veredito anterior para o QA gravar um novo a cada ronda.
 * @param {string} workspaceRootAbs
 * @param {string} taskId
 */
export function clearQaVerdict(workspaceRootAbs, taskId) {
  const p = qaVerdictFile(workspaceRootAbs, taskId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

function readUtf8(p) {
  return fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "");
}

/**
 * Lê o veredito do QA. Falha fechada se ficheiro inválido ou ausente.
 * @param {string} workspaceRootAbs
 * @param {string} taskId
 * @returns {{ verdict: "pass" | "fail", summary: string, code?: string }}
 */
export function readQaVerdict(workspaceRootAbs, taskId) {
  const p = qaVerdictFile(workspaceRootAbs, taskId);
  if (!fs.existsSync(p)) {
    return {
      verdict: "fail",
      summary: "Ficheiro reports/tasks/<TASK>-qa-verdict.json ausente — o QA deve gravá-lo.",
      code: "MISSING",
    };
  }
  try {
    const raw = JSON.parse(readUtf8(p));
    const v = String(raw.verdict ?? "").toLowerCase().trim();
    if (v === "pass" || v === "fail") {
      return {
        verdict: v,
        summary: typeof raw.summary === "string" ? raw.summary : "",
      };
    }
    return {
      verdict: "fail",
      summary: 'Campo "verdict" deve ser "pass" ou "fail".',
      code: "INVALID_VERDICT",
    };
  } catch {
    return {
      verdict: "fail",
      summary: "JSON inválido em qa-verdict.json.",
      code: "INVALID_JSON",
    };
  }
}
