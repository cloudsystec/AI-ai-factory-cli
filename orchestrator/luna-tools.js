import fs from "node:fs";
import path from "node:path";
import { workspaceRoot, tenantRoot, isValidProjectSlug } from "./project-paths.js";

export const LUNA_TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Escreve ou sobrescreve um ficheiro no workspace do tenant",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Caminho relativo ao workspace ou tenant" },
          content: { type: "string", description: "Conteúdo completo do ficheiro" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Lê conteúdo de um ficheiro no workspace do tenant",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Caminho relativo ao workspace ou tenant" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Lista ficheiros num diretório",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Diretório relativo" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Procura texto em ficheiros (máx 20 matches)",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Diretório base" },
        },
        required: ["pattern"],
      },
    },
  },
];

/**
 * @param {string} rel
 */
function resolveSafePath(rel) {
  const project = process.env.AI_FACTORY_ACTIVE_PROJECT || "";
  const normalized = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal negado");
  }
  if (project && isValidProjectSlug(project)) {
    const inWs = path.resolve(workspaceRoot(project), normalized);
    const wsRoot = path.resolve(workspaceRoot(project));
    if (inWs.startsWith(wsRoot)) return inWs;
  }
  const inTenant = path.resolve(tenantRoot(), normalized);
  const tRoot = path.resolve(tenantRoot());
  if (inTenant.startsWith(tRoot)) return inTenant;
  throw new Error("Path fora do workspace permitido");
}

/**
 * @param {{ name: string, arguments: string }} call
 */
export function executeLunaTool(call) {
  let args = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { error: "JSON inválido nos argumentos" };
  }

  if (call.name === "write_file") {
    const filePath = resolveSafePath(args.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(args.content ?? ""), "utf-8");
    return { path: args.path, written: true };
  }

  if (call.name === "read_file") {
    const filePath = resolveSafePath(args.path);
    if (!fs.existsSync(filePath)) return { error: "Ficheiro não encontrado" };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { error: "Não é ficheiro" };
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      path: args.path,
      content: content.length > 16_000 ? content.slice(0, 16_000) + "\n…" : content,
    };
  }

  if (call.name === "list_directory") {
    const dirPath = resolveSafePath(args.path || ".");
    if (!fs.existsSync(dirPath)) return { error: "Diretório não encontrado" };
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 100);
    return {
      path: args.path || ".",
      entries: entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      })),
    };
  }

  if (call.name === "grep_files") {
    const pattern = String(args.pattern || "");
    const base = resolveSafePath(args.path || ".");
    /** @type {Array<{ file: string, line: number, text: string }>} */
    const matches = [];
    const walk = (dir, depth = 0) => {
      if (depth > 4 || matches.length >= 20) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (ent.isFile() && ent.name.match(/\.(md|json|js|ts|tsx|jsx|py|txt)$/i)) {
          try {
            const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                matches.push({
                  file: path.relative(base, full).replace(/\\/g, "/"),
                  line: i + 1,
                  text: lines[i].slice(0, 200),
                });
                if (matches.length >= 20) return;
              }
            }
          } catch {
            /* ignore binary */
          }
        }
      }
    };
    if (fs.statSync(base).isDirectory()) walk(base);
    return { pattern, matches };
  }

  return { error: `Tool desconhecida: ${call.name}` };
}
