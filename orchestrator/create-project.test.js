import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { suggestSlugFromName } from "./project-slug.js";
import {
  createProject,
  ProjectAlreadyExistsError,
} from "./create-project.js";
import { macroScopeFile, workspaceRoot, backlogFile, taskStateFile } from "./project-paths.js";

test("suggestSlugFromName", () => {
  assert.strictEqual(suggestSlugFromName("Barber Scheduler"), "barber-scheduler");
  assert.strictEqual(suggestSlugFromName("  Meu_App  "), "meu-app");
  assert.strictEqual(suggestSlugFromName(""), "");
});

test("createProject: cria macro backlog e tasks-state", () => {
  const slug = `cp-test-${Date.now()}`;
  const macroPath = macroScopeFile(slug, slug);
  const ws = workspaceRoot(slug);

  try {
    const result = createProject({
      name: "Test App",
      slug,
      scope: "Visão do produto de teste.",
    });

    assert.strictEqual(result.project, slug);
    assert.strictEqual(result.macroId, slug);
    assert.ok(fs.existsSync(macroPath));
    const macro = fs.readFileSync(macroPath, "utf-8");
    assert.ok(macro.includes("# Test App"));
    assert.ok(macro.includes("Visão do produto de teste."));

    assert.ok(fs.existsSync(backlogFile(slug)));
    const backlog = JSON.parse(fs.readFileSync(backlogFile(slug), "utf-8"));
    assert.strictEqual(backlog.project, slug);
    assert.strictEqual(backlog.macroId, slug);
    assert.deepStrictEqual(backlog.tasks, []);

    assert.strictEqual(fs.readFileSync(taskStateFile(slug), "utf-8").trim(), "[]");
  } finally {
    if (fs.existsSync(macroPath)) fs.unlinkSync(macroPath);
    if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("createProject: rejeita escopo vazio", () => {
  assert.throws(
    () =>
      createProject({
        name: "X",
        slug: "x-test-empty",
        scope: "   ",
      }),
    /Escopo/
  );
});

test("createProject: conflito se projeto já existe", () => {
  const slug = `cp-dup-${Date.now()}`;
  const macroPath = macroScopeFile(slug, slug);
  const ws = workspaceRoot(slug);

  try {
    createProject({ name: "Dup", slug, scope: "Primeiro." });
    assert.throws(
      () => createProject({ name: "Dup", slug, scope: "Segundo." }),
      ProjectAlreadyExistsError
    );
  } finally {
    if (fs.existsSync(macroPath)) fs.unlinkSync(macroPath);
    if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
  }
});
