export type LogLevel = "debug" | "info" | "warn" | "error" | "success";

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[94m",
  warn: "\x1b[93m",
  error: "\x1b[91m",
  success: "\x1b[92m",
};
const RESET = "\x1b[0m";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function log(level: LogLevel, msg: string): void {
  if (level === "debug" && !verbose) return;
  const label = level.toUpperCase().padEnd(7);
  console.log(`${COLORS[level]}[${stamp()} ${label}]${RESET} ${msg}`);
}

export const logger = {
  debug: (m: string) => log("debug", m),
  info: (m: string) => log("info", m),
  warn: (m: string) => log("warn", m),
  error: (m: string) => log("error", m),
  success: (m: string) => log("success", m),
};
