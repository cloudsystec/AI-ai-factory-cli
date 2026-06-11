/**
 * Veredito QA por task (legado) e por micro (task de fechamento).
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} workspaceRootAbs
 * @param {string} taskId
 */
export function qaVerdictFile(workspaceRootAbs, taskId) {
  return path.join(workspaceRootAbs, "reports", "tasks", `${taskId}-qa-verdict.json`);
}

/**
 * @param {string} workspaceRootAbs
 * @param {string} microId
 */
export function microQaVerdictFile(workspaceRootAbs, microId) {
  return path.join(workspaceRootAbs, "reports", "scopes", `${microId}-qa-verdict.json`);
}

/**
 * @param {string} workspaceRootAbs
 * @param {string} taskId
 */
export function clearQaVerdict(workspaceRootAbs, taskId) {
  const p = qaVerdictFile(workspaceRootAbs, taskId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

/**
 * @param {string} workspaceRootAbs
 * @param {string} microId
 */
export function clearMicroQaVerdict(workspaceRootAbs, microId) {
  const p = microQaVerdictFile(workspaceRootAbs, microId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

function readUtf8(p) {
  return fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "");
}

function parseVerdictFile(p, missingLabel) {
  if (!fs.existsSync(p)) {
    return {
      verdict: "fail",
      summary: missingLabel,
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
      summary: "JSON inválido no veredito QA.",
      code: "INVALID_JSON",
    };
  }
}

/**
 * @param {string} workspaceRootAbs
 * @param {string} taskId
 */
export function readQaVerdict(workspaceRootAbs, taskId) {
  return parseVerdictFile(
    qaVerdictFile(workspaceRootAbs, taskId),
    "Ficheiro reports/tasks/<TASK>-qa-verdict.json ausente — o QA deve gravá-lo."
  );
}

/**
 * @param {string} workspaceRootAbs
 * @param {string} microId
 */
export function readMicroQaVerdict(workspaceRootAbs, microId) {
  return parseVerdictFile(
    microQaVerdictFile(workspaceRootAbs, microId),
    "Ficheiro reports/scopes/<MICRO>-qa-verdict.json ausente — o QA do micro deve gravá-lo."
  );
}
