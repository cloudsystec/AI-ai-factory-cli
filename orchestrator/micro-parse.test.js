import test from "node:test";
import assert from "node:assert/strict";
import { parseMicrosJson, readMicrosFromPath } from "./micro-delivery.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("parseMicrosJson: array na raiz", () => {
  const data = [{ id: "a", approved: false }];
  assert.equal(parseMicrosJson(data).length, 1);
});

test("parseMicrosJson: envelope microscopes", () => {
  const data = {
    macroId: "p",
    microscopes: [
      { id: "m1", validationStatus: "pending_validation" },
      { id: "m2", validationStatus: "pending_validation" },
    ],
  };
  assert.equal(parseMicrosJson(data).length, 2);
});

test("parseMicrosJson: envelope microScopes", () => {
  const data = { microScopes: [{ id: "x" }] };
  assert.equal(parseMicrosJson(data).length, 1);
});

test("readMicrosFromPath: lê ficheiro com microscopes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-micro-"));
  const file = path.join(dir, "p.micro.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ microscopes: [{ id: "t1", approved: false }] }),
    "utf-8"
  );
  assert.equal(readMicrosFromPath(file).length, 1);
  fs.rmSync(dir, { recursive: true });
});
