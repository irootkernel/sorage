import { Database } from "bun:sqlite";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppError, appError, type PreflightConfigFact, type PreflightVaultFact } from "@sorage/core";
import { parseConfigurationFile } from "./config-codec";
import {
  blankCapture,
  type CaptureFacts,
  classifyAndLoadConfig,
  classifyDatabase,
  classifyIdentity,
  classifyVault,
  databaseMoveFence,
  hasMoveFenceColumn,
  markerInstallationId,
  readFences,
  readIntegrity,
} from "./preflight-classify";
import {
  bindingPath,
  conclusivePrivateCorruption,
  contained,
  databaseFormat,
  markerFile,
  pathLook,
  type PreflightLiveness,
  type PrivateDatabase,
  rootBinding,
  stableDirectory,
  unavailable,
} from "./preflight-fs";
import type { InstalledHome } from "./preflight-home";

export interface StagedCopy {
  configPath: string;
  config: PreflightConfigFact;
  markerPath?: string;
  vaultAbsent: boolean;
  databasePath: string;
  staleFence: boolean;
  blocked: boolean;
  liveFence?: boolean;
}

export function openPrivateCopy(path: string): PrivateDatabase {
  return new Database(path) as unknown as PrivateDatabase;
}

export function stageCopies(
  listing: InstalledHome,
  copyRoot: string,
  copyFile: (from: string, to: string) => void,
  readFile: (path: string) => Buffer,
  userHome: string,
): StagedCopy | undefined {
  const fences = readFences(listing);
  if (fences.blocked)
    return {
      configPath: "",
      config: { kind: "unverified" },
      vaultAbsent: false,
      databasePath: "",
      staleFence: false,
      blocked: true,
      liveFence: fences.live === true,
    };
  const configPath = join(listing.canonical, "config.yaml");
  const configText = readFile(configPath).toString("utf8");
  if (listing.observedConfig !== undefined && configText !== listing.observedConfig) {
    listing.linkMoved = true;
    return undefined;
  }
  const classified = classifyAndLoadConfig(configText, userHome, listing.canonical, listing);
  const config = classified.fact;
  if (config.kind !== "supported") {
    return {
      configPath: "",
      config,
      vaultAbsent: false,
      databasePath: "",
      staleFence: fences.stale,
      blocked: false,
    };
  }
  if (classified.config === undefined)
    return {
      configPath: "",
      config: { kind: "invalid" },
      vaultAbsent: false,
      databasePath: "",
      staleFence: fences.stale,
      blocked: false,
    };
  const vaultDir = classified.config.vault.path;
  const vaultRootBefore = rootBinding(vaultDir);
  if (listing.observedVault === "absent") {
    if (pathLook(vaultDir).kind !== "missing") {
      listing.linkMoved = true;
      return undefined;
    }
  } else if (listing.observedVault !== undefined && vaultRootBefore !== listing.observedVault) {
    listing.linkMoved = true;
    return undefined;
  }
  const privateConfig = join(copyRoot, "config.yaml");
  copyFile(configPath, privateConfig);
  const databasePath = join(copyRoot, "sorage.sqlite3");
  copyFile(listing.databasePath, databasePath);
  // The copy preserves a write-protected source's mode, and the private
  // open below needs to write the copy for WAL recovery — so the owned
  // copy is made owner-writable while the live installation stays untouched
  // (the same rule as the history inspection's capture).
  chmodSync(databasePath, 0o600);
  const wal = `${listing.databasePath}-wal`;
  const walLook = pathLook(wal);
  if (walLook.kind === "failed") return undefined;
  if (walLook.kind === "stat" && walLook.stat.isFile() && !walLook.stat.isSymbolicLink()) {
    copyFile(wal, `${databasePath}-wal`);
    chmodSync(`${databasePath}-wal`, 0o600);
  }
  let markerPath: string | undefined;
  let vaultAbsent = listing.observedVault === "absent";
  if (!vaultAbsent) {
    const vaultCanonical = vaultRootBefore === undefined ? undefined : bindingPath(vaultRootBefore);
    if (vaultCanonical === undefined || (!contained(listing.canonical, vaultDir) && !stableDirectory(vaultDir))) {
      return undefined;
    }
    const sourceMarker = join(vaultDir, ".sorage-vault.json");
    const markerLook = pathLook(sourceMarker);
    if (markerLook.kind === "failed") return undefined;
    if (markerLook.kind === "missing") {
      vaultAbsent = true;
    } else {
      const markerBefore = markerFile(sourceMarker, vaultCanonical);
      if (markerBefore === undefined) return undefined;
      const markerBytes = readFile(sourceMarker);
      markerPath = join(copyRoot, ".sorage-vault.json");
      copyFile(sourceMarker, markerPath);
      const markerAfter = markerFile(sourceMarker, vaultCanonical);
      if (markerAfter === undefined || markerAfter !== markerBefore || !readFile(sourceMarker).equals(markerBytes)) {
        listing.linkMoved = true;
        return undefined;
      }
    }
  }
  const fencesAfter = readFences(listing);
  if (fencesAfter.blocked || fencesAfter.stamp !== fences.stamp) return undefined;
  if (listing.observedVault === "absent") {
    if (pathLook(vaultDir).kind !== "missing") {
      listing.linkMoved = true;
      return undefined;
    }
  } else if (listing.observedVault !== undefined) {
    const vaultRootAfter = rootBinding(vaultDir);
    if (vaultRootBefore === undefined || vaultRootAfter === undefined || vaultRootAfter !== listing.observedVault) {
      listing.linkMoved = true;
      return undefined;
    }
  }
  return {
    configPath: privateConfig,
    config,
    ...(markerPath === undefined ? {} : { markerPath }),
    vaultAbsent,
    databasePath,
    staleFence: fences.stale || fencesAfter.stale,
    blocked: false,
  };
}

export function observeCopy(
  staged: StagedCopy,
  openPrivate: (path: string) => PrivateDatabase,
  liveness: (pid: number) => PreflightLiveness,
): { facts: CaptureFacts; db?: PrivateDatabase; migrationVersion?: number } | { error: AppError } | undefined {
  if (staged.blocked)
    return {
      error: staged.liveFence ? appError("SERVICE_PAUSED", "a live inspection fence blocks recovery") : unavailable(),
    };
  if (staged.config.kind !== "supported") {
    return {
      facts: {
        config: staged.config,
        database: { kind: "unverified" },
        integrity: { kind: "unverified" },
        vault: { kind: "unverified" },
        identity: { kind: "unverified" },
        staleFence: staged.staleFence,
      },
    };
  }
  let configText: string;
  try {
    configText = readFileSync(staged.configPath, "utf8");
  } catch {
    return undefined;
  }
  const config = parseConfigurationFile(configText);
  if (!config.ok) return { facts: blankCapture({ kind: "invalid" }, staged.staleFence) };
  let vaultText = "";
  let vault: PreflightVaultFact;
  if (staged.vaultAbsent) {
    vault = { kind: "absent" };
  } else if (staged.markerPath === undefined) {
    return undefined;
  } else {
    try {
      vaultText = readFileSync(staged.markerPath, "utf8");
    } catch {
      return undefined;
    }
    vault = classifyVault(vaultText);
  }
  const format = databaseFormat(staged.databasePath);
  if (format !== "sqlite") {
    return {
      facts: {
        config: { kind: "supported" },
        database: { kind: format },
        integrity: { kind: "unverified" },
        vault,
        identity: classifyIdentity(
          config.value.config.installationId,
          markerInstallationId(vaultText, vault),
          vault,
          format,
          undefined,
        ),
        staleFence: staged.staleFence,
      },
    };
  }
  let db: PrivateDatabase | undefined;
  let retained = false;
  try {
    db = openPrivate(staged.databasePath);
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const integrity = readIntegrity(db);
    const database = classifyDatabase(db);
    const identity = classifyIdentity(
      config.value.config.installationId,
      markerInstallationId(vaultText, vault),
      vault,
      database.kind,
      db,
    );
    const moveFence =
      (database.kind === "current-ordered" || database.kind === "known-older-ordered") && hasMoveFenceColumn(db)
        ? databaseMoveFence(db, liveness)
        : "clear";
    if (moveFence === "alive" || moveFence === "uncertain")
      return {
        error:
          moveFence === "alive"
            ? appError("SERVICE_PAUSED", "a live database move fence blocks recovery")
            : unavailable(),
      };
    db.exec("PRAGMA query_only = ON");
    const migrationVersion =
      database.kind === "current-ordered" || database.kind === "known-older-ordered"
        ? (
            db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as {
              version: number;
            }
          ).version
        : undefined;
    const observation: { facts: CaptureFacts; db: PrivateDatabase; migrationVersion?: number } = {
      facts: {
        config: { kind: "supported" },
        database,
        integrity,
        vault,
        identity,
        staleFence: staged.staleFence || moveFence === "stale",
        markerMismatch:
          vault.kind === "supported" && markerInstallationId(vaultText, vault) !== config.value.config.installationId,
      },
      db,
      ...(migrationVersion === undefined ? {} : { migrationVersion }),
    };
    retained = true;
    return observation;
  } catch (error) {
    if (!conclusivePrivateCorruption(error)) return undefined;
    return {
      facts: {
        config: { kind: "supported" },
        database: { kind: "corrupt" },
        integrity: { kind: "unverified" },
        vault,
        identity: { kind: "unverified" },
        staleFence: staged.staleFence,
      },
    };
  } finally {
    if (!retained) db?.close();
  }
}
