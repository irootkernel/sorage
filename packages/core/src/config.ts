import { parseDocument } from "yaml";
import type { Document } from "yaml";
import { appError, err, ok, type AppError, type Result } from "./errors";

/**
 * The configuration model (CFG-001 to CFG-009, CFG-018, CFG-020): the typed mirror of
 * `docs/schemas/config.schema.json`, hand-validated because the fixed dependency set
 * of ADR-0016 deliberately contains no JSON Schema runtime. A parity test walks the
 * schema file and asserts that every leaf except `installationId` declares the same
 * fixed default this module returns.
 *
 * One shape serves two views: the file view keeps `vault.path` exactly as written,
 * including a leading `~`, because CFG-018 makes every Sorage-mediated write
 * comment- and byte-stable; the runtime view returned by `loadConfiguration` and
 * `expandConfiguration` carries the expanded, normalized absolute path (CFG-009).
 */
export interface Configuration {
  schemaVersion: 1;
  configRevision: number;
  installationId: string;
  vault: {
    path: string;
    importMode: "copy";
  };
  server: {
    host: "127.0.0.1" | "::1";
    port: number;
    autoStart: boolean;
    openBrowserOnStart: boolean;
  };
  handoff: {
    allowUnregisteredSenders: boolean;
    requireRegisteredRecipient: true;
    inboxMarker: boolean;
  };
  artifact: {
    maxBytes: number;
    externalSourcePolicy: "workspace_only" | "workspace_or_explicit";
    verifyChecksumOnFetch: boolean;
  };
  gitBackup: {
    enabled: boolean;
    schedule: {
      type: "daily";
      at: string;
      timezone: string;
      catchUpAfterMissedRun: boolean;
    };
    commit: {
      messageTemplate: string;
    };
    push: {
      enabled: boolean;
      remote: string;
      branch: string;
    };
    largeArtifactWarningBytes: number;
    snapshot: {
      redactWorkspacePaths: boolean;
    };
  };
  ui: {
    defaultPageSize: number;
    showArchivedByDefault: boolean;
    timezone: string | null;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    includeFullPaths: boolean;
    rotation: {
      maxBytes: number;
      maxFiles: number;
    };
  };
  gc: {
    graceHours: number;
  };
}

/** The fixed defaults of every leaf except the generated `installationId` (CFG-020). */
export const CONFIGURATION_DEFAULTS = {
  schemaVersion: 1,
  configRevision: 1,
  vault: {
    path: "~/.sorage/vault",
    importMode: "copy",
  },
  server: {
    host: "127.0.0.1",
    port: 46321,
    autoStart: false,
    openBrowserOnStart: false,
  },
  handoff: {
    allowUnregisteredSenders: true,
    requireRegisteredRecipient: true,
    inboxMarker: false,
  },
  artifact: {
    maxBytes: 104_857_600,
    externalSourcePolicy: "workspace_or_explicit",
    verifyChecksumOnFetch: false,
  },
  gitBackup: {
    enabled: false,
    schedule: {
      type: "daily",
      at: "03:00",
      timezone: "UTC",
      catchUpAfterMissedRun: true,
    },
    commit: {
      messageTemplate: "sorage backup: {timestamp}",
    },
    push: {
      enabled: false,
      remote: "origin",
      branch: "main",
    },
    largeArtifactWarningBytes: 26_214_400,
    snapshot: {
      redactWorkspacePaths: true,
    },
  },
  ui: {
    defaultPageSize: 50,
    showArchivedByDefault: false,
    timezone: null,
  },
  logging: {
    level: "warn",
    includeFullPaths: false,
    rotation: {
      maxBytes: 10_485_760,
      maxFiles: 5,
    },
  },
  gc: {
    graceHours: 24,
  },
} as const;

/** A fresh configuration: exactly the declared defaults plus the generated identity. */
export function defaultConfiguration(installationId: string): Configuration {
  return structuredClone({ ...CONFIGURATION_DEFAULTS, installationId }) as Configuration;
}

/** Expands a leading `~` against the supplied user home and normalizes the result. */
export function expandConfigurationPath(value: string, userHome: string): string {
  if (value === "~") return userHome;
  if (value.startsWith("~/")) return normalizeJoined(userHome, value.slice(2));
  return normalizeJoined(value, undefined);
}

function normalizeJoined(head: string, tail: string | undefined): string {
  const raw = tail === undefined ? head : `${head.replace(/\/+$/, "")}/${tail}`;
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!raw.startsWith("/")) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  return raw.startsWith("/") ? `/${joined}` : joined;
}

/** The parsed YAML document travels with the value so writes can preserve comments. */
export interface LoadedConfiguration {
  /** The runtime view: validated, with `vault.path` expanded and normalized. */
  config: Configuration;
  /** The comment-preserving document the text was parsed into (CFG-018). */
  document: Document;
}

export interface LoadConfigurationPorts {
  userHome: string;
}

/** Loads one `config.yaml` body: parse, validate, expand, and keep the document. */
export function loadConfiguration(text: string, ports: LoadConfigurationPorts): Result<LoadedConfiguration, AppError> {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    return err(invalid([`yaml: ${document.errors.map((error) => error.message).join("; ")}`]));
  }
  const validated = validateConfiguration(document.toJS());
  if (!validated.ok) return validated;
  return ok({ config: expandConfiguration(validated.value, ports.userHome), document });
}

/** Serializes the comment-preserving document back to text (CFG-018). */
export function serializeConfiguration(loaded: LoadedConfiguration): string {
  return loaded.document.toString({ lineWidth: 0 });
}

/** Returns a copy whose `vault.path` is expanded and normalized (CFG-009). */
export function expandConfiguration(config: Configuration, userHome: string): Configuration {
  return { ...config, vault: { ...config.vault, path: expandConfigurationPath(config.vault.path, userHome) } };
}

/**
 * Applies a file-view configuration onto a parsed document in place, creating missing
 * entries in schema order while leaving existing comments and key order untouched;
 * the caller serializes the same document afterwards.
 */
export function applyConfigurationToDocument(document: Document, config: Configuration): void {
  setLeaf(document, ["schemaVersion"], config.schemaVersion);
  setLeaf(document, ["configRevision"], config.configRevision);
  setLeaf(document, ["installationId"], config.installationId);
  setLeaf(document, ["vault", "path"], config.vault.path);
  setLeaf(document, ["vault", "importMode"], config.vault.importMode);
  setLeaf(document, ["server", "host"], config.server.host);
  setLeaf(document, ["server", "port"], config.server.port);
  setLeaf(document, ["server", "autoStart"], config.server.autoStart);
  setLeaf(document, ["server", "openBrowserOnStart"], config.server.openBrowserOnStart);
  setLeaf(document, ["handoff", "allowUnregisteredSenders"], config.handoff.allowUnregisteredSenders);
  setLeaf(document, ["handoff", "requireRegisteredRecipient"], config.handoff.requireRegisteredRecipient);
  setLeaf(document, ["handoff", "inboxMarker"], config.handoff.inboxMarker);
  setLeaf(document, ["artifact", "maxBytes"], config.artifact.maxBytes);
  setLeaf(document, ["artifact", "externalSourcePolicy"], config.artifact.externalSourcePolicy);
  setLeaf(document, ["artifact", "verifyChecksumOnFetch"], config.artifact.verifyChecksumOnFetch);
  setLeaf(document, ["gitBackup", "enabled"], config.gitBackup.enabled);
  setLeaf(document, ["gitBackup", "schedule", "type"], config.gitBackup.schedule.type);
  setLeaf(document, ["gitBackup", "schedule", "at"], config.gitBackup.schedule.at);
  setLeaf(document, ["gitBackup", "schedule", "timezone"], config.gitBackup.schedule.timezone);
  setLeaf(
    document,
    ["gitBackup", "schedule", "catchUpAfterMissedRun"],
    config.gitBackup.schedule.catchUpAfterMissedRun,
  );
  setLeaf(document, ["gitBackup", "commit", "messageTemplate"], config.gitBackup.commit.messageTemplate);
  setLeaf(document, ["gitBackup", "push", "enabled"], config.gitBackup.push.enabled);
  setLeaf(document, ["gitBackup", "push", "remote"], config.gitBackup.push.remote);
  setLeaf(document, ["gitBackup", "push", "branch"], config.gitBackup.push.branch);
  setLeaf(document, ["gitBackup", "largeArtifactWarningBytes"], config.gitBackup.largeArtifactWarningBytes);
  setLeaf(document, ["gitBackup", "snapshot", "redactWorkspacePaths"], config.gitBackup.snapshot.redactWorkspacePaths);
  setLeaf(document, ["ui", "defaultPageSize"], config.ui.defaultPageSize);
  setLeaf(document, ["ui", "showArchivedByDefault"], config.ui.showArchivedByDefault);
  setLeaf(document, ["ui", "timezone"], config.ui.timezone);
  setLeaf(document, ["logging", "level"], config.logging.level);
  setLeaf(document, ["logging", "includeFullPaths"], config.logging.includeFullPaths);
  setLeaf(document, ["logging", "rotation", "maxBytes"], config.logging.rotation.maxBytes);
  setLeaf(document, ["logging", "rotation", "maxFiles"], config.logging.rotation.maxFiles);
  setLeaf(document, ["gc", "graceHours"], config.gc.graceHours);
}

function setLeaf(document: Document, path: string[], value: unknown): void {
  document.setIn(path, value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULE_AT_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "configRevision",
  "installationId",
  "vault",
  "server",
  "handoff",
  "artifact",
  "gitBackup",
  "ui",
  "logging",
  "gc",
];

class Issues {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

/**
 * Full schema and semantic validation of one parsed configuration (CFG-009). The
 * returned value is the file view; every failure is one `CONFIG_INVALID` error whose
 * details list each offending path.
 */
export function validateConfiguration(raw: unknown): Result<Configuration, AppError> {
  const issues = new Issues();
  const config = validateObject(raw, "", issues);
  if (issues.list.length > 0) return err(invalid(issues.list));
  return ok(config as Configuration);
}

function invalid(issues: string[]): AppError {
  return appError("CONFIG_INVALID", `the configuration is invalid: ${issues.join("; ")}`, { issues });
}

function validateObject(raw: unknown, path: string, issues: Issues): Configuration {
  const root = expectObject(raw, path, issues) ?? {};
  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.includes(key)) issues.add(key, "is not a known configuration key");
  }
  const config = {} as Configuration;
  config.schemaVersion = constNumber(root, "schemaVersion", 1, path, issues) as Configuration["schemaVersion"];
  config.configRevision = minNumber(root, "configRevision", 1, path, issues);
  const installationId = expectString(root, "installationId", path, issues);
  if (installationId !== undefined && !UUID_PATTERN.test(installationId)) {
    issues.add(joinKey(path, "installationId"), "must be a UUID generated by sorage init");
  }
  config.installationId = installationId ?? "";

  const vault = section(root, "vault", path, issues, ["path", "importMode"]);
  config.vault = {
    path: nonEmptyString(vault, "path", "vault", issues) ?? "",
    importMode: constString(vault, "importMode", "copy", "vault", issues) as Configuration["vault"]["importMode"],
  };

  const server = section(root, "server", path, issues, ["host", "port", "autoStart", "openBrowserOnStart"]);
  const host = expectString(server, "host", "server", issues);
  if (host !== undefined && host !== "127.0.0.1" && host !== "::1") {
    issues.add("server.host", "must be the loopback literal 127.0.0.1 or ::1, never a name such as localhost");
  }
  config.server = {
    host: (host ?? "127.0.0.1") as Configuration["server"]["host"],
    port: rangedNumber(server, "port", 1024, 65535, "server", issues),
    autoStart: expectBoolean(server, "autoStart", "server", issues),
    openBrowserOnStart: expectBoolean(server, "openBrowserOnStart", "server", issues),
  };

  const handoff = section(root, "handoff", path, issues, [
    "allowUnregisteredSenders",
    "requireRegisteredRecipient",
    "inboxMarker",
  ]);
  const requireRegisteredRecipient = expectBoolean(handoff, "requireRegisteredRecipient", "handoff", issues);
  if (requireRegisteredRecipient !== true) {
    issues.add("handoff.requireRegisteredRecipient", "is fixed to true by PRJ-012 and cannot be turned off");
  }
  config.handoff = {
    allowUnregisteredSenders: expectBoolean(handoff, "allowUnregisteredSenders", "handoff", issues),
    requireRegisteredRecipient: true,
    inboxMarker: expectBoolean(handoff, "inboxMarker", "handoff", issues),
  };

  const artifact = section(root, "artifact", path, issues, [
    "maxBytes",
    "externalSourcePolicy",
    "verifyChecksumOnFetch",
  ]);
  const externalSourcePolicy = expectString(artifact, "externalSourcePolicy", "artifact", issues);
  if (
    externalSourcePolicy !== undefined &&
    externalSourcePolicy !== "workspace_only" &&
    externalSourcePolicy !== "workspace_or_explicit"
  ) {
    issues.add("artifact.externalSourcePolicy", "must be workspace_only or workspace_or_explicit");
  }
  config.artifact = {
    maxBytes: minNumber(artifact, "maxBytes", 1, "artifact", issues),
    externalSourcePolicy: (externalSourcePolicy ??
      "workspace_or_explicit") as Configuration["artifact"]["externalSourcePolicy"],
    verifyChecksumOnFetch: expectBoolean(artifact, "verifyChecksumOnFetch", "artifact", issues),
  };

  const gitBackup = section(root, "gitBackup", path, issues, [
    "enabled",
    "schedule",
    "commit",
    "push",
    "largeArtifactWarningBytes",
    "snapshot",
  ]);
  const schedule = section(gitBackup, "schedule", "gitBackup", issues, [
    "type",
    "at",
    "timezone",
    "catchUpAfterMissedRun",
  ]);
  const at = expectString(schedule, "at", "gitBackup.schedule", issues);
  if (at !== undefined && !SCHEDULE_AT_PATTERN.test(at)) {
    issues.add("gitBackup.schedule.at", "must be a 24-hour HH:MM local time");
  }
  const scheduleTimezone = expectString(schedule, "timezone", "gitBackup.schedule", issues);
  if (scheduleTimezone !== undefined && !isValidTimezone(scheduleTimezone)) {
    issues.add("gitBackup.schedule.timezone", `is not a supported IANA timezone: ${scheduleTimezone}`);
  }
  const commit = section(gitBackup, "commit", "gitBackup", issues, ["messageTemplate"]);
  const push = section(gitBackup, "push", "gitBackup", issues, ["enabled", "remote", "branch"]);
  config.gitBackup = {
    enabled: expectBoolean(gitBackup, "enabled", "gitBackup", issues),
    schedule: {
      type: constString(
        schedule,
        "type",
        "daily",
        "gitBackup.schedule",
        issues,
      ) as Configuration["gitBackup"]["schedule"]["type"],
      at: at ?? "",
      timezone: scheduleTimezone ?? "UTC",
      catchUpAfterMissedRun: expectBoolean(schedule, "catchUpAfterMissedRun", "gitBackup.schedule", issues),
    },
    commit: {
      messageTemplate: nonEmptyString(commit, "messageTemplate", "gitBackup.commit", issues) ?? "",
    },
    push: {
      enabled: expectBoolean(push, "enabled", "gitBackup.push", issues),
      remote: nonEmptyString(push, "remote", "gitBackup.push", issues) ?? "",
      branch: nonEmptyString(push, "branch", "gitBackup.push", issues) ?? "",
    },
    largeArtifactWarningBytes: minNumber(gitBackup, "largeArtifactWarningBytes", 1, "gitBackup", issues),
    snapshot: {
      redactWorkspacePaths: expectBoolean(
        section(gitBackup, "snapshot", "gitBackup", issues, ["redactWorkspacePaths"]),
        "redactWorkspacePaths",
        "gitBackup.snapshot",
        issues,
      ),
    },
  };

  const ui = section(root, "ui", path, issues, ["defaultPageSize", "showArchivedByDefault", "timezone"]);
  const uiTimezone = expectNullableString(ui, "timezone", "ui", issues);
  if (typeof uiTimezone === "string" && !isValidTimezone(uiTimezone)) {
    issues.add("ui.timezone", `is not a supported IANA timezone: ${uiTimezone}`);
  }
  config.ui = {
    defaultPageSize: rangedNumber(ui, "defaultPageSize", 10, 200, "ui", issues),
    showArchivedByDefault: expectBoolean(ui, "showArchivedByDefault", "ui", issues),
    timezone: uiTimezone ?? null,
  };

  const logging = section(root, "logging", path, issues, ["level", "includeFullPaths", "rotation"]);
  const level = expectString(logging, "level", "logging", issues);
  if (level !== undefined && !["debug", "info", "warn", "error"].includes(level)) {
    issues.add("logging.level", "must be one of debug, info, warn, error");
  }
  const rotation = section(logging, "rotation", "logging", issues, ["maxBytes", "maxFiles"]);
  config.logging = {
    level: (level ?? "warn") as Configuration["logging"]["level"],
    includeFullPaths: expectBoolean(logging, "includeFullPaths", "logging", issues),
    rotation: {
      maxBytes: minNumber(rotation, "maxBytes", 1, "logging.rotation", issues),
      maxFiles: minNumber(rotation, "maxFiles", 1, "logging.rotation", issues),
    },
  };

  const gc = section(root, "gc", path, issues, ["graceHours"]);
  config.gc = {
    graceHours: minNumber(gc, "graceHours", 1, "gc", issues),
  };

  return config;
}

function expectObject(raw: unknown, path: string, issues: Issues): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.add(path || "the document", "must be a mapping");
    return null;
  }
  return raw as Record<string, unknown>;
}

function section(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  issues: Issues,
  allowedKeys: string[],
): Record<string, unknown> {
  const path = joinKey(parentPath, key);
  const raw = parent[key];
  if (raw === undefined) {
    issues.add(path, "is required");
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.add(path, "must be a mapping");
    return {};
  }
  const record = raw as Record<string, unknown>;
  for (const child of Object.keys(record)) {
    if (!allowedKeys.includes(child)) issues.add(joinKey(path, child), "is not a known configuration key");
  }
  return record;
}

function joinKey(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function expectString(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  issues: Issues,
): string | undefined {
  const value = parent[key];
  if (value === undefined) {
    issues.add(joinKey(parentPath, key), "is required");
    return undefined;
  }
  if (typeof value !== "string") {
    issues.add(joinKey(parentPath, key), "must be a string");
    return undefined;
  }
  return value;
}

function expectNullableString(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  issues: Issues,
): string | null | undefined {
  const value = parent[key];
  if (value === undefined) {
    issues.add(joinKey(parentPath, key), "is required");
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.add(joinKey(parentPath, key), "must be a string or null");
    return undefined;
  }
  return value;
}

function nonEmptyString(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  issues: Issues,
): string | undefined {
  const value = expectString(parent, key, parentPath, issues);
  if (value !== undefined && value.trim() === "") issues.add(joinKey(parentPath, key), "must not be blank");
  return value;
}

function constString(
  parent: Record<string, unknown>,
  key: string,
  expected: string,
  parentPath: string,
  issues: Issues,
): string {
  const value = expectString(parent, key, parentPath, issues);
  if (value !== undefined && value !== expected) {
    issues.add(joinKey(parentPath, key), `is fixed to ${expected}`);
  }
  return value === undefined ? expected : value;
}

function expectBoolean(parent: Record<string, unknown>, key: string, parentPath: string, issues: Issues): boolean {
  const value = parent[key];
  if (typeof value !== "boolean") {
    issues.add(joinKey(parentPath, key), "must be a boolean");
    return false;
  }
  return value;
}

function minNumber(
  parent: Record<string, unknown>,
  key: string,
  minimum: number,
  parentPath: string,
  issues: Issues,
): number {
  const value = expectNumber(parent, key, parentPath, issues);
  if (value !== undefined && value < minimum) issues.add(joinKey(parentPath, key), `must be at least ${minimum}`);
  return value ?? minimum;
}

function rangedNumber(
  parent: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  parentPath: string,
  issues: Issues,
): number {
  const value = expectNumber(parent, key, parentPath, issues);
  if (value !== undefined && (value < minimum || value > maximum)) {
    issues.add(joinKey(parentPath, key), `must be between ${minimum} and ${maximum}`);
  }
  return value ?? minimum;
}

function constNumber(
  parent: Record<string, unknown>,
  key: string,
  expected: number,
  parentPath: string,
  issues: Issues,
): number {
  const value = expectNumber(parent, key, parentPath, issues);
  if (value !== undefined && value !== expected) issues.add(joinKey(parentPath, key), `is fixed to ${expected}`);
  return value === undefined ? expected : value;
}

function expectNumber(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  issues: Issues,
): number | undefined {
  const value = parent[key];
  if (value === undefined) {
    issues.add(joinKey(parentPath, key), "is required");
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.add(joinKey(parentPath, key), "must be an integer");
    return undefined;
  }
  return value;
}

function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
