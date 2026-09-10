import fs from "node:fs";
import path from "node:path";
import type { LogLevelName } from "./config.js";

const rank: Record<LogLevelName, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_STRING = 2000;
const SECRET_KEY = /token|password|secret|authorization|x-api-key|cookie|proxy.?pass|api.?key/i;

export function redactString(value: string): string {
  return value
    .replace(/([?&]token=)[^&\s]+/gi, "$1<REDACTED>")
    .replace(/(authorization\s*[:=]\s*|x-api-key\s*[:=]\s*|cookie\s*[:=]\s*)[^,\s]+/gi, "$1<REDACTED>")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<REDACTED>@")
    .slice(0, MAX_STRING);
}

function safeScalar(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function safeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  const scalar = safeScalar(value);
  if (scalar !== undefined || value === null || value === undefined) return scalar;
  if (depth >= MAX_DEPTH) return "<MAX_DEPTH>";
  if (typeof value !== "object" && typeof value !== "function") return String(value);
  if (seen.has(value as object)) return "<CIRCULAR>";
  seen.add(value as object);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => safeValue(item, depth + 1, seen));
  const result: Record<string, unknown> = {
    constructor: (value as object).constructor?.name ?? null,
    tag: Object.prototype.toString.call(value)
  };
  for (const key of ["name", "message", "code", "errno", "syscall", "hostname", "address", "port", "stack", "statusCode", "statusMessage", "reason", "wasClean", "readyState", "url", "_url"]) {
    if (SECRET_KEY.test(key)) continue;
    try {
      const field = safeScalar((value as Record<string, unknown>)[key]);
      if (field !== undefined) result[key] = field;
    } catch { result[key] = "<UNREADABLE>"; }
  }
  try {
    const errors = (value as { errors?: unknown }).errors;
    if (Array.isArray(errors)) result.errors = errors.slice(0, MAX_ARRAY).map((item) => safeValue(item, depth + 1, seen));
  } catch { result.errors = "<UNREADABLE>"; }
  return result;
}

export function serializeDiagnostic(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    typeof: typeof value,
    constructor: (value as { constructor?: { name?: string } } | null | undefined)?.constructor?.name ?? null,
    tag: Object.prototype.toString.call(value)
  };
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return result;
  const object = value as Record<PropertyKey, unknown>;
  try { result.keys = Object.keys(object).slice(0, MAX_ARRAY); } catch { result.keys = "<UNREADABLE>"; }
  try { result.own_property_names = Object.getOwnPropertyNames(object).slice(0, MAX_ARRAY); } catch { result.own_property_names = "<UNREADABLE>"; }
  let symbols: symbol[] = [];
  try { symbols = Object.getOwnPropertySymbols(object).slice(0, MAX_ARRAY); result.own_symbols = symbols.map(String); } catch { result.own_symbols = "<UNREADABLE>"; }
  try { result.reflect_own_keys = Reflect.ownKeys(object).slice(0, MAX_ARRAY).map((key) => typeof key === "symbol" ? String(key) : key); } catch { result.reflect_own_keys = "<UNREADABLE>"; }
  try { result.prototype_constructor = Object.getPrototypeOf(object)?.constructor?.name ?? null; } catch { result.prototype_constructor = "<UNREADABLE>"; }
  const seen = new WeakSet<object>();
  seen.add(object);
  for (const key of ["name", "message", "code", "errno", "syscall", "hostname", "address", "port", "stack", "statusCode", "statusMessage", "reason", "wasClean", "readyState"]) {
    if (SECRET_KEY.test(key)) continue;
    try {
      const field = safeScalar(object[key]);
      if (field !== undefined) result[key] = field;
    } catch { result[key] = "<UNREADABLE>"; }
  }
  try {
    if (Array.isArray(object.errors)) result.nested_errors = object.errors.slice(0, MAX_ARRAY).map((item) => safeValue(item, 1, seen));
  } catch { result.nested_errors = "<UNREADABLE>"; }
  result.properties = {};
  for (const key of Object.getOwnPropertyNames(object).slice(0, MAX_ARRAY)) {
    if (SECRET_KEY.test(key)) continue;
    try { (result.properties as Record<string, unknown>)[key] = safeValue(object[key], 1, seen); } catch { (result.properties as Record<string, unknown>)[key] = "<UNREADABLE>"; }
  }
  result.symbol_values = {};
  for (const symbol of symbols) {
    try { (result.symbol_values as Record<string, unknown>)[String(symbol)] = safeValue(object[symbol], 1, seen); } catch { (result.symbol_values as Record<string, unknown>)[String(symbol)] = "<UNREADABLE>"; }
  }
  return result;
}

export interface ConsoleCapture {
  restore(): void;
}

export function installConsoleCapture(onMessage: (level: LogLevelName, args: unknown[]) => void): ConsoleCapture {
  const originals: Record<LogLevelName, (...args: unknown[]) => void> = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  let active = true;
  for (const level of Object.keys(originals) as LogLevelName[]) {
    console[level] = (...args: unknown[]) => { if (active) onMessage(level, args); };
  }
  return { restore: () => { if (!active) return; active = false; for (const level of Object.keys(originals) as LogLevelName[]) console[level] = originals[level]; } };
}

export class ProbeLogger {
  private readonly stream: fs.WriteStream;
  private streamError: Error | undefined;
  private errorHandler: ((error: Error) => void) | undefined;
  constructor(private readonly filePath: string, private readonly level: LogLevelName) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
    this.stream.on("error", (error) => { this.streamError = error; this.errorHandler?.(error); });
  }
  setErrorHandler(handler: (error: Error) => void): void { this.errorHandler = handler; if (this.streamError) handler(this.streamError); }
  private writeLine(level: LogLevelName, message: string, stdout: boolean): void {
    const line = `${new Date().toISOString()} | ${level.toUpperCase()} | ${redactString(message)}`;
    if (stdout) process.stdout.write(`${line}\n`);
    if (!this.streamError) this.stream.write(`${line}\n`);
  }
  log(level: LogLevelName, message: string): void { if (rank[level] >= rank[this.level]) this.writeLine(level, message, true); else if (!this.streamError) this.stream.write(`${new Date().toISOString()} | ${level.toUpperCase()} | ${redactString(message)}\n`); }
  sdk(level: LogLevelName, args: unknown[]): void {
    const message = args.map((arg) => typeof arg === "string" ? redactString(arg) : JSON.stringify(serializeDiagnostic(arg))).join(" ");
    this.writeLine(level, `SDK ${message}`, rank[level] >= rank[this.level]);
  }
  debug(message: string) { this.log("debug", message); }
  info(message: string) { this.log("info", message); }
  warn(message: string) { this.log("warn", message); }
  error(message: string) { this.log("error", message); }
  async close(): Promise<void> { await new Promise<void>((resolve) => this.stream.end(resolve)); }
}
