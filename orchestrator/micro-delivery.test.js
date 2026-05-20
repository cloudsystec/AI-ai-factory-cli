import test from "node:test";
import assert from "node:assert";
import { syncTaskDeliveryFlags } from "./micro-delivery.js";

test("syncTaskDeliveryFlags: exige backlogPath (não backlogFile)", () => {
  assert.throws(
    () =>
      syncTaskDeliveryFlags({
        microPath: "/tmp/micro.json",
        backlogFile: "/tmp/backlog.json",
        project: "p",
        macroId: "m",
      }),
    /backlogPath/
  );
});
