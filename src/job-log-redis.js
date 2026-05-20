import { createClient } from "redis";

const LOG_KEY_PREFIX = "aifactory:job:";
const LOG_SUFFIX = ":log";
const LIVE_SUFFIX = ":live";

/** @type {import("redis").RedisClientType | null} */
let commandClient = null;

export function logListKey(jobId) {
  return `${LOG_KEY_PREFIX}${jobId}${LOG_SUFFIX}`;
}

export function logLiveChannel(jobId) {
  return `${LOG_KEY_PREFIX}${jobId}${LIVE_SUFFIX}`;
}

export function getRedisUrl() {
  const v = process.env.REDIS_URL;
  if (!v) {
    throw new Error("REDIS_URL obrigatório (ex.: redis://redis-stack:6379)");
  }
  return v;
}

export function getJobLogTtlSeconds() {
  const n = Number(process.env.JOB_LOG_TTL_SECONDS ?? 604800);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 604800;
}

/**
 * @returns {Promise<import("redis").RedisClientType>}
 */
async function getCommandRedis() {
  if (!commandClient) {
    commandClient = createClient({ url: getRedisUrl() });
    commandClient.on("error", (err) => {
      console.error("[job-log-redis]", err.message);
    });
    await commandClient.connect();
  }
  return commandClient;
}

/**
 * @param {string} jobId
 */
export async function resetJobLog(jobId) {
  const redis = await getCommandRedis();
  await redis.del(logListKey(jobId));
  await publishJobLogEvent(jobId, { type: "reset" });
}

/**
 * @param {string} jobId
 * @param {object} event
 */
export async function publishJobLogEvent(jobId, event) {
  const redis = await getCommandRedis();
  await redis.publish(logLiveChannel(jobId), JSON.stringify(event));
}

/**
 * @param {string} jobId
 * @param {string} line
 */
export async function appendJobLogLine(jobId, line) {
  const redis = await getCommandRedis();
  const key = logListKey(jobId);
  const seq = await redis.lLen(key);
  await redis.rPush(key, line);
  await publishJobLogEvent(jobId, {
    type: "line",
    text: line,
    stream: "stdout",
    seq: Number(seq),
  });
}
