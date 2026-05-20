import fs from "node:fs";
import { macroScopeFile } from "../orchestrator/project-paths.js";
import { ensureProjectFiles } from "../orchestrator/create-project.js";
import { getProjectFromBack } from "./back-client.js";

/**
 * Garante scopes/macro/<slug>.md antes de scope/develop/task.
 * @param {string} slug
 * @param {(line: string) => void} onLine
 */
export async function ensureTenantProjectReady(slug, onLine) {
  const macroPath = macroScopeFile(slug, slug);
  if (fs.existsSync(macroPath)) return;

  onLine(
    `[info] Escopo macro ausente (${macroPath}); a criar a partir do registo no backend…\n`
  );

  const meta = await getProjectFromBack(slug);
  const scope = String(meta.scopeMd ?? "").trim();
  const name = String(meta.name ?? slug).trim();
  if (!scope) {
    throw new Error(
      `Projeto "${slug}" sem texto de escopo na API. Recrie o projeto ou execute o job provision.`
    );
  }

  const result = ensureProjectFiles({ name, slug, scope });
  if (result.created.macro) {
    onLine(`[info] Criado: ${result.macroPath}\n`);
  }
}
