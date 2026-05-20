import fs from "node:fs";
import path from "node:path";
import { developSettingsFile, isValidProjectSlug } from "./project-paths.js";

/**
 * @param {string} project
 */
function assertProject(project) {
  if (!isValidProjectSlug(project)) {
    throw new Error(`Slug de projeto inválido: ${project}`);
  }
}

/**
 * @param {unknown} value
 */
function normalizeAutorun(value) {
  return value === true;
}

/**
 * @param {string} project
 * @returns {{ autorun: boolean }}
 */
export function readDevelopSettings(project) {
  assertProject(project);
  const filePath = developSettingsFile(project);
  if (!fs.existsSync(filePath)) {
    return { autorun: false };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
    return { autorun: normalizeAutorun(raw?.autorun) };
  } catch {
    return { autorun: false };
  }
}

/**
 * @param {string} project
 * @param {{ autorun: boolean }} settings
 */
export function writeDevelopSettings(project, settings) {
  assertProject(project);
  if (typeof settings?.autorun !== "boolean") {
    throw new Error("writeDevelopSettings: autorun deve ser boolean");
  }
  const filePath = developSettingsFile(project);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ autorun: settings.autorun }, null, 2),
    "utf-8"
  );
}
