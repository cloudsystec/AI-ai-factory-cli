/**
 * Backward compat: jobs antigos `micro-integration-qa` na fila.
 * QA real ocorre na task de fechamento — este handler só dispara release.
 */
import { run as runMicroRelease } from "./run-micro-release.js";

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
export async function run(job, onLine = console.log) {
  onLine("[micro-integration-qa] legado — QA já ocorreu na task de fechamento; a encaminhar para release\n");
  return runMicroRelease(job, onLine);
}
