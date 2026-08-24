import { CONFIGURATION_DEFAULTS } from "./config";
import { parseConfigurationFile, validateConfiguration, type Configuration } from "./config";
import { appError, err, ok, type AppError, type Result } from "./errors";

/**
 * The configuration commands as application use cases (INIT-011, INIT-012, CFG-013,
 * CFG-016, CFG-018, CLI-019): show and validate are read-only and need no User
 * context, set and edit are User-admin operations that fail with
 * USER_CONTEXT_REQUIRED without `--as-user`, and every write routes through the
 * shared atomic store so comments, key order, the revision counter, and the
 * last-known-good backup behave identically for the CLI and the later Web UI.
 */
export interface ConfigCommandStore {
  read(): Result<{ config: Configuration; etag: string; revision: number } | null, AppError>;
  readText(): string | null;
  write(
    config: Configuration,
    expect?: { revision?: number; etag?: string },
  ): Result<{ config: Configuration; etag: string }, AppError>;
  writeRaw(text: string): Result<{ etag: string }, AppError>;
}

export interface ConfigCommandPorts {
  store: ConfigCommandStore;
  configFile: string;
  userHome: string;
  sorageHome: string;
  /** Opens the user's editor on the file with argument-array execution (SEC-004). */
  openEditor(path: string): Result<void, AppError>;
}

function notInitialized(configFile: string): AppError {
  return appError("NOT_INITIALIZED", "Sorage has not been initialized.", { expectedConfigPath: configFile });
}

function userContextRequired(): AppError {
  return appError(
    "USER_CONTEXT_REQUIRED",
    "config set and config edit are User-admin operations; re-run with --as-user",
  );
}

/** `config show`: the file view exactly as declared, or NOT_INITIALIZED (CFG-020). */
export function showConfiguration(ports: ConfigCommandPorts): Result<Configuration, AppError> {
  const current = ports.store.read();
  if (!current.ok) return current;
  if (current.value === null) return err(notInitialized(ports.configFile));
  // The file view keeps the literal tilde path; expansion belongs to consumers.
  const text = ports.store.readText();
  if (text === null) return err(notInitialized(ports.configFile));
  const parsed = parseConfigurationFile(text);
  if (!parsed.ok) return parsed;
  return ok(parsed.value.config);
}

/** `config validate`: reports the file as valid or fails with CONFIG_INVALID. */
export function validateConfigurationFile(ports: ConfigCommandPorts): Result<{ path: string }, AppError> {
  const text = ports.store.readText();
  if (text === null) return err(notInitialized(ports.configFile));
  const parsed = parseConfigurationFile(text);
  if (!parsed.ok) return parsed;
  return ok({ path: ports.configFile });
}

export interface SetConfigurationInput {
  key: string;
  rawValue: string;
  asUser: boolean;
  expectedRevision?: number | undefined;
}

export interface ConfigurationChange {
  key: string;
  value: unknown;
  configRevision: number;
}

/** `config set <key> <value> --as-user`: one typed leaf change through the store. */
export function setConfigurationValue(
  ports: ConfigCommandPorts,
  input: SetConfigurationInput,
): Result<ConfigurationChange, AppError> {
  if (!input.asUser) return err(userContextRequired());
  const current = ports.store.read();
  if (!current.ok) return current;
  if (current.value === null) return err(notInitialized(ports.configFile));

  const protectedKeys: Record<string, string> = {
    "vault.path": "sorage vault move --to <path>",
    schemaVersion: "a configuration schema migration",
    configRevision: "Sorage itself through every mediated write",
    installationId: "sorage init, which generates it exactly once",
    "vault.importMode": "the import mode is fixed at copy in the MVP",
    "handoff.requireRegisteredRecipient": "PRJ-012 fixes it to true",
  };
  const guard = protectedKeys[input.key];
  if (guard !== undefined) {
    return err(
      appError("CONFIG_INVALID", `${input.key} cannot be changed by config set; it is owned by ${guard}`, {
        key: input.key,
      }),
    );
  }

  const parsed = parseLeafValue(input.key, input.rawValue);
  if (!parsed.ok) return parsed;
  // The write basis is the file view so an unrelated set never replaces the literal
  // tilde-form vault path with its expansion.
  const basisText = ports.store.readText();
  if (basisText === null) return err(notInitialized(ports.configFile));
  const basis = parseConfigurationFile(basisText);
  if (!basis.ok) return basis;
  const next = withLeaf(basis.value.config, input.key, parsed.value);
  if (!next.ok) return next;
  const written = ports.store.write(next.value, {
    ...(input.expectedRevision !== undefined ? { revision: input.expectedRevision } : {}),
  });
  if (!written.ok) return written;
  return ok({ key: input.key, value: parsed.value, configRevision: written.value.config.configRevision });
}

export interface EditConfigurationInput {
  asUser: boolean;
}

export interface EditOutcome {
  outcome: "changed" | "unchanged";
  configRevision: number;
}

/** `config edit --as-user`: the editor flow with conflict and failure safety (CFG-015). */
export function editConfiguration(
  ports: ConfigCommandPorts,
  input: EditConfigurationInput,
): Result<EditOutcome, AppError> {
  if (!input.asUser) return err(userContextRequired());
  const before = ports.store.read();
  if (!before.ok) return before;
  if (before.value === null) return err(notInitialized(ports.configFile));
  const beforeText = ports.store.readText();
  if (beforeText === null) return err(notInitialized(ports.configFile));

  const opened = ports.openEditor(ports.configFile);
  if (!opened.ok) return opened;

  const afterText = ports.store.readText();
  if (afterText === null || afterText === beforeText) {
    return ok({ outcome: "unchanged", configRevision: before.value.config.configRevision });
  }

  // Validate the edited bytes before anything is accepted; an invalid edit restores
  // the previous valid file so the installation never runs on broken configuration.
  const edited = parseConfigurationFile(afterText);
  if (!edited.ok) {
    const restored = ports.store.writeRaw(beforeText);
    if (!restored.ok) return restored;
    return edited;
  }
  // The revision fence alone guards concurrent mediated writes; the captured ETag
  // cannot be passed because the editor's own save legitimately changes it, while
  // the unchanged case was already decided by the byte comparison above.
  const written = ports.store.write(edited.value.config, {
    revision: before.value.config.configRevision,
  });
  if (!written.ok) return written;
  return ok({ outcome: "changed", configRevision: written.value.config.configRevision });
}

/** Parses one command-line scalar against the declared type of its leaf. */
export function parseLeafValue(key: string, rawValue: string): Result<unknown, AppError> {
  const current = readLeaf(CONFIGURATION_DEFAULTS, key.split("."));
  if (current === undefined) {
    return err(appError("CONFIG_INVALID", `${key} is not a known configuration key`, { key }));
  }
  if (typeof current === "number") {
    if (!/^-?\d+$/.test(rawValue.trim())) {
      return err(appError("CONFIG_INVALID", `${key} expects an integer, got '${rawValue}'`, { key }));
    }
    const parsed = Number.parseInt(rawValue.trim(), 10);
    if (!Number.isSafeInteger(parsed)) {
      return err(appError("CONFIG_INVALID", `${key} is out of the supported integer range`, { key }));
    }
    return ok(parsed);
  }
  if (typeof current === "boolean") {
    if (rawValue !== "true" && rawValue !== "false") {
      return err(appError("CONFIG_INVALID", `${key} expects true or false, got '${rawValue}'`, { key }));
    }
    return ok(rawValue === "true");
  }
  if (current === null) {
    if (rawValue === "null") return ok(null);
    return ok(rawValue);
  }
  return ok(rawValue);
}

/** Returns a copy of the configuration with one leaf replaced. */
export function withLeaf(config: Configuration, key: string, value: unknown): Result<Configuration, AppError> {
  const segments = key.split(".");
  const clone = structuredClone(config) as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null) {
      return err(appError("CONFIG_INVALID", `${key} is not a known configuration key`, { key }));
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined || !(leaf in cursor)) {
    return err(appError("CONFIG_INVALID", `${key} is not a known configuration key`, { key }));
  }
  cursor[leaf] = value;
  const validated = validateConfiguration(clone);
  if (!validated.ok) return validated;
  return ok(validated.value);
}

function readLeaf(value: unknown, segments: string[]): unknown {
  let cursor = value;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
