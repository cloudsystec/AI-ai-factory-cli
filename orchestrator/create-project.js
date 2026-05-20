import fs from "node:fs";
import path from "node:path";
import {
  ensureScopePipelineDirs,
  isValidProjectSlug,
  macroScopeFile,
  repoRelativePosix,
  taskStateFile,
  workspaceRoot,
} from "./project-paths.js";
import { writeBacklogFile } from "./backlog-io.js";
import { backlogFile } from "./project-paths.js";
import { writeDevelopSettings } from "./develop-settings.js";

export class ProjectAlreadyExistsError extends Error {
  constructor(slug) {
    super(`Projeto "${slug}" já existe (macro ou workspace).`);
    this.name = "ProjectAlreadyExistsError";
    this.slug = slug;
  }
}

/**
 * @param {{ name: string, slug: string, scope: string }} input
 */
export function createProject(input) {
  const name = String(input?.name ?? "").trim();
  const slug = String(input?.slug ?? "").trim();
  const scope = String(input?.scope ?? "").trim();

  if (!name) {
    throw new Error("Nome do projeto é obrigatório.");
  }
  if (!scope) {
    throw new Error("Escopo é obrigatório.");
  }
  if (!slug) {
    throw new Error("Slug é obrigatório.");
  }
  if (!isValidProjectSlug(slug)) {
    throw new Error(
      `Slug inválido: "${slug}". Use apenas letras, números, hífen e underscore.`
    );
  }

  const macroPath = macroScopeFile(slug, slug);
  const wsRoot = workspaceRoot(slug);

  if (fs.existsSync(macroPath) || fs.existsSync(wsRoot)) {
    throw new ProjectAlreadyExistsError(slug);
  }

  const macroBody = `# ${name}\n\n${scope}\n`;
  fs.mkdirSync(path.dirname(macroPath), { recursive: true });
  fs.writeFileSync(macroPath, macroBody, "utf-8");

  ensureScopePipelineDirs(slug);

  const bp = backlogFile(slug);
  writeBacklogFile(bp, {
    project: slug,
    macroId: slug,
    tasks: [],
    updatedAt: new Date().toISOString(),
  });

  const statePath = taskStateFile(slug);
  fs.writeFileSync(statePath, "[]\n", "utf-8");

  writeDevelopSettings(slug, { autorun: false });

  return {
    project: slug,
    macroId: slug,
    name,
    paths: {
      macro: repoRelativePosix(macroPath),
      workspace: repoRelativePosix(wsRoot),
    },
  };
}
