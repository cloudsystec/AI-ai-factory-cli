/**
 * Utilitários para task de fechamento (isMicroCloser) e QA no micro.
 */

const CLOSER_ACTIVE_STATUSES = new Set([
  "running",
  "development",
  "testing",
  "planning",
  "review",
  "queued",
  "in_progress",
]);

/**
 * @param {object|undefined|null} task
 * @returns {boolean}
 */
export function isMicroCloserTask(task) {
  return task?.isMicroCloser === true;
}

/**
 * @param {object[]} microTasks
 * @returns {object|undefined}
 */
export function getMicroCloserTask(microTasks) {
  return microTasks.find((t) => isMicroCloserTask(t));
}

/**
 * @param {object[]} microTasks
 * @returns {object[]}
 */
export function getNonCloserTasks(microTasks) {
  return microTasks.filter((t) => !isMicroCloserTask(t));
}

/**
 * @param {object} task
 * @param {Map<string, object>} stateByTaskId
 * @param {(task: object, stateByTaskId: Map<string, object>) => boolean} isDone
 * @returns {boolean}
 */
export function isTaskDoneForMicro(task, stateByTaskId, isDone) {
  return isDone(task, stateByTaskId);
}

/**
 * @param {object[]} microTasks
 * @param {Map<string, object>} stateByTaskId
 * @param {(task: object, stateByTaskId: Map<string, object>) => boolean} isDone
 * @returns {boolean}
 */
export function allNonCloserTasksDone(microTasks, stateByTaskId, isDone) {
  const nonCloser = getNonCloserTasks(microTasks);
  if (nonCloser.length === 0) return true;
  return nonCloser.every((t) => isDone(t, stateByTaskId));
}

/**
 * @param {object} task
 * @param {object|undefined|null} micro
 * @returns {boolean}
 */
export function shouldRunTaskQa(task, micro) {
  return isMicroCloserTask(task) && Boolean(micro);
}

/**
 * Filtra elegíveis respeitando regra da closer (serial, só após irmãs done).
 * @param {object[]} eligible
 * @param {object[]} microTasks
 * @param {Map<string, object>} stateByTaskId
 * @param {(task: object, stateByTaskId: Map<string, object>) => boolean} isDone
 * @param {() => boolean | Promise<boolean>} nonCloserPrsMerged
 * @returns {Promise<object[]>}
 */
export async function filterEligibleForMicroCloser(
  eligible,
  microTasks,
  stateByTaskId,
  isDone,
  nonCloserPrsMerged
) {
  const closer = getMicroCloserTask(microTasks);
  if (!closer) return eligible;

  const closerInEligible = eligible.some((t) => t.id === closer.id);
  const closerRunning = microTasks.some((t) => {
    if (!isMicroCloserTask(t)) return false;
    const rt = stateByTaskId.get(t.id);
    return rt?.status && CLOSER_ACTIVE_STATUSES.has(rt.status);
  });

  if (closerRunning) {
    return eligible.filter((t) => t.id === closer.id);
  }

  const nonCloserDone = allNonCloserTasksDone(microTasks, stateByTaskId, isDone);
  const prsMerged = nonCloserDone ? await nonCloserPrsMerged() : false;

  if (closerInEligible && nonCloserDone && prsMerged) {
    return eligible.filter((t) => t.id === closer.id);
  }

  return eligible.filter((t) => t.id !== closer.id);
}

/**
 * @param {object[]} microTasks
 * @param {Map<string, object>} stateByTaskId
 * @param {(task: object, stateByTaskId: Map<string, object>) => boolean} isDone
 * @param {() => boolean | Promise<boolean>} nonCloserPrsMerged
 * @returns {Promise<boolean>}
 */
export async function isCloserEligible(microTasks, stateByTaskId, isDone, nonCloserPrsMerged) {
  const closer = getMicroCloserTask(microTasks);
  if (!closer) return false;
  if (isDone(closer, stateByTaskId)) return false;
  if (!allNonCloserTasksDone(microTasks, stateByTaskId, isDone)) return false;
  return nonCloserPrsMerged();
}
