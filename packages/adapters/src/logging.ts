import { appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Structured JSON logging (RUN-009, RUN-010, SEC-010, SEC-011): every process writes
 * one JSON line per record to `<home>/logs/sorage.log`, rotates by size, defaults the
 * CLI to `warn`, optionally redacts home paths while keeping stable identifiers, and
 * refuses to write any token material.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface RotationConfig {
  maxBytes: number;
  maxFiles: number;
}

export interface LoggerConfig {
  /** Absolute path of the log file, `<home>/logs/sorage.log` in a real installation. */
  file: string;
  level?: LogLevel | undefined;
  /** Defaults to the documented 10485760 bytes and 5 retained files. */
  rotation?: Partial<RotationConfig> | undefined;
  /** When true (logging.includeFullPaths), home paths are written verbatim. */
  includeFullPaths?: boolean | undefined;
  /** The Sorage home whose path is redacted from records. */
  homePath?: string | undefined;
  /** Token material and other secrets that must never reach a log line. */
  secrets?: string[] | undefined;
}

export interface LogRecord {
  level: LogLevel;
  event: string;
  requestId?: string;
  [field: string]: unknown;
}

/** The minimum length of a token fragment the guard treats as token material. */
const SECRET_FRAGMENT_LENGTH = 8;

export function createLogger(config: LoggerConfig) {
  const level = config.level ?? "warn";
  const rotation: RotationConfig = {
    maxBytes: config.rotation?.maxBytes ?? 10_485_760,
    maxFiles: config.rotation?.maxFiles ?? 5,
  };
  mkdirSync(dirname(config.file), { recursive: true });

  function enabled(recordLevel: LogLevel): boolean {
    return LEVEL_ORDER[recordLevel] >= LEVEL_ORDER[level];
  }

  function log(record: LogRecord): void {
    if (!enabled(record.level)) return;
    const line = `${renderLine(record)}\n`;
    rotateIfNeeded(Buffer.byteLength(line, "utf8"));
    appendFileSync(config.file, line);
  }

  function renderLine(record: LogRecord): string {
    const enriched: LogRecord = { ts: new Date().toISOString(), ...record };
    const redacted = config.includeFullPaths === true ? enriched : redactPaths(enriched, config.homePath);
    const safe = scrubSecrets(redacted, config.secrets);
    return JSON.stringify(safe);
  }

  function rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(config.file)) return;
    const currentSize = statSync(config.file).size;
    if (currentSize + incomingBytes <= rotation.maxBytes) return;
    const directory = dirname(config.file);
    const base = basename(config.file);
    const existing = new Set(readdirSync(directory));
    // Drop the oldest rotated file first so the window keeps exactly maxFiles files.
    const oldest = join(directory, `${base}.${rotation.maxFiles}`);
    if (rotation.maxFiles >= 1 && existing.has(`${base}.${rotation.maxFiles}`)) rmSync(oldest);
    // Shift the oldest first so a shift never overwrites an unread file.
    for (let index = rotation.maxFiles - 1; index >= 1; index--) {
      const from = join(directory, `${base}.${index}`);
      const to = join(directory, `${base}.${index + 1}`);
      if (existing.has(`${base}.${index}`)) renameSync(from, to);
    }
    renameSync(config.file, join(directory, `${base}.1`));
    // Drop everything beyond the retained window; the basename is escaped so only
    // genuine rotation siblings can match.
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const entry of readdirSync(directory)) {
      const match = entry.match(new RegExp(`^${escapedBase}\\.(\\d+)$`));
      if (match && Number.parseInt(match[1] ?? "0", 10) > rotation.maxFiles) rmSync(join(directory, entry));
    }
  }

  return {
    log,
    debug: (event: string, fields?: Record<string, unknown>) => log({ level: "debug", event, ...fields }),
    info: (event: string, fields?: Record<string, unknown>) => log({ level: "info", event, ...fields }),
    warn: (event: string, fields?: Record<string, unknown>) => log({ level: "warn", event, ...fields }),
    error: (event: string, fields?: Record<string, unknown>) => log({ level: "error", event, ...fields }),
  };
}

export type Logger = ReturnType<typeof createLogger>;

/** Replaces home-path prefixes with `<home>` while leaving stable identifiers intact. */
export function redactPaths(value: unknown, homePath?: string): unknown {
  if (homePath === undefined) return value;
  const replace = (text: string): string => text.split(homePath).join("<home>");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return replace(node);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) result[key] = walk(entry);
      return result;
    }
    return node;
  };
  return walk(value);
}

/**
 * The token guard: walks the record and replaces every string that carries the secret
 * or a fragment of at least SECRET_FRAGMENT_LENGTH characters, so no recoverable token
 * material lands in a log file.
 */
export function scrubSecrets(value: unknown, secrets?: string[]): unknown {
  const guarded = (secrets ?? []).filter((secret) => secret.length >= SECRET_FRAGMENT_LENGTH);
  if (guarded.length === 0) return value;
  const scrubText = (text: string): string => {
    let result = text;
    for (const secret of guarded) result = result.split(secret).join("[redacted]");
    for (const secret of guarded) {
      for (let start = 0; start + SECRET_FRAGMENT_LENGTH <= secret.length; start++) {
        const fragment = secret.slice(start, start + SECRET_FRAGMENT_LENGTH);
        if (result.includes(fragment)) return "[redacted]";
      }
    }
    return result;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return scrubText(node);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) result[key] = walk(entry);
      return result;
    }
    return node;
  };
  return walk(value);
}
