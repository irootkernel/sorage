import { dirname } from "node:path";
import {
  type AppError,
  appError,
  type Configuration,
  err,
  exchangeAccessDenied,
  type ExchangeBusinessRepository,
  type ExchangeBusinessResult,
  type ExchangeCapturedBody,
  type ExchangeCapturedInput,
  type ExchangeClaim,
  type ExchangeControlInput,
  exchangeFingerprint,
  type ExchangeInput,
  exchangeInvalid,
  type ExchangeLifecycleHead,
  type ExchangeLifecycleInput,
  type ExchangeNoticeList,
  type ExchangeObservedRequest,
  type ExchangeOutcome,
  type ExchangeRange,
  type ExchangeReportingClaim,
  type ExchangeView,
  expandConfigurationPath,
  isExchangeControl,
  ok,
  type Project,
  type ProjectBinding,
  type ProjectResolutionPorts,
  type Result,
} from "@sorage/core";
import { type ConfigFirstAdapterContext, openAdapterContext } from "./adapter-context";
import type { exchangeMaterial } from "./exchange-collaboration-records";
import type { BoundExchangeSource } from "./exchange-sources";
import { createExchangeWorkingStore, type PreparedExchangeBody } from "./exchange-working-store";
import type { HomeEnvironment, HomePaths } from "./home";
import { createNodeResolutionBindings } from "./project-command-ports";
import type { SqliteProjectReader } from "./projects";
import type { SorageSqlite } from "./sqlite/connection";
import { asSchemaAdmission } from "./sqlite/migrator";
import { asAppCommandError, carriedAppError, storageContentionOf } from "./storage-contention";

export interface Context {
  adapter: ConfigFirstAdapterContext;
  cwd: string;
  userHome: string;
  env: HomeEnvironment;
  home: HomePaths;
  config: Configuration;
  project?: string | undefined;
  asProject?: string | undefined;
  asUser?: boolean | undefined;
  now: () => Date;
  onFreshWrite?: (() => void) | undefined;
  joinAdmission?: ExchangeJoinAdmission | undefined;
  leaseOwnerAlive?: (() => boolean) | undefined;
}

export interface ExchangeCommandOptions {
  cwd?: string | undefined;
  userHome?: string | undefined;
  env?: HomeEnvironment | undefined;
  project?: string | undefined;
  asProject?: string | undefined;
  asUser?: boolean | undefined;
  now?: (() => Date) | undefined;
  onFreshWrite?: (() => void) | undefined;
  joinAdmission?: ExchangeJoinAdmission | undefined;
  leaseOwnerAlive?: (() => boolean) | undefined;
}

export type Actor = { project: Project; binding: ProjectBinding };

export interface ExchangeJoinAdmission {
  exchangeId: string;
  projectId: string;
  actor: Actor;
}

export type Header = {
  id: string;
  openingProjectId: string;
  goal: string;
  criteria: string;
  lastSeq: number;
  createdAt: string;
};

export type Receipt = { fingerprint: string; outcome: ExchangeOutcome };

export interface ContentCapture extends ExchangeCapturedBody {
  prepare(store: WorkingStore, exchangeId: string): Result<PreparedExchangeBody, AppError>;
}

export type WorkingStore = ReturnType<typeof createExchangeWorkingStore>;
export type Workspace = ProjectResolutionPorts["bindings"];

export interface BusinessCapture {
  actor: Actor;
  facts: ExchangeCapturedInput;
  custody?: BoundExchangeSource;
  content?: ContentCapture;
}

export interface RevalidationCapture {
  actor: Actor;
  material: NonNullable<ReturnType<typeof exchangeMaterial>>;
  custody: BoundExchangeSource;
}

export interface Preparation {
  captured?: BusinessCapture;
  revalidation?: RevalidationCapture;
}

/**
 * Internal store contract shared across the decomposed ExchangeStore helper
 * modules without introducing runtime cycles back to `exchange-store.ts`.
 */
export interface ExchangeStoreInternals extends ExchangeBusinessRepository {
  readonly db: SorageSqlite;
  readonly context: Context;
  readonly actor: Actor;
  readonly actorId: string;
  readonly projects: SqliteProjectReader;
  readonly working: WorkingStore;
  access(exchangeId: string): Header;
  project(value: string): Result<Project | null, AppError>;
  claim(exchangeId: string): ExchangeClaim | null;
  now(): Date;
  seq(exchangeId: string): number;
  head(exchangeId: string): ExchangeLifecycleHead;
  requireActive(exchangeId: string): void;
  advanceWork(exchangeId: string): void;
  observedRequests(exchangeId: string, head: ExchangeLifecycleHead): ExchangeObservedRequest[];
  ranges(exchangeId: string): ExchangeRange[];
  memberIds(exchangeId: string): string[];
  saveOutcome(outcome: ExchangeOutcome, operationId: string, fingerprint: string): void;
  outcomeData(outcome: ExchangeOutcome, replayed: boolean): ExchangeBusinessResult;
  publicView(exchangeId: string): ExchangeView;
  view(header: Header): ExchangeView;
  checkJoinOwner(exchangeId: string): void;
  requireLiveOwner(): void;
  acquireClaim(exchangeId: string, now: Date): ExchangeClaim;
  listNotices(header: Header, claim?: string): ExchangeNoticeList;
  acquireNotice(
    input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
    write: true,
  ): ExchangeReportingClaim;
  acquireNotice(
    input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
    write: false,
  ): ExchangeReportingClaim | undefined;
  acquireNotice(
    input: Extract<ExchangeLifecycleInput, { kind: "notice-acquire" }>,
    write: boolean,
  ): ExchangeReportingClaim | undefined;
}

export function controlOf(input: ExchangeInput): ExchangeControlInput | undefined {
  return isExchangeControl(input) ? input : input.kind === "join" ? input.resume : undefined;
}

export function controlFingerprint(input: ExchangeControlInput): string {
  const { operationId: _id, replayOnly: _replay, claim: _claim, ...intent } = input;
  return exchangeFingerprint(intent);
}

export function sameActor(a: Actor, b: Actor): boolean {
  return (
    a.project.id === b.project.id &&
    a.binding.id === b.binding.id &&
    a.binding.directory === b.binding.directory &&
    a.binding.bindingKind === b.binding.bindingKind &&
    a.binding.installationId === b.binding.installationId &&
    a.binding.updatedAt === b.binding.updatedAt
  );
}

/** Rollback carrier helpers reserved for ExchangeStore methods inside `runInTransaction`. */
export function fail(error: AppError): never {
  throw carriedAppError(error);
}

export function need<T>(result: Result<T>): T {
  if (!result.ok) return fail(result.error);
  return result.value;
}

export function denied(): never {
  return fail(exchangeAccessDenied());
}

export function conflict(message: string): never {
  return fail(appError("ROW_VERSION_CONFLICT", message));
}

export function invalid(message: string): never {
  return fail(exchangeInvalid(message));
}

export function storageFailure(error: unknown): AppError {
  return (
    asAppCommandError(error)?.error ??
    asSchemaAdmission(error) ??
    storageContentionOf(error, "exchange") ?? {
      ...appError("INTERNAL_ERROR", "The Exchange storage operation failed."),
      recovery: { suggestedCommand: "Retain this command and its output. Inspect or retry in the same mode." },
    }
  );
}

export function contextOf(options: ExchangeCommandOptions): Result<Context, AppError> {
  try {
    const adapter = openAdapterContext({
      order: "config-first",
      env: options.env,
      userHome: options.userHome,
    });
    const read = adapter.readConfiguration("operation");
    if (!read.ok) return read;
    if (!read.value) {
      return err(
        appError("NOT_INITIALIZED", "Sorage has not been initialized.", {
          expectedConfigPath: adapter.home.configFile,
        }),
      );
    }
    return ok({
      ...options,
      adapter,
      env: adapter.env,
      userHome: adapter.userHome,
      home: adapter.home,
      cwd: options.cwd ?? process.cwd(),
      config: read.value.config,
      now: options.now ?? (() => new Date()),
    });
  } catch (error) {
    return err(storageFailure(error));
  }
}

/** Capture physical resolution outside the SQLite transaction. Directory ties only consult lexical ancestors. */
export function observeWorkspace(context: Context): Workspace {
  const ports = createNodeResolutionBindings();
  const real = ports.realPath(context.cwd, context.userHome);
  const common = real.ok ? ports.gitCommonDirectory(real.value) : null;
  const physical = new Map<string, string | null>();
  if (real.ok) {
    for (let path = real.value; ; path = dirname(path)) {
      physical.set(path, ports.physicalIdentity(path));
      if (dirname(path) === path) break;
    }
  }
  return {
    realPath: () => real,
    gitCommonDirectory: () => common,
    physicalIdentity: (path) => physical.get(path) ?? null,
  };
}

export function createWorkingStore(db: SorageSqlite, context: Context): WorkingStore {
  return createExchangeWorkingStore({
    db,
    stateDir: context.home.stateDir,
    runDir: context.home.runDir,
    vaultPath: expandConfigurationPath(context.config.vault.path, context.userHome, context.home.home),
  });
}

export function openExchangeWriter(context: Context): Result<SorageSqlite, AppError> {
  try {
    return ok(context.adapter.openDatabase({ checkMoveLockBeforeOpen: true }));
  } catch (error) {
    return err(storageFailure(error));
  }
}
