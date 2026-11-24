import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AppError, appError, type PreflightFacts } from "@sorage/core";
import { type CaptureFacts, classifyAndLoadConfig, recoveryRefusal } from "./preflight-classify";
import {
  type AcquiredInspection,
  bindingPath,
  CAPTURE_ATTEMPTS,
  pathLook,
  type PreflightInspectPorts,
  type PrivateDatabase,
  probePid,
  refuse,
  rootBinding,
  scratchParent,
} from "./preflight-fs";
import {
  closedFacts,
  configuredVaultAlias,
  fingerprint,
  type InstalledHome,
  listHome,
  locateHome,
  managedShape,
  observationHolds,
  partialAliasRefusal,
  shallowFacts,
  uncertain,
  unstableHome,
} from "./preflight-home";
import { observeCopy, openPrivateCopy, stageCopies } from "./preflight-staging";

export function acquireInspection(homePath: string, ports: PreflightInspectPorts): AcquiredInspection {
  const userHome = ports.userHome ?? homedir();
  const located = locateHome(homePath);
  if (located.kind === "absent") {
    ports.onObserved?.();
    const again = pathLook(homePath);
    if (again.kind === "stat") return unstableHome();
    if (again.kind === "missing")
      return refuse(
        closedFacts("absent"),
        appError("NOT_INITIALIZED", "the selected Installation has no configuration"),
      );
    return refuse(closedFacts("unreadable"));
  }
  if (located.kind !== "directory") return refuse(closedFacts(located.kind));
  const listing = listHome(located.canonical);
  if (listing.kind === "unsafe") {
    const refused = uncertain(listing.home);
    const error = listing.partialAlias ? partialAliasRefusal(located.canonical, userHome) : undefined;
    return error === undefined ? refused : { ...refused, error };
  }
  if (listing.kind !== "installed") {
    if (
      listing.kind === "partial" &&
      ((!listing.hasConfig && !listing.configMissing) || (!listing.hasDatabase && !listing.databaseMissing))
    )
      return refuse(shallowFacts(listing));
    const missingConfig = listing.kind !== "partial" || !listing.hasConfig;
    return refuse(
      shallowFacts(listing),
      appError(
        missingConfig ? "NOT_INITIALIZED" : "STORAGE_INTEGRITY_ERROR",
        missingConfig ? "the selected Installation has no configuration" : "the selected Installation has no database",
      ),
    );
  }
  listing.requested = homePath;
  const homeBinding = rootBinding(homePath);
  if (homeBinding === undefined || homeBinding !== rootBinding(listing.canonical)) return uncertain("installed");
  listing.homeBinding = homeBinding;
  const readFile = ports.readFile ?? ((path: string) => readFileSync(path));
  try {
    listing.observedConfig = readFile(join(listing.canonical, "config.yaml")).toString("utf8");
  } catch {
    return uncertain("installed");
  }
  const early = classifyAndLoadConfig(listing.observedConfig, userHome, listing.canonical, listing);
  const earlyConfig = early.fact;
  if (earlyConfig.kind !== "supported") {
    if (!observationHolds(listing, userHome)) return uncertain("installed");
    return refuse(
      {
        home: { kind: "installed" },
        snapshot: { kind: "unverified" },
        config: earlyConfig,
        database: { kind: "unverified" },
        integrity: { kind: "unverified" },
        vault: { kind: "unverified" },
        identity: { kind: "unverified" },
      },
      appError(
        earlyConfig.kind === "newer" || earlyConfig.kind === "unsupported-format"
          ? "STORAGE_SCHEMA_UNSUPPORTED"
          : "CONFIG_INVALID",
        "the selected configuration cannot support inspection",
      ),
    );
  }
  const observedConfig = early.config;
  if (observedConfig === undefined) return uncertain("installed");
  listing.vaultPath = observedConfig.vault.path;
  const vaultLook = pathLook(listing.vaultPath);
  if (vaultLook.kind === "failed") return uncertain("installed");
  if (vaultLook.kind === "missing") listing.observedVault = "absent";
  else {
    if (!vaultLook.stat.isSymbolicLink() && !vaultLook.stat.isDirectory()) return uncertain("installed");
    const vaultBinding = rootBinding(listing.vaultPath);
    if (vaultBinding === undefined) return uncertain("installed");
    listing.observedVault = vaultBinding;
  }
  if (!configuredVaultAlias(listing)) return uncertain("installed");
  const roots = [listing.canonical];
  const observedVaultPath = listing.observedVault === "absent" ? undefined : bindingPath(listing.observedVault);
  if (observedVaultPath !== undefined) roots.push(observedVaultPath);
  if (!observationHolds(listing, userHome)) return uncertain("installed");
  const parent = scratchParent(roots, ports.scratchParent);
  if (parent === undefined || !observationHolds(listing, userHome)) return uncertain("installed");
  let scratch: string;
  try {
    scratch = mkdtempSync(join(parent, "sorage-preflight-"));
  } catch {
    return uncertain("installed");
  }
  let captured: ReturnType<typeof capture> | undefined;
  const dispose = () => {
    try {
      if (captured?.ok) captured.db?.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  try {
    captured = capture(listing, ports, scratch, userHome);
    if (!captured.ok)
      return { ...uncertain("installed"), ...(captured.error === undefined ? {} : { error: captured.error }), dispose };
    const facts: PreflightFacts = {
      home: { kind: "installed" },
      snapshot: { kind: "coherent", staleFence: captured.facts.staleFence },
      config: captured.facts.config,
      database: captured.facts.database,
      integrity: captured.facts.integrity,
      vault: captured.facts.vault,
      identity: captured.facts.identity,
    };
    const error = recoveryRefusal(captured.facts);
    if (error !== undefined) return { ...refuse(facts, error), dispose };
    const db = captured.db;
    if (db === undefined || captured.migrationVersion === undefined) return { ...refuse(facts), dispose };
    return {
      kind: "ready",
      facts,
      config: observedConfig,
      migrationVersion: captured.migrationVersion,
      reader: {
        prepare(sql) {
          if (!/^\s*SELECT\b/i.test(sql)) throw new Error("installation inspection accepts SELECT statements only");
          return db.prepare(sql);
        },
      },
      dispose,
    };
  } catch {
    dispose();
    return uncertain("installed");
  }
}

function capture(
  listing: InstalledHome,
  ports: PreflightInspectPorts,
  scratch: string,
  userHome: string,
):
  | { ok: true; facts: CaptureFacts; db?: PrivateDatabase; migrationVersion?: number }
  | { ok: false; error?: AppError } {
  listing.liveness = ports.liveness ?? ((pid) => probePid(pid, ports.kill ?? process.kill.bind(process)));
  const copyFile = ports.copyFile ?? copyFileSync;
  const readFile = ports.readFile ?? ((path: string) => readFileSync(path));
  const openPrivate = ports.openPrivateDatabase ?? openPrivateCopy;
  const initialShape = managedShape(listing);
  if (initialShape === undefined) return { ok: false };
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    if (rootBinding(listing.requested) !== listing.homeBinding) return { ok: false };
    if (managedShape(listing) !== initialShape) return { ok: false };
    const before = fingerprint(listing);
    if (before === undefined) continue;
    const copyRoot = join(scratch, `attempt-${attempt}`);
    try {
      mkdirSync(copyRoot);
      const staged = stageCopies(listing, copyRoot, copyFile, readFile, userHome);
      if (listing.linkMoved) return { ok: false };
      if (staged === undefined) continue;
      if (rootBinding(listing.requested) !== listing.homeBinding) return { ok: false };
      if (managedShape(listing) !== initialShape) return { ok: false };
      const after = fingerprint(listing);
      if (after === undefined || after !== before) continue;
      const observed = observeCopy(staged, openPrivate, listing.liveness);
      if (observed === undefined) continue;
      if ("error" in observed) return { ok: false, error: observed.error };
      return { ok: true, ...observed };
    } catch {
      // The next attempt, or the final unverifiable verdict, owns this failure.
    }
  }
  return { ok: false };
}
