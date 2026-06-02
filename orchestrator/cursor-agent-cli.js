/**
 * Argumentos extra para o Cursor CLI em modo não interativo (Docker / CI).
 * Headless exige `-p` (print); `--trust` só funciona com `-p`.
 * Desativar trust: CURSOR_AGENT_TRUST=false
 * Override total: CURSOR_AGENT_ARGS="-p --trust --force"
 */
export function cursorCommand() {
  return process.env.CURSOR_AGENT || "agent";
}

export function cursorAgentArgv() {
  const custom = process.env.CURSOR_AGENT_ARGS?.trim();
  if (custom) {
    return custom.split(/\s+/).filter(Boolean);
  }
  const args = ["-p", "--force"];
  const trust = process.env.CURSOR_AGENT_TRUST;
  if (trust !== "0" && trust !== "false" && trust !== "no") {
    args.push("--trust");
  }
  return args;
}
