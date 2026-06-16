import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workerSrc = fs.readFileSync(
  path.join(__dirname, "../src/worker.js"),
  "utf-8"
);
const jobSrc = fs.readFileSync(
  path.join(__dirname, "../../ai-factory-back/src/services/job-service.js"),
  "utf-8"
);

for (const kind of ["planning-chat-layout", "planning-chat-infra"]) {
  assert.match(workerSrc, new RegExp(`"${kind}"`));
  assert.match(jobSrc, new RegExp(`"${kind}"`));
}

console.log("standalone kinds aligned (worker + back)");
