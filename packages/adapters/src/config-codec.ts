import {
  type AppError,
  appError,
  type ConfigTextCodec,
  type Configuration,
  type ConfigurationPathProbe,
  err,
  expandConfiguration,
  ok,
  type Result,
  validateConfiguration,
} from "@sorage/core";
import { Document, parseDocument } from "yaml";

interface ConfigurationPathStats {
  isFile(): boolean;
}

/**
 * Inspects the configuration path without opening it: `stat` follows symlinks,
 * so a live symlink to a regular file is a valid path, while a FIFO or other
 * non-regular target is a path fault and is never opened (a FIFO must not
 * block). On `ENOENT` an `lstat` distinguishes absence from a dangling entry.
 */
export function probeConfigurationPath(
  stat: () => ConfigurationPathStats,
  lstat: () => ConfigurationPathStats,
): ConfigurationPathProbe {
  let stats: ConfigurationPathStats;
  try {
    stats = stat();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ELOOP") return { kind: "symlink-loop" };
    if (code !== "ENOENT") return { kind: "access-failure" };
    try {
      lstat();
      return { kind: "dangling-symlink" };
    } catch (lstatError) {
      return (lstatError as NodeJS.ErrnoException | null)?.code === "ENOENT"
        ? { kind: "missing" }
        : { kind: "access-failure" };
    }
  }
  return stats.isFile() ? { kind: "regular-file" } : { kind: "not-regular" };
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
  /** The effective Sorage home; defaults to `<userHome>/.sorage`. */
  sorageHome?: string | undefined;
}

/** Loads one `config.yaml` body: parse, validate, expand, and keep the document. */
export function loadConfiguration(text: string, ports: LoadConfigurationPorts): Result<LoadedConfiguration, AppError> {
  const parsed = parseConfigurationFile(text);
  if (!parsed.ok) return parsed;
  return ok({
    config: expandConfiguration(parsed.value.config, ports.userHome, ports.sorageHome),
    document: parsed.value.document,
  });
}

/**
 * Loads the file view: parsed and fully validated with the literal on-disk values,
 * so a tilde path stays written as `~` instead of being replaced by its expansion.
 */
export function parseConfigurationFile(text: string): Result<{ config: Configuration; document: Document }, AppError> {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    const issues = [`yaml: ${document.errors.map((error) => error.message).join("; ")}`];
    return err(appError("CONFIG_INVALID", `the configuration is invalid: ${issues.join("; ")}`, { issues }));
  }
  const validated = validateConfiguration(document.toJS());
  if (!validated.ok) return validated;
  return ok({ config: validated.value, document });
}

/** Adapter implementation of core's semantic `ConfigTextCodec` port. */
export function createYamlConfigTextCodec(): ConfigTextCodec {
  return {
    parse(text: string): Result<Configuration, AppError> {
      const parsed = parseConfigurationFile(text);
      if (!parsed.ok) return parsed;
      return ok(parsed.value.config);
    },
  };
}

/** Serializes the comment-preserving document back to text (CFG-018). */
export function serializeConfiguration(loaded: LoadedConfiguration): string {
  return loaded.document.toString({ lineWidth: 0 });
}

/** A fresh empty document for writing a configuration where no file exists yet. */
export function emptyConfigurationDocument(): Document {
  return new Document({});
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
