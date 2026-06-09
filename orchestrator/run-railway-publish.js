import fs from "node:fs";
import path from "node:path";
import { workspaceRoot, isValidProjectSlug } from "./project-paths.js";
import { deployDirectoryHasFiles } from "./deploy-workspace-filter.js";
import {
  prepareDeploySourceExport,
  validateDeployDockerfileForTree,
  describeDeployPreviewTree,
  describeDeployPreviewDetail,
  DEPLOY_PREVIEW_DIR,
} from "./deploy-source-export.js";
import {
  analyzeDeployStack,
  formatStackProfileForPrompt,
  enrichReadinessFromStackProfile,
} from "./deploy-stack-analyzer.js";
import { readGlobalRules, readAgentFile, systemSecurityRules } from "./agent-prompts.js";
import { runCursorAgent } from "./cursor-agent-runner.js";
import { syncDeployRepo } from "./git/sync-deploy-repo.js";
import { verifyDeployLive } from "./deploy-live-verify.js";
import {
  enrichErrorWithRailwayBuildLogs,
  assertRailwayBuildNotFailed,
} from "./deploy-railway-build-logs.js";
import { backFetch, fetchRailwayDeploymentState } from "../src/back-client.js";

const READINESS_REL = path.join("reports", "deploy", "railway-readiness.json");
const STACK_PROFILE_REL = path.join("reports", "deploy", "stack-profile.json");
const MAX_PUBLISH_CYCLES = 5;
const MAX_INLINE_FIX_ATTEMPTS = 2;

/** deploy-railway analisa monorepos — default 5 min é insuficiente. */
const DEPLOY_AGENT_TIMEOUT_MS = Number(
  process.env.DEPLOY_AGENT_TIMEOUT_MS || 900_000
);

/**
 * @param {string} msg
 */
function isRailwayResourceExistsError(msg) {
  return /already exists/i.test(msg);
}

/**
 * Erros de infra/BD — se já houver URL pública, tentar verificação HTTP em vez de fix-agent.
 * @param {string} msg
 */
function isInfraProvisionError(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    isRailwayResourceExistsError(m) ||
    /23514/.test(m) ||
    /status_check/.test(m) ||
    /check constraint/.test(m) ||
    /violates.*constraint/.test(m) ||
    /violates.*restri/.test(m)
  );
}

/**
 * @param {string} project
 * @param {string|null|undefined} primaryUrl
 */
async function resolveKnownPublicUrl(project, primaryUrl = null) {
  if (primaryUrl) return primaryUrl;
  try {
    const state = await fetchRailwayDeploymentState(project);
    return state.publicUrl || null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>|null|undefined} body
 * @returns {string|null}
 */
function publicUrlFromProvisionBody(body) {
  if (!body || typeof body !== "object") return null;
  const url = body.publicUrl;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

const FRIENDLY_PUBLISH_FAILED =
  "Não foi possível publicar a aplicação automaticamente. " +
  "Tente novamente em alguns minutos ou contacte suporte.";

/**
 * @param {string} wsRoot
 */
function stackProfilePath(wsRoot) {
  return path.join(wsRoot, STACK_PROFILE_REL);
}

/**
 * @param {string} wsRoot
 */
function readinessPath(wsRoot) {
  return path.join(wsRoot, READINESS_REL);
}

/**
 * @param {unknown} data
 */
function validateReadiness(data) {
  if (!data || typeof data !== "object") {
    throw new Error("railway-readiness.json inválido");
  }
  const r = /** @type {Record<string, unknown>} */ (data);
  if (!r.verdict || typeof r.verdict !== "string") {
    throw new Error("verdict em falta");
  }
  if (r.verdict === "deployable") {
    if (!Array.isArray(r.services) || r.services.length === 0) {
      throw new Error("services em falta para deployable");
    }
    const generated = Array.isArray(r.generatedFiles) ? r.generatedFiles : [];
    const hasDocker =
      generated.some((f) => String(f).startsWith("Dockerfile")) ||
      r.services.some(
        (s) =>
          s &&
          typeof s === "object" &&
          /** @type {Record<string, unknown>} */ (s).dockerfilePath
      );
    if (!hasDocker) {
      throw new Error("Nenhum Dockerfile listado em generatedFiles ou services");
    }
    if (!r.appType) {
      throw new Error("appType em falta — classificar frontend/backend/fullstack");
    }
  }
  return r;
}

/**
 * @param {Record<string, unknown>} readiness
 * @param {string} wsRoot
 * @param {string} previewDir
 */
function validateServiceDockerfiles(readiness, wsRoot, previewDir) {
  const services = /** @type {Array<Record<string, unknown>>} */ (
    readiness.services || []
  );
  for (const svc of services) {
    const name = String(svc.name || "app");
    const dockerRel = String(svc.dockerfilePath || "Dockerfile").replace(/^\.\//, "");
    const rootDir = String(svc.rootDirectory || ".").replace(/^\.\//, "");
    const dockerfile = path.isAbsolute(dockerRel)
      ? dockerRel
      : path.join(wsRoot, dockerRel);
    if (!fs.existsSync(dockerfile)) {
      throw new Error(`Dockerfile ausente para serviço ${name}: ${dockerRel}`);
    }
    const serviceTree =
      rootDir && rootDir !== "." ? path.join(previewDir, rootDir) : previewDir;
    validateDeployDockerfileForTree(dockerfile, serviceTree, wsRoot);
  }
}

/**
 * @param {string} project
 * @param {string} status
 * @param {{ readiness?: Record<string, unknown>, error?: string }} [extra]
 */
async function notifyPublishOutcome(project, status, extra = {}) {
  await backFetch(
    `/worker/projects/${encodeURIComponent(project)}/railway-publish/outcome`,
    {
      method: "POST",
      body: JSON.stringify({ status, ...extra }),
    }
  ).catch(() => {});
}

/**
 * @param {string} project
 * @param {object} job
 * @param {Record<string, unknown>} readiness
 * @param {string} previewBranch
 * @param {(line: string) => void} onLine
 */
async function syncAndProvision(project, job, readiness, previewBranch, onLine) {
  onLine(`[sync] garantir repo deploy privado…\n`);
  const ensureRes = await backFetch(
    `/worker/projects/${encodeURIComponent(project)}/deploy-repo/ensure`,
    { method: "POST", body: JSON.stringify({}) }
  );
  const ensureBody = await ensureRes.json();
  const repoFullName = ensureBody.repoFullName;
  const resolvedSourceBranch =
    previewBranch || job.git?.techLeadBranch || ensureBody.sourceBranch || "tech-lead";
  const deployBranch = ensureBody.deployBranch || resolvedSourceBranch;
  const token = job.githubInstallationToken || process.env.AI_FACTORY_GITHUB_TOKEN;
  if (!token) {
    return { publicUrl: null, error: "Token GitHub plataforma em falta" };
  }

  onLine(`[sync] origem ${resolvedSourceBranch} → repo deploy branch ${deployBranch}\n`);
  await notifyPublishOutcome(project, "syncing");

  const generatedFiles = Array.isArray(readiness.generatedFiles)
    ? readiness.generatedFiles
    : [];

  try {
    await syncDeployRepo(
      project,
      {
        token,
        repoFullName,
        branch: deployBranch,
        sourceBranch: resolvedSourceBranch,
        workspaceRoot: workspaceRoot(project),
        generatedFiles,
      },
      onLine
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { publicUrl: null, error: msg };
  }

  onLine(`[provision] aguardar Railway processar push Git (10s)…\n`);
  await new Promise((r) => setTimeout(r, 10_000));

  onLine(`[provision] Railway…\n`);
  await notifyPublishOutcome(project, "provisioning");

  try {
    const provRes = await backFetch(
      `/worker/projects/${encodeURIComponent(project)}/railway-provision`,
      {
        method: "POST",
        body: JSON.stringify({
          readiness,
          deployRepoFullName: repoFullName,
          deployBranch,
        }),
      }
    );
    const provBody = await provRes.json();
    if (!provRes.ok) {
      const errMsg = provBody.error || "Provision Railway falhou";
      if (isRailwayResourceExistsError(errMsg)) {
        onLine(`[provision] recurso Railway já existe — nova tentativa de provision…\n`);
        await new Promise((r) => setTimeout(r, 3000));
        const retryRes = await backFetch(
          `/worker/projects/${encodeURIComponent(project)}/railway-provision`,
          {
            method: "POST",
            body: JSON.stringify({
              readiness,
              deployRepoFullName: repoFullName,
              deployBranch,
            }),
          }
        );
        const retryBody = await retryRes.json();
        if (retryRes.ok && retryBody.provisioned && retryBody.publicUrl) {
          onLine(`[provision] URL interna (aguarda verificação): ${retryBody.publicUrl}\n`);
          return { publicUrl: retryBody.publicUrl, error: null, partial: !!retryBody.partial };
        }
        const retryUrl = await resolveKnownPublicUrl(
          project,
          publicUrlFromProvisionBody(retryBody)
        );
        if (retryUrl) {
          onLine(
            `[provision] erro infra após retry — URL conhecida ${retryUrl}, continuar para verificação\n`
          );
          return {
            publicUrl: retryUrl,
            error: null,
            partial: true,
            warning: retryBody.error || errMsg,
          };
        }
      }

      const fallbackUrl = await resolveKnownPublicUrl(
        project,
        publicUrlFromProvisionBody(provBody)
      );
      if (fallbackUrl) {
        onLine(
          `[provision] erro (${errMsg.slice(0, 120)}) — URL ${fallbackUrl}, continuar para verificação\n`
        );
        return {
          publicUrl: fallbackUrl,
          error: null,
          partial: true,
          warning: errMsg,
        };
      }
      return { publicUrl: null, error: errMsg, partial: false };
    }
    if (provBody.partial && provBody.publicUrl) {
      onLine(
        `[provision] provision parcial (${provBody.warning || "aviso"}) — URL ${provBody.publicUrl}\n`
      );
      return {
        publicUrl: provBody.publicUrl,
        error: null,
        partial: true,
        warning: provBody.warning || null,
      };
    }
    if (!provBody.provisioned) {
      const fallbackUrl = await resolveKnownPublicUrl(project);
      if (fallbackUrl) {
        onLine(
          `[provision] não provisionado — URL existente ${fallbackUrl}, continuar para verificação\n`
        );
        return {
          publicUrl: fallbackUrl,
          error: null,
          partial: true,
          warning: provBody.verdict || "not_provisioned",
        };
      }
      return { publicUrl: null, error: provBody.verdict || "not_provisioned", partial: false };
    }
    const publicUrl = provBody.publicUrl || null;
    if (publicUrl) {
      onLine(`[provision] URL interna (aguarda verificação): ${publicUrl}\n`);
    }
    return {
      publicUrl,
      error: publicUrl ? null : "Sem URL pública após provision",
      partial: !!provBody.partial,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const fallbackUrl = await resolveKnownPublicUrl(project);
    if (fallbackUrl) {
      onLine(
        `[provision] excepção — URL ${fallbackUrl}, continuar para verificação\n`
      );
      return { publicUrl: fallbackUrl, error: null, partial: true, warning: msg };
    }
    return { publicUrl: null, error: msg, partial: false };
  }
}

/**
 * @param {string} ws
 */
function readDockerfileSnippet(ws) {
  const dockerfile = path.join(ws, "Dockerfile");
  if (!fs.existsSync(dockerfile)) return "(Dockerfile ausente)";
  const lines = fs.readFileSync(dockerfile, "utf8").split("\n").slice(0, 40);
  return lines.join("\n");
}

/**
 * @param {string} project
 * @param {string} ws
 * @param {ReturnType<typeof prepareDeploySourceExport>} preview
 * @param {{ cycle: number, lastReadiness?: Record<string, unknown>|null, runtimeError?: string|null, verifyError?: string|null }} ctx
 * @param {(line: string) => void} onLine
 */
function runDeployAgent(project, ws, preview, stackProfile, ctx, onLine) {
  const agentRules = readAgentFile("agents/deploy-railway.md");
  const globalRules = readGlobalRules();

  let retrySection = "";
  if (ctx.cycle > 1 || ctx.runtimeError || ctx.verifyError) {
    retrySection = `

## Falha(s) a corrigir (obrigatório resolver antes de concluir)

O sistema **repetirá automaticamente** até publicar. Corrige Dockerfile, paths \`COPY\`, \`rootDirectory\` e readiness.

\`\`\`json
${JSON.stringify(
  {
    cycle: ctx.cycle,
    verdict: ctx.lastReadiness?.verdict ?? null,
    blockers: ctx.lastReadiness?.blockers || [],
    summary: ctx.lastReadiness?.summary || null,
    runtimeError: ctx.runtimeError || null,
    verifyError: ctx.verifyError || null,
  },
  null,
  2
)}
\`\`\`

Árvore actual em \`${DEPLOY_PREVIEW_DIR}/\`:
\`\`\`
${describeDeployPreviewDetail(preview.dir)}
\`\`\`

Dockerfile actual (primeiras linhas):
\`\`\`dockerfile
${readDockerfileSnippet(ws)}
\`\`\`
`;
  }

  const prompt = `
${globalRules}

---

${agentRules}

${systemSecurityRules()}

---

## Projecto: ${project}
Workspace: ${ws}

## Código para deploy (OBRIGATÓRIO)

Analisa **apenas** a pasta \`${DEPLOY_PREVIEW_DIR}/\` — é o que vai para o repo deploy (branch \`${preview.branch}\`).

Conteúdo na raiz do preview: ${describeDeployPreviewTree(preview.dir)}

## Pré-análise automática (stack-profile.json)

\`\`\`json
${formatStackProfileForPrompt(stackProfile)}
\`\`\`

Confirma ou corrige \`appType\`, \`infra\`, \`services\` e gera \`docker-compose.yml\` quando fullstack ou infra múltipla.

**Nunca** uses paths \`tasks/\`, \`agents/\`, \`reports/\`, \`scopes/\`, \`backlog/\` no Dockerfile — essas pastas **não existem** no repo deploy.

Gera Dockerfile(s) com \`COPY\` relativos à **raiz de cada serviço** (\`rootDirectory\`). Cada \`COPY\` deve existir na árvore listada acima.

Grava artefactos na **raiz do workspace** (\`${ws}\`): Dockerfile(s), docker-compose.yml (se aplicável), railway.json, .env.example, ${STACK_PROFILE_REL}, e ${READINESS_REL}.
${retrySection}
`.trim();

  onLine(`[agent] deploy-railway (ciclo ${ctx.cycle})…\n`);
  runCursorAgent({
    agentFile: "agents/deploy-railway.md",
    agentName: "deploy-railway",
    prompt,
    meta: { project, step: "railway-publish", cycle: ctx.cycle },
    timeoutMs: DEPLOY_AGENT_TIMEOUT_MS,
  });
}

/**
 * Agente focado em corrigir erro concreto (sync, Dockerfile, provision).
 * @param {string} project
 * @param {string} ws
 * @param {ReturnType<typeof prepareDeploySourceExport>} preview
 * @param {string} error
 * @param {(line: string) => void} onLine
 */
function runDeployFixAgent(project, ws, preview, error, onLine) {
  const agentRules = readAgentFile("agents/deploy-railway.md");
  const globalRules = readGlobalRules();

  const prompt = `
${globalRules}

---

${agentRules}

${systemSecurityRules()}

---

## CORREÇÃO URGENTE — publicação bloqueada

Projecto: ${project}
Workspace: ${ws}

### Erro detectado
\`\`\`
${error}
\`\`\`

### Árvore deploy (\`${DEPLOY_PREVIEW_DIR}/\`)
\`\`\`
${describeDeployPreviewDetail(preview.dir)}
\`\`\`

### Dockerfile actual
\`\`\`dockerfile
${readDockerfileSnippet(ws)}
\`\`\`

**Tarefa:** corrige o Dockerfile, \`rootDirectory\`, \`dockerfilePath\` e \`railway-readiness.json\` para que o erro desapareça.
Cada instrução COPY ou ADD deve apontar para ficheiros que existem na árvore acima.
Marca \`verdict: deployable\` quando estiver pronto. Não termines sem corrigir.
`.trim();

  onLine(`[fix-agent] corrigir: ${error.slice(0, 120)}…\n`);
  runCursorAgent({
    agentFile: "agents/deploy-railway.md",
    agentName: "deploy-railway",
    prompt,
    meta: { project, step: "railway-publish-fix" },
    timeoutMs: DEPLOY_AGENT_TIMEOUT_MS,
  });
}

/**
 * @param {string} ws
 * @param {ReturnType<typeof analyzeDeployStack>} stackProfile
 * @param {(line: string) => void} onLine
 */
function loadReadinessFromWorkspace(ws, stackProfile, onLine) {
  const readinessFile = readinessPath(ws);
  if (!fs.existsSync(readinessFile)) {
    throw new Error("railway-readiness.json não gerado pelo agente");
  }
  const rawReadiness = JSON.parse(fs.readFileSync(readinessFile, "utf-8"));
  const readiness = validateReadiness(
    enrichReadinessFromStackProfile(
      /** @type {Record<string, unknown>} */ (rawReadiness),
      stackProfile
    )
  );
  if (readiness.appType !== rawReadiness.appType) {
    fs.writeFileSync(readinessFile, `${JSON.stringify(readiness, null, 2)}\n`);
    onLine(
      `[stack] readiness enriquecido: appType=${readiness.appType}, topology=${readiness.topology || "?"}\n`
    );
  }
  return readiness;
}

/**
 * Pipeline pós-agente: validar → sync → provision → verify.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function runDeployPipeline(project, job, ws, preview, readiness, onLine) {
  if (readiness.verdict !== "deployable") {
    const summary =
      typeof readiness.summary === "string" && readiness.summary.trim()
        ? readiness.summary
        : "readiness não deployável";
    throw new Error(summary);
  }

  validateServiceDockerfiles(readiness, ws, preview.dir);
  onLine(
    `[preview] Dockerfiles validados (${/** @type {unknown[]} */ (readiness.services).length} serviço(s))\n`
  );

  const {
    publicUrl: provisionUrl,
    error: provisionError,
    partial,
    warning,
  } = await syncAndProvision(project, job, readiness, preview.branch, onLine);

  let publicUrl = provisionUrl || (await resolveKnownPublicUrl(project));

  if (!publicUrl) {
    throw new Error(provisionError || "provision sem URL");
  }

  if (partial || warning || (provisionError && isInfraProvisionError(provisionError))) {
    onLine(
      `[provision] ignorando erro infra — verificar se ${publicUrl} está online\n`
    );
  } else if (provisionError) {
    onLine(`[provision] aviso: ${provisionError}\n`);
  }

  await notifyPublishOutcome(project, "verifying");

  await assertRailwayBuildNotFailed(project, onLine);

  const verify = await verifyDeployLive(publicUrl, readiness, onLine, {
    skipInitialWait: !!(partial || warning),
  });
  if (!verify.ok) {
    const enriched = await enrichErrorWithRailwayBuildLogs(
      project,
      verify.error || "verificação HTTP falhou",
      onLine
    );
    throw new Error(enriched);
  }

  return { ok: true };
}

/**
 * @param {object} job
 * @param {(line: string) => void} onLine
 */
export async function run(job, onLine = () => {}) {
  const project = job.projectSlug;
  if (!project || !isValidProjectSlug(project)) {
    throw new Error("projectSlug inválido");
  }

  const ws = workspaceRoot(project);
  const cacheDir = path.join(ws, ".git-cache");
  if (!deployDirectoryHasFiles(ws) && !fs.existsSync(cacheDir)) {
    throw new Error(`Workspace sem código deployável: ${ws}`);
  }

  onLine(`[railway-publish] projecto ${project}\n`);
  await notifyPublishOutcome(project, "analyzing");

  const sourceBranch = job.git?.techLeadBranch || "tech-lead";

  /** @type {Record<string, unknown> | null} */
  let lastReadiness = null;
  /** @type {string | null} */
  let lastRuntimeError = null;
  /** @type {string | null} */
  let lastVerifyError = null;

  for (let cycle = 1; cycle <= MAX_PUBLISH_CYCLES; cycle += 1) {
    if (cycle > 1) {
      onLine(`[retry] novo ciclo ${cycle}/${MAX_PUBLISH_CYCLES}…\n`);
      await notifyPublishOutcome(project, "analyzing");
    }

    const preview = prepareDeploySourceExport(ws, sourceBranch);
    onLine(
      `[preview] export ${preview.from} branch ${preview.branch} → ${DEPLOY_PREVIEW_DIR}/\n`
    );
    onLine(`[preview] raiz: ${describeDeployPreviewTree(preview.dir)}\n`);

    const stackProfile = analyzeDeployStack(preview.dir);
    const stackFile = stackProfilePath(ws);
    fs.mkdirSync(path.dirname(stackFile), { recursive: true });
    fs.writeFileSync(stackFile, `${JSON.stringify(stackProfile, null, 2)}\n`);
    onLine(`[stack] ${stackProfile.summary} → topology=${stackProfile.suggestedTopology}\n`);

    try {
      runDeployAgent(
        project,
        ws,
        preview,
        stackProfile,
        {
          cycle,
          lastReadiness,
          runtimeError: lastRuntimeError,
          verifyError: lastVerifyError,
        },
        onLine
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastRuntimeError = msg;
      onLine(`[agent] erro: ${msg}\n`);
      if (cycle < MAX_PUBLISH_CYCLES) {
        continue;
      }
      break;
    }

    for (let fix = 0; fix <= MAX_INLINE_FIX_ATTEMPTS; fix += 1) {
      try {
        const readiness = loadReadinessFromWorkspace(ws, stackProfile, onLine);
        lastReadiness = readiness;
        onLine(`[agent] verdict=${readiness.verdict} appType=${readiness.appType}\n`);

        await runDeployPipeline(project, job, ws, preview, readiness, onLine);

        await notifyPublishOutcome(project, "deployed");
        onLine(`[railway-publish] concluído — aplicação verificada online\n`);
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastRuntimeError = msg;
        const isVerifyFailure =
          msg.includes("verify") ||
          msg.includes("HTTP") ||
          msg.includes("/health") ||
          msg.includes("Railway") ||
          msg.includes("página de erro") ||
          msg.includes("Erro visível") ||
          msg.includes("Consola:") ||
          msg.includes("verify-browser") ||
          msg.includes("Illegal invocation") ||
          msg.includes("failed to fetch");
        lastVerifyError = isVerifyFailure ? msg : lastVerifyError;

        onLine(`[pipeline] erro: ${msg}\n`);

        if (fix < MAX_INLINE_FIX_ATTEMPTS && isVerifyFailure) {
          const fixError = await enrichErrorWithRailwayBuildLogs(project, msg, onLine);
          runDeployFixAgent(project, ws, preview, fixError, onLine);
          continue;
        }
        if (fix < MAX_INLINE_FIX_ATTEMPTS && !isInfraProvisionError(msg)) {
          const fixError = await enrichErrorWithRailwayBuildLogs(project, msg, onLine);
          runDeployFixAgent(project, ws, preview, fixError, onLine);
          continue;
        }
        onLine(`[pipeline] esgotadas correcções inline — novo ciclo completo\n`);
        break;
      }
    }
  }

  await notifyPublishOutcome(project, "failed", { error: FRIENDLY_PUBLISH_FAILED });
  onLine(`[railway-publish] esgotadas ${MAX_PUBLISH_CYCLES} tentativas\n`);
  return 1;
}
