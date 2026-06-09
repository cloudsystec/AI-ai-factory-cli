import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeDeployStack, enrichReadinessFromStackProfile } from "./deploy-stack-analyzer.js";

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aif-stack-"));
}

describe("analyzeDeployStack", () => {
  it("detecta frontend + backend em pastas separadas", () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, "client"), { recursive: true });
    fs.mkdirSync(path.join(root, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "client", "package.json"),
      JSON.stringify({ dependencies: { react: "18", vite: "5" }, scripts: { build: "vite build" } })
    );
    fs.writeFileSync(
      path.join(root, "server", "package.json"),
      JSON.stringify({ dependencies: { express: "4", pg: "8" }, scripts: { start: "node index.js" } })
    );

    const profile = analyzeDeployStack(root);
    assert.equal(profile.appType, "fullstack");
    assert.equal(profile.suggestedTopology, "multi_service");
    assert.equal(profile.infra.postgres.required, true);
    assert.equal(profile.suggestedServices.length, 2);
    assert.equal(profile.publicService, "frontend");
  });

  it("detecta backend isolado", () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { fastify: "4" }, scripts: { start: "node server.js" } })
    );

    const profile = analyzeDeployStack(root);
    assert.equal(profile.appType, "backend");
    assert.equal(profile.suggestedTopology, "single_container");
  });

  it("detecta frontend isolado", () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { react: "18", "react-dom": "18" }, scripts: { build: "react-scripts build" } })
    );

    const profile = analyzeDeployStack(root);
    assert.equal(profile.appType, "frontend");
  });

  it("enriquece readiness sem appType", () => {
    const profile = {
      appType: "fullstack",
      suggestedTopology: "multi_service",
      publicService: "frontend",
      stack: { frontend: { path: "client" }, backend: { path: "server" } },
      infra: { postgres: { required: true }, redis: { required: false } },
      suggestedServices: [{ name: "backend" }, { name: "frontend" }],
    };
    const readiness = enrichReadinessFromStackProfile(
      {
        verdict: "deployable",
        services: [{ name: "app", dockerfilePath: "Dockerfile" }],
        generatedFiles: ["Dockerfile"],
      },
      profile
    );
    assert.equal(readiness.appType, "fullstack");
    assert.equal(readiness.topology, "multi_service");
    assert.equal(readiness.publicService, "frontend");
  });
});
