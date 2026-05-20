import fs from "node:fs";
import {
  agentFilePath,
  globalAgentsFile,
} from "./project-paths.js";

function readUtf8(file) {
  return fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
}

/** Regras globais (AGENTS.md do tenant ou repo). */
export function readGlobalRules() {
  const file = globalAgentsFile();
  if (!fs.existsSync(file)) {
    throw new Error(`AGENTS.md não encontrado: ${file}`);
  }
  return readUtf8(file);
}

/**
 * @param {string} relativePath ex. agents/planner.md
 */
export function readAgentFile(relativePath) {
  const file = agentFilePath(relativePath);
  if (!fs.existsSync(file)) {
    throw new Error(`Agente não encontrado: ${file}`);
  }
  return readUtf8(file);
}
