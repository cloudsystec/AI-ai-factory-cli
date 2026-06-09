import { fetchRailwayBuildDiagnostics } from "../src/back-client.js";

/**
 * @param {string} project
 * @param {(line: string) => void} [onLine]
 */
export async function loadRailwayBuildDiagnostics(project, onLine = () => {}) {
  try {
    const diag = await fetchRailwayBuildDiagnostics(project);
    if (!diag?.ok) {
      onLine(`[railway-logs] indisponível (${diag?.reason || "unknown"})\n`);
      return null;
    }
    onLine(
      `[railway-logs] deployment ${diag.deploymentId} status=${diag.deploymentStatus}\n`
    );
    return diag;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onLine(`[railway-logs] erro ao buscar: ${msg}\n`);
    return null;
  }
}

/**
 * Junta logs de build Railway ao erro para o fix-agent (ex.: COPY failed no Docker).
 * @param {string} project
 * @param {string} error
 * @param {(line: string) => void} [onLine]
 */
export async function enrichErrorWithRailwayBuildLogs(project, error, onLine = () => {}) {
  const diag = await loadRailwayBuildDiagnostics(project, onLine);
  if (!diag?.buildLogSnippet) {
    return error;
  }

  const header =
    diag.buildFailed
      ? `Build Railway falhou (${diag.deploymentStatus})`
      : `Logs do build Railway (${diag.deploymentStatus || "?"})`;

  onLine(`[railway-logs] ${header} — ${diag.buildLogSnippet.split("\n").length} linhas\n`);

  return `${error}\n\n--- ${header} (deployment ${diag.deploymentId}) ---\n${diag.buildLogSnippet}`;
}

/**
 * Se o build Railway falhou, lança com os logs — evita confundir com erro de runtime HTTP.
 * @param {string} project
 * @param {(line: string) => void} [onLine]
 */
export async function assertRailwayBuildNotFailed(project, onLine = () => {}) {
  const diag = await loadRailwayBuildDiagnostics(project, onLine);
  if (!diag) return null;

  if (diag.buildFailed && diag.buildLogSnippet) {
    throw new Error(
      `Build Railway falhou (${diag.deploymentStatus}):\n${diag.buildLogSnippet}`
    );
  }

  if (diag.deploymentStatus === "BUILDING" || diag.deploymentStatus === "DEPLOYING") {
    onLine(
      `[railway-logs] build ainda em curso (${diag.deploymentStatus}) — verify HTTP pode falhar até terminar\n`
    );
  }

  return diag;
}
