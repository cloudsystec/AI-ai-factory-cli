/**
 * Argumentos extra para o Cursor CLI em modo não interativo (Docker / CI).
 * Desativar: CURSOR_AGENT_TRUST=false
 * Override: CURSOR_AGENT_ARGS="--trust --yolo"
 */
export function cursorCommand() {
  return process.env.CURSOR_AGENT || "agent";
}

export function cursorAgentArgv() {
  const custom = process.env.CURSOR_AGENT_ARGS?.trim();
  if (custom) {
    return custom.split(/\s+/).filter(Boolean);
  }
  const trust = process.env.CURSOR_AGENT_TRUST;
  if (trust === "0" || trust === "false" || trust === "no") {
    return [];
  }
  return ["--trust"];
}
