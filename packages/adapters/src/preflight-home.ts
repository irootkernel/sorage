import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppError, appError, type PreflightFacts, type PreflightResidueEntry } from "@sorage/core";
import { loadConfiguration } from "./config-codec";
import { type CachedPreflightConfig, classifyAndLoadConfig } from "./preflight-classify";
import {
  bindingPath,
  contained,
  directoryRecord,
  fileShape,
  LOG_FILE_NAME,
  markerFile,
  pathLook,
  pathTarget,
  type PreflightLiveness,
  probePid,
  refuse,
  ROOT_INSTALL_NAMES,
  rootBinding,
  stableDirectory,
  streamSha256RegularFile,
} from "./preflight-fs";

export type HomeLocation =
  | { kind: "absent" | "unreadable" | "broken-link" | "non-directory" }
  | { kind: "directory"; canonical: string };

export type HomeListing =
  | { kind: "empty" | "unexplained" }
  | { kind: "partial"; hasConfig: boolean; hasDatabase: boolean; configMissing: boolean; databaseMissing: boolean }
  | { kind: "residue"; entries: PreflightResidueEntry[] }
  | { kind: "unsafe"; home: "installed"; partialAlias?: boolean }
  | InstalledHome;

export interface InstalledHome {
  kind: "installed";
  /** The path the caller selected, which may be a directory alias. */
  requested: string;
  canonical: string;
  /** Canonical path and directory identity captured with the initial home observation. */
  homeBinding: string;
  /** Configuration bytes captured before scratch selection. Absent when that read failed. */
  observedConfig?: string;
  /** Canonical Vault path and directory identity, or `absent` when that directory is affirmatively missing. */
  observedVault?: string;
  /** Expanded Vault path from the observed configuration. */
  vaultPath?: string;
  /** Request-scoped parsed configuration cache keyed by raw observed text (ADR-0036). */
  cachedConfig?: CachedPreflightConfig;
  databasePath: string;
  liveness: (pid: number) => PreflightLiveness;
  linkMoved: boolean;
}

export function unstableHome(): ReturnType<typeof refuse> {
  return refuse({
    home: { kind: "unreadable" },
    snapshot: { kind: "unavailable" },
    config: { kind: "unverified" },
    database: { kind: "unverified" },
    integrity: { kind: "unverified" },
    vault: { kind: "unverified" },
    identity: { kind: "unverified" },
  });
}

export function locateHome(homePath: string): HomeLocation {
  const look = pathLook(homePath);
  if (look.kind === "missing") return { kind: "absent" };
  if (look.kind === "failed") return { kind: "unreadable" };
  const stat = look.stat;
  if (stat.isSymbolicLink()) {
    const canonical = pathTarget(homePath);
    if (canonical.kind === "missing") return { kind: "broken-link" };
    if (canonical.kind === "failed") return { kind: "unreadable" };
    const target = pathLook(canonical.path);
    if (target.kind !== "stat") return { kind: "unreadable" };
    if (!target.stat.isDirectory()) return { kind: "non-directory" };
    return { kind: "directory", canonical: canonical.path };
  }
  if (!stat.isDirectory()) return { kind: "non-directory" };
  try {
    readdirSync(homePath);
  } catch {
    return { kind: "unreadable" };
  }
  const canonical = pathTarget(homePath);
  if (canonical.kind !== "path") return { kind: "unreadable" };
  return { kind: "directory", canonical: canonical.path };
}

export function listHome(canonical: string): HomeListing {
  let names: string[];
  try {
    names = readdirSync(canonical);
  } catch {
    return { kind: "unsafe", home: "installed" };
  }
  if (names.length === 0) return { kind: "empty" };
  const entries: PreflightResidueEntry[] = [];
  let extra = false;
  let vaultAlias = false;
  for (const name of names) {
    const path = join(canonical, name);
    const entry = pathLook(path);
    if (entry.kind !== "stat") return { kind: "unsafe", home: "installed" };
    const stat = entry.stat;
    if (stat.isSymbolicLink()) {
      const target = pathTarget(path);
      if (target.kind !== "path") return { kind: "unsafe", home: "installed" };
      if (name === "vault") vaultAlias = true;
      else return { kind: "unsafe", home: "installed" };
    } else {
      if (!ROOT_INSTALL_NAMES.has(name)) extra = true;
      if ((name === "logs" || name === "state" || name === "run") && !stat.isDirectory()) extra = true;
      if (name === "config.yaml" && !stat.isFile()) extra = true;
      if (name === "vault") extra = true;
    }
    if (name === "state" && stat.isDirectory() && !stat.isSymbolicLink()) {
      const database = pathLook(join(canonical, "state", "sorage.sqlite3"));
      if (database.kind === "failed") return { kind: "unsafe", home: "installed" };
    }
    if ((name === "logs" || name === "state" || name === "run") && stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push({ kind: "directory", name });
      let children: string[] = [];
      try {
        children = readdirSync(path);
      } catch {
        return { kind: "unsafe", home: "installed" };
      }
      for (const child of children) {
        const childPath = join(path, child);
        const childLook = pathLook(childPath);
        if (childLook.kind !== "stat") return { kind: "unsafe", home: "installed" };
        const childStat = childLook.stat;
        if (childStat.isSymbolicLink()) {
          const target = pathTarget(childPath);
          if (target.kind !== "path" || !contained(canonical, target.path)) {
            return { kind: "unsafe", home: "installed" };
          }
        }
        if (name === "logs" && childStat.isFile() && !childStat.isSymbolicLink()) {
          entries.push({ kind: "logs-file", name: child });
        } else {
          entries.push({ kind: "unqualified", scope: name, name: child });
        }
      }
    }
  }
  const databasePath = join(canonical, "state", "sorage.sqlite3");
  const configPath = join(canonical, "config.yaml");
  const configLook = pathLook(configPath);
  const databaseLook = pathLook(databasePath);
  if (configLook.kind === "failed" || databaseLook.kind === "failed") return { kind: "unsafe", home: "installed" };
  const configStat = configLook.kind === "stat" ? configLook.stat : undefined;
  const databaseStat = databaseLook.kind === "stat" ? databaseLook.stat : undefined;
  if (configStat?.isSymbolicLink() || databaseStat?.isSymbolicLink()) return { kind: "unsafe", home: "installed" };
  const hasConfig = configStat?.isFile() === true;
  const hasDatabase = databaseStat?.isFile() === true;
  if (vaultAlias && (!hasConfig || !hasDatabase)) return { kind: "unsafe", home: "installed", partialAlias: true };
  if (!hasConfig && !hasDatabase && !extra && permitted(entries)) return { kind: "residue", entries };
  if (!hasConfig && !hasDatabase) return { kind: "unexplained" };
  if (!hasConfig || !hasDatabase)
    return {
      kind: "partial",
      hasConfig,
      hasDatabase,
      configMissing: configLook.kind === "missing",
      databaseMissing: databaseLook.kind === "missing",
    };
  return {
    kind: "installed",
    requested: canonical,
    canonical,
    homeBinding: "",
    databasePath,
    liveness: (pid) => probePid(pid, process.kill.bind(process)),
    linkMoved: false,
  };
}

/** Keep preflight's conservative partial-alias projection, retaining conclusive recovery causes. */
export function partialAliasRefusal(home: string, userHome: string): AppError | undefined {
  const before = rootBinding(home);
  const alias = rootBinding(join(home, "vault"));
  if (before === undefined || alias === undefined || !stableDirectory(bindingPath(alias) ?? "")) return undefined;
  const configPath = join(home, "config.yaml");
  if (pathLook(configPath).kind === "missing") {
    if (
      before === rootBinding(home) &&
      alias === rootBinding(join(home, "vault")) &&
      pathLook(configPath).kind === "missing"
    )
      return appError("NOT_INITIALIZED", "the selected Installation has no configuration");
    return undefined;
  }
  if (pathLook(join(home, "state", "sorage.sqlite3")).kind !== "missing") return undefined;
  try {
    const bytes = readFileSync(configPath, "utf8");
    const loaded = loadConfiguration(bytes, { userHome, sorageHome: home });
    if (!loaded.ok || rootBinding(loaded.value.config.vault.path) !== alias) return undefined;
    if (
      bytes !== readFileSync(configPath, "utf8") ||
      before !== rootBinding(home) ||
      alias !== rootBinding(join(home, "vault")) ||
      pathLook(join(home, "state", "sorage.sqlite3")).kind !== "missing"
    )
      return undefined;
    return appError("STORAGE_INTEGRITY_ERROR", "the selected Installation has no database");
  } catch {
    return undefined;
  }
}

function permitted(entries: PreflightResidueEntry[]): boolean {
  const seen = { logs: 0, state: 0, run: 0 };
  let logFiles = 0;
  for (const entry of entries) {
    if (entry.kind === "unqualified") return false;
    if (entry.kind === "logs-file") {
      if (!LOG_FILE_NAME.test(entry.name)) return false;
      logFiles += 1;
      continue;
    }
    seen[entry.name] += 1;
  }
  const present = seen.logs + seen.state + seen.run;
  if (present === 0 || seen.logs > 1 || seen.state > 1 || seen.run > 1) return false;
  return logFiles === 0 || seen.logs === 1;
}

export function shallowFacts(listing: Exclude<HomeListing, InstalledHome | { kind: "unsafe" }>): PreflightFacts {
  const dormant = {
    snapshot: { kind: "not-applicable" } as const,
    config: { kind: "not-applicable" } as const,
    database: { kind: "not-applicable" } as const,
    integrity: { kind: "not-applicable" } as const,
    vault: { kind: "not-applicable" } as const,
    identity: { kind: "not-applicable" } as const,
  };
  if (listing.kind === "residue") return { home: { kind: "residue", entries: listing.entries }, ...dormant };
  return { home: { kind: listing.kind }, ...dormant };
}

export function closedFacts(kind: "absent" | "unreadable" | "broken-link" | "non-directory"): PreflightFacts {
  const downstream = kind === "absent" ? "not-applicable" : "unverified";
  return {
    home: { kind },
    snapshot: { kind: kind === "absent" ? "not-applicable" : "unavailable" },
    config: { kind: downstream },
    database: { kind: downstream },
    integrity: { kind: downstream },
    vault: { kind: downstream },
    identity: { kind: downstream },
  };
}

export function uncertain(home: "installed"): ReturnType<typeof refuse> {
  return refuse({
    home: { kind: home },
    snapshot: { kind: "unavailable" },
    config: { kind: "unverified" },
    database: { kind: "unverified" },
    integrity: { kind: "unverified" },
    vault: { kind: "unverified" },
    identity: { kind: "unverified" },
  });
}

export function managedShape(listing: InstalledHome): string | undefined {
  const home = listing.canonical;
  const rows: string[] = [];
  const homeRecord = directoryRecord(home, home);
  if (homeRecord === undefined || homeRecord === "missing") return undefined;
  rows.push(`home ${homeRecord}`);
  for (const name of ["logs", "state", "run"]) {
    const record = directoryRecord(join(home, name), home);
    if (record === undefined) return undefined;
    rows.push(`${name} ${record}`);
  }
  const files: Array<[string, string, boolean]> = [
    ["config", join(home, "config.yaml"), true],
    ["database", listing.databasePath, true],
    ["wal", `${listing.databasePath}-wal`, false],
    ["shm", `${listing.databasePath}-shm`, false],
    ["vault-move", join(home, "run", "vault-move.lock"), false],
    ["migration", join(home, "run", "migration.lock"), false],
  ];
  for (const [label, path, required] of files) {
    const record = fileShape(path, home, required);
    if (record === undefined) return undefined;
    rows.push(`${label} ${record}`);
  }
  const alias = configuredVaultAlias(listing);
  if (alias === undefined) return undefined;
  rows.push(`vault-alias ${alias}`);
  if (listing.observedVault === "absent") {
    if (listing.vaultPath === undefined || pathLook(listing.vaultPath).kind !== "missing") return undefined;
    rows.push("vault absent");
  } else if (listing.observedVault !== undefined) {
    const vaultPath = bindingPath(listing.observedVault);
    if (vaultPath === undefined || vaultPath === "" || rootBinding(vaultPath) !== listing.observedVault) {
      return undefined;
    }
    const vault = directoryRecord(vaultPath, vaultPath);
    if (vault === undefined || vault === "missing") return undefined;
    rows.push(`vault ${vault}`);
    const markerPath = join(listing.vaultPath ?? vaultPath, ".sorage-vault.json");
    const markerLook = pathLook(markerPath);
    if (markerLook.kind === "failed") return undefined;
    if (markerLook.kind === "missing") rows.push("marker absent");
    else {
      const marker = markerFile(markerPath, vaultPath);
      if (marker === undefined) return undefined;
      rows.push(`marker ${marker}`);
    }
  }
  return rows.join("\n");
}

export function configuredVaultAlias(listing: InstalledHome): string | undefined {
  const homeVault = join(listing.canonical, "vault");
  const look = pathLook(homeVault);
  if (look.kind === "missing") return "missing";
  if (look.kind !== "stat") return undefined;
  if (!look.stat.isSymbolicLink()) return "direct";
  const binding = rootBinding(homeVault);
  if (binding === undefined) return undefined;
  const target = bindingPath(binding);
  if (target === undefined) return undefined;
  if (contained(listing.canonical, target)) return `inside ${binding}`;
  if (binding !== listing.observedVault) return undefined;
  return `alias ${binding}`;
}

export function fingerprint(listing: InstalledHome): string | undefined {
  const files = [
    join(listing.canonical, "config.yaml"),
    listing.databasePath,
    `${listing.databasePath}-wal`,
    `${listing.databasePath}-shm`,
    join(listing.canonical, "run", "vault-move.lock"),
    join(listing.canonical, "run", "migration.lock"),
  ];
  if (listing.vaultPath !== undefined) files.push(join(listing.vaultPath, ".sorage-vault.json"));
  const rows: string[] = [];
  for (const path of files) {
    const look = pathLook(path);
    if (look.kind === "failed") return undefined;
    if (look.kind === "missing") {
      rows.push(`${path}:missing`);
      continue;
    }
    const stat = look.stat;
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    let hash: string;
    try {
      hash = streamSha256RegularFile(path, stat);
    } catch {
      return undefined;
    }
    rows.push(`${path}:${stat.ino}:${stat.mode}:${stat.mtimeMs}:${hash}`);
  }
  return rows.join("\n");
}

export function observationHolds(listing: InstalledHome, userHome: string): boolean {
  if (rootBinding(listing.requested) !== listing.homeBinding) return false;
  let text: string | undefined;
  try {
    text = readFileSync(join(listing.canonical, "config.yaml"), "utf8");
  } catch {
    text = undefined;
  }
  if (text !== listing.observedConfig) return false;
  if (listing.observedVault === undefined) return true;
  if (text === undefined || listing.vaultPath === undefined) return false;
  const loaded = classifyAndLoadConfig(text, userHome, listing.canonical, listing);
  if (loaded.fact.kind !== "supported" || loaded.config?.vault.path !== listing.vaultPath) return false;
  if (listing.observedVault === "absent") return pathLook(listing.vaultPath).kind === "missing";
  return rootBinding(listing.vaultPath) === listing.observedVault;
}
