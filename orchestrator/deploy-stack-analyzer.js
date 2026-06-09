import fs from "node:fs";
import path from "node:path";

/** @typedef {"frontend" | "backend" | "fullstack" | "unknown"} AppType */

/** @typedef {{
 *   path: string,
 *   kind: "frontend" | "backend" | "fullstack",
 *   framework?: string,
 *   port?: number,
 *   hasDockerfile?: boolean,
 * }} AppCandidate */

const FRONTEND_DIR_NAMES = new Set([
  "frontend",
  "front",
  "client",
  "web",
  "ui",
  "app-web",
  "spa",
]);

const BACKEND_DIR_NAMES = new Set([
  "backend",
  "back",
  "server",
  "api",
  "app-api",
  "services",
]);

const FRONTEND_DEPS = [
  "react",
  "react-dom",
  "vue",
  "@angular/core",
  "svelte",
  "@sveltejs/kit",
  "next",
  "nuxt",
  "vite",
  "@vitejs/plugin-react",
  "create-react-app",
  "gatsby",
];

const BACKEND_DEPS = [
  "express",
  "fastify",
  "@nestjs/core",
  "koa",
  "hapi",
  "@hapi/hapi",
  "restify",
  "spring-boot",
  "django",
  "flask",
  "fastapi",
  "laravel",
];

const DB_DEPS = ["pg", "postgres", "mysql2", "mongodb", "mongoose", "prisma", "@prisma/client", "typeorm", "sequelize", "knex"];
const REDIS_DEPS = ["redis", "ioredis", "bull", "bullmq", "@redis/client"];

/**
 * @param {string} dir
 */
function readJsonSafe(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string>} deps
 * @param {string[]} needles
 */
function depsMatch(deps, needles) {
  const keys = Object.keys(deps || {});
  return needles.some((n) => keys.some((k) => k === n || k.startsWith(`${n}/`)));
}

/**
 * @param {string} dir
 */
function classifyNodeApp(dir) {
  const pkg = readJsonSafe(dir, "package.json");
  if (!pkg) return null;

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const hasFront = depsMatch(deps, FRONTEND_DEPS);
  const hasBack = depsMatch(deps, BACKEND_DEPS);
  const isNext = deps.next != null || deps["next"] != null;
  const isNuxt = deps.nuxt != null;

  let kind = /** @type {"frontend" | "backend" | "fullstack"} */ ("backend");
  let framework = "node";

  if (isNext) {
    kind = "fullstack";
    framework = "next";
  } else if (isNuxt) {
    kind = "fullstack";
    framework = "nuxt";
  } else if (hasFront && hasBack) {
    kind = "fullstack";
    framework = deps.vite ? "vite+node" : "react+node";
  } else if (hasFront) {
    kind = "frontend";
    if (deps.react) framework = "react";
    else if (deps.vue) framework = "vue";
    else if (deps["@angular/core"]) framework = "angular";
    else if (deps.vite) framework = "vite";
  } else if (hasBack) {
    kind = "backend";
    if (deps["@nestjs/core"]) framework = "nestjs";
    else if (deps.fastify) framework = "fastify";
    else if (deps.express) framework = "express";
  } else if (scripts.start || scripts["start:prod"]) {
    kind = "backend";
    framework = "node";
  } else if (scripts.dev && (deps.vite || deps["react-scripts"])) {
    kind = "frontend";
    framework = deps.vite ? "vite" : "react-cra";
  }

  const port =
    Number(process.env.PORT) ||
    (kind === "frontend" ? 8080 : 3000);

  return {
    path: ".",
    kind,
    framework,
    port,
    hasDockerfile: fs.existsSync(path.join(dir, "Dockerfile")),
  };
}

/**
 * @param {string} dir
 * @param {string} rel
 */
function classifyDotNet(dir, rel) {
  const csprojs = fs.readdirSync(dir).filter((f) => f.endsWith(".csproj"));
  if (csprojs.length === 0) return null;
  const hasBlazor = csprojs.some((f) => /blazor|wasm|client/i.test(f));
  const hasApi = csprojs.some((f) => /api|server|backend/i.test(f));
  if (hasBlazor && hasApi) {
    return { path: rel, kind: "fullstack", framework: "dotnet", port: 8080, hasDockerfile: fs.existsSync(path.join(dir, "Dockerfile")) };
  }
  if (hasBlazor || csprojs.some((f) => /web|ui|front/i.test(f))) {
    return { path: rel, kind: "frontend", framework: "dotnet-blazor", port: 8080, hasDockerfile: fs.existsSync(path.join(dir, "Dockerfile")) };
  }
  return { path: rel, kind: "backend", framework: "dotnet", port: 8080, hasDockerfile: fs.existsSync(path.join(dir, "Dockerfile")) };
}

/**
 * @param {string} previewDir
 * @param {string} rel
 * @param {number} depth
 * @returns {AppCandidate[]}
 */
function findAppCandidates(previewDir, rel = ".", depth = 0) {
  /** @type {AppCandidate[]} */
  const found = [];
  const abs = rel === "." ? previewDir : path.join(previewDir, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return found;

  const node = classifyNodeApp(abs);
  if (node) {
    found.push({ ...node, path: rel === "." ? "." : rel.replace(/\\/g, "/") });
  }

  const dotnet = classifyDotNet(abs, rel === "." ? "." : rel.replace(/\\/g, "/"));
  if (dotnet && !node) found.push(dotnet);

  if (depth >= 2) return found;

  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const childRel = rel === "." ? ent.name : `${rel}/${ent.name}`.replace(/\\/g, "/");
    found.push(...findAppCandidates(previewDir, childRel, depth + 1));
  }

  return found;
}

/**
 * Backend em subpasta sem package.json próprio (ex.: backend/src + build:backend no root).
 * @param {string} previewDir
 * @returns {AppCandidate | null}
 */
function classifyBackendSubfolder(previewDir) {
  for (const name of ["backend", "server", "api"]) {
    const dir = path.join(previewDir, name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const entry = path.join(dir, "src", "index.ts");
    const entryJs = path.join(dir, "src", "index.js");
    if (!fs.existsSync(entry) && !fs.existsSync(entryJs)) continue;
    const rootPkg = readJsonSafe(previewDir, "package.json");
    const scripts = rootPkg?.scripts || {};
    const hasBackendScript =
      scripts["build:backend"] ||
      scripts["dev:backend"] ||
      scripts["start:backend"];
    return {
      path: name,
      kind: "backend",
      framework: hasBackendScript ? "express" : "node",
      port: 3000,
      hasDockerfile: fs.existsSync(path.join(dir, "Dockerfile")),
    };
  }
  return null;
}

/**
 * @param {AppCandidate[]} candidates
 */
function pickByDirNames(candidates) {
  let frontend = candidates.find((c) => {
    const base = c.path.split("/").pop()?.toLowerCase() || "";
    return FRONTEND_DIR_NAMES.has(base) && c.kind !== "backend";
  });
  let backend = candidates.find((c) => {
    const base = c.path.split("/").pop()?.toLowerCase() || "";
    return BACKEND_DIR_NAMES.has(base) && c.kind !== "frontend";
  });

  if (!frontend) {
    frontend = candidates.find((c) => c.kind === "frontend");
  }
  if (!backend) {
    backend = candidates.find((c) => c.kind === "backend");
  }

  return { frontend, backend };
}

/**
 * @param {string} previewDir
 * @param {AppCandidate[]} candidates
 */
function detectInfra(previewDir, candidates) {
  /** @type {Record<string, { required: boolean, reason?: string }>} */
  const infra = {
    postgres: { required: false },
    redis: { required: false },
  };

  const scanDirs = candidates.length
    ? candidates.map((c) => (c.path === "." ? previewDir : path.join(previewDir, c.path)))
    : [previewDir];

  /** @type {Set<string>} */
  const reasons = { postgres: new Set(), redis: new Set() };

  for (const dir of scanDirs) {
    const pkg = readJsonSafe(dir, "package.json");
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    if (depsMatch(deps, DB_DEPS)) reasons.postgres.add("dependência npm de base de dados");
    if (depsMatch(deps, REDIS_DEPS)) reasons.redis.add("dependência npm redis/fila");

    for (const name of [".env.example", ".env.sample", ".env.template"]) {
      const envPath = path.join(dir, name);
      if (!fs.existsSync(envPath)) continue;
      const text = fs.readFileSync(envPath, "utf8").toLowerCase();
      if (/database_url|postgres|mysql|mongodb/.test(text)) {
        reasons.postgres.add(`variável em ${name}`);
      }
      if (/redis_url|rediss:\/\//.test(text)) {
        reasons.redis.add(`variável em ${name}`);
      }
    }
  }

  const composePath = path.join(previewDir, "docker-compose.yml");
  const composeYaml = fs.existsSync(composePath)
    ? fs.readFileSync(composePath, "utf8").toLowerCase()
    : "";
  if (/postgres|postgresql/.test(composeYaml)) reasons.postgres.add("docker-compose.yml");
  if (/redis:/.test(composeYaml)) reasons.redis.add("docker-compose.yml");

  if (reasons.postgres.size) {
    infra.postgres = { required: true, reason: [...reasons.postgres].join("; ") };
  }
  if (reasons.redis.size) {
    infra.redis = { required: true, reason: [...reasons.redis].join("; ") };
  }

  return infra;
}

/**
 * @param {AppCandidate[]} candidates
 * @param {{ frontend?: AppCandidate, backend?: AppCandidate }} picked
 * @param {Record<string, { required: boolean }>} infra
 */
function buildSuggestions(candidates, picked, infra) {
  const { frontend, backend } = picked;
  /** @type {AppType} */
  let appType = "unknown";

  if (frontend && backend && frontend.path !== backend.path) {
    appType = "fullstack";
  } else if (frontend && !backend) {
    appType = "frontend";
  } else if (backend && !frontend) {
    appType = "backend";
  } else {
    const root = candidates.find((c) => c.path === ".");
    if (root?.kind === "fullstack") appType = "fullstack";
    else if (root?.kind === "frontend") appType = "frontend";
    else if (root?.kind === "backend") appType = "backend";
    else if (candidates.length === 1) {
      appType = candidates[0].kind === "fullstack" ? "fullstack" : candidates[0].kind;
    }
  }

  /** @type {string} */
  let topology = "single_container";
  /** @type {object[]} */
  let services = [];

  if (appType === "fullstack" && frontend && backend && frontend.path !== backend.path) {
    topology = "multi_service";
    services = [
      {
        name: "backend",
        rootDirectory: backend.path === "." ? "." : backend.path,
        builder: "DOCKERFILE",
        dockerfilePath: backend.hasDockerfile ? "Dockerfile" : "Dockerfile.backend",
        port: backend.port || 3000,
        env: { NODE_ENV: "production" },
        dependsOn: [],
        role: "api",
      },
      {
        name: "frontend",
        rootDirectory: frontend.path === "." ? "." : frontend.path,
        builder: "DOCKERFILE",
        dockerfilePath: frontend.hasDockerfile ? "Dockerfile" : "Dockerfile.frontend",
        port: frontend.port || 8080,
        env: {
          NODE_ENV: "production",
          VITE_API_URL: "${{backend.RAILWAY_PUBLIC_DOMAIN}}",
          REACT_APP_API_URL: "https://${{backend.RAILWAY_PUBLIC_DOMAIN}}",
        },
        dependsOn: ["backend"],
        role: "web",
      },
    ];
  } else if (appType === "frontend") {
    const f = frontend || candidates.find((c) => c.kind === "frontend") || candidates[0];
    topology = "single_container";
    services = [
      {
        name: "app",
        rootDirectory: f?.path === "." ? "." : f?.path || ".",
        builder: "DOCKERFILE",
        dockerfilePath: "Dockerfile",
        port: f?.port || 8080,
        env: { NODE_ENV: "production" },
        dependsOn: [],
        role: "web",
      },
    ];
  } else {
    const b = backend || candidates.find((c) => c.kind === "backend") || candidates[0];
    topology = infra.postgres?.required ? "single_container_postgres" : "single_container";
    services = [
      {
        name: "app",
        rootDirectory: b?.path === "." ? "." : b?.path || ".",
        builder: "DOCKERFILE",
        dockerfilePath: "Dockerfile",
        port: b?.port || 8080,
        env: { NODE_ENV: "production" },
        dependsOn: infra.postgres?.required ? ["postgres"] : [],
        role: "api",
      },
    ];
  }

  const publicService =
    appType === "fullstack"
      ? "frontend"
      : appType === "frontend"
        ? "app"
        : "app";

  return { appType, topology, services, publicService };
}

/**
 * @param {unknown} services
 * @returns {string | null}
 */
export function inferAppTypeFromServices(services) {
  if (!Array.isArray(services) || services.length === 0) return null;
  const names = new Set(
    services.map((s) =>
      s && typeof s === "object"
        ? String(/** @type {Record<string, unknown>} */ (s).name || "")
        : ""
    )
  );
  if (names.has("frontend") && names.has("backend")) return "fullstack";
  if (names.has("frontend")) return "frontend";
  if (names.has("backend")) return "backend";
  if (names.has("app") && services.length === 1) return "backend";
  return null;
}

/**
 * Preenche campos em falta no readiness a partir da pré-análise (agente por vezes omite appType).
 * @param {Record<string, unknown>} readiness
 * @param {ReturnType<typeof analyzeDeployStack>} stackProfile
 */
export function enrichReadinessFromStackProfile(readiness, stackProfile) {
  /** @type {Record<string, unknown>} */
  const r = { ...readiness };

  if (!r.appType) {
    if (stackProfile.appType && stackProfile.appType !== "unknown") {
      r.appType = stackProfile.appType;
    } else {
      r.appType = inferAppTypeFromServices(r.services) || "backend";
    }
  }

  if (!r.topology && stackProfile.suggestedTopology) {
    r.topology = stackProfile.suggestedTopology;
  }
  if (!r.publicService && stackProfile.publicService) {
    r.publicService = stackProfile.publicService;
  }
  if (!r.stack && stackProfile.stack) {
    r.stack = stackProfile.stack;
  }
  if (!r.infra && stackProfile.infra) {
    r.infra = stackProfile.infra;
  }
  if (!r.postgres && stackProfile.infra?.postgres) {
    r.postgres = stackProfile.infra.postgres;
  }

  const services = Array.isArray(r.services) ? r.services : [];
  if (services.length === 0 && stackProfile.suggestedServices?.length) {
    r.services = stackProfile.suggestedServices;
  }

  return r;
}

/**
 * Analisa `.deploy-preview/` e devolve perfil de stack + sugestões de topologia Railway.
 * @param {string} previewDir
 */
export function analyzeDeployStack(previewDir) {
  if (!fs.existsSync(previewDir)) {
    return {
      appType: "unknown",
      stack: { frontend: null, backend: null, candidates: [] },
      infra: { postgres: { required: false }, redis: { required: false } },
      suggestedTopology: "single_container",
      suggestedServices: [],
      publicService: "app",
      summary: "Preview vazio",
    };
  }

  const candidates = findAppCandidates(previewDir);
  const backendSub = classifyBackendSubfolder(previewDir);
  if (backendSub && !candidates.some((c) => c.path === backendSub.path)) {
    candidates.push(backendSub);
  }
  const picked = pickByDirNames(candidates);
  const infra = detectInfra(previewDir, candidates);
  const { appType, topology, services, publicService } = buildSuggestions(
    candidates,
    picked,
    infra
  );

  /** @type {string[]} */
  const parts = [];
  if (appType !== "unknown") parts.push(`tipo=${appType}`);
  if (picked.frontend) parts.push(`front@${picked.frontend.path} (${picked.frontend.framework})`);
  if (picked.backend) parts.push(`back@${picked.backend.path} (${picked.backend.framework})`);
  if (infra.postgres?.required) parts.push("postgres");
  if (infra.redis?.required) parts.push("redis");

  return {
    appType,
    stack: {
      frontend: picked.frontend
        ? {
            path: picked.frontend.path,
            framework: picked.frontend.framework,
            port: picked.frontend.port,
          }
        : null,
      backend: picked.backend
        ? {
            path: picked.backend.path,
            framework: picked.backend.framework,
            port: picked.backend.port,
          }
        : null,
      candidates: candidates.map((c) => ({
        path: c.path,
        kind: c.kind,
        framework: c.framework,
      })),
    },
    infra,
    suggestedTopology: topology,
    suggestedServices: services,
    publicService,
    summary: parts.length ? parts.join(", ") : "stack não identificada",
  };
}

/**
 * @param {object} profile
 */
export function formatStackProfileForPrompt(profile) {
  return JSON.stringify(profile, null, 2);
}
