import { homedir } from "node:os";
import type { NodeDaemonDatabase } from "@sorage/adapters/src/daemon-command-ports";
import {
  createNodeHandoffReadPorts as createHandoffReadPorts,
  createNodeRetentionPorts as createRetentionPorts,
  createNodeReviewPorts as createReviewPorts,
  createNodeRevisionPorts as createRevisionPorts,
  createNodeSendPorts as createSendPorts,
  createNodeTerminalPorts as createTerminalPorts,
} from "@sorage/adapters/src/handoff-command-ports";
import { openCoveredReadStorage } from "@sorage/adapters/src/read-storage";
import { createNodeHomePaths } from "@sorage/adapters/src/home";
import { createNodeInboxMarkerPorts, isNodeInboxMarkerEnabled } from "@sorage/adapters/src/inbox-marker-ports";
import { createNodeProjectPorts as createProjectPorts } from "@sorage/adapters/src/project-command-ports";
import {
  type ActorRef,
  type AppError,
  appError,
  type Result as CoreResult,
  projectActor,
  type ReadActorInput,
  type HandoffDetailReadPorts,
  refreshProjectInboxMarker,
  USER_ACTOR,
} from "@sorage/core";
import type { Clock } from "@sorage/core";
import type { DaemonRequestContext } from "../http-kit";

export interface DomainRouteDeps {
  /** One daemon-lifetime connection shared by request port factories. */
  database?: NodeDaemonDatabase | undefined;
  /** Test Clock for Memo receipt boundaries. */
  memoClock?: Clock | undefined;
}

export function createRouteContext(deps: DomainRouteDeps) {
  const userHome = homedir();
  const homeOf = () => createNodeHomePaths().home;
  const databaseOptions = deps.database === undefined ? {} : { database: deps.database };
  // The daemon's Handoff and Project routes share the adapter classification
  // of SHR-015 through the same surfaced compositions the CLI uses, and their
  // post-commit completion warnings are logged server-side (interface 38.10).
  const daemonCompletionWarning = (text: string): void => {
    try {
      process.emitWarning(text, "SORAGE_COMPLETION");
    } catch {
      // A diagnostic sink failure never changes a committed route outcome.
    }
  };
  const withPorts = <P extends { close(): void }, R>(ports: P, body: (ports: P) => R): R => {
    try {
      return body(ports);
    } finally {
      ports.close();
    }
  };
  const createNodeProjectPorts = () => createProjectPorts({ ...databaseOptions, contentionSurface: "project" });
  const createNodeSendPorts = () => createSendPorts({ ...databaseOptions, completionWarning: daemonCompletionWarning });
  const createNodeHandoffReadPorts = () => createHandoffReadPorts(databaseOptions);
  const withHandoffRead = <T>(
    read: (ports: HandoffDetailReadPorts) => CoreResult<T, AppError>,
  ): CoreResult<T, AppError> => {
    const storage = openCoveredReadStorage({ surface: "handoff" });
    if (!storage.ok) return storage;
    try {
      return read(createHandoffReadPorts({ database: storage.value.db }));
    } finally {
      storage.value.close();
    }
  };
  const createNodeReviewPorts = () => createReviewPorts(databaseOptions);
  const createNodeRevisionPorts = () =>
    createRevisionPorts({ ...databaseOptions, completionWarning: daemonCompletionWarning });
  const createNodeTerminalPorts = () => createTerminalPorts(databaseOptions);
  const createNodeRetentionPorts = () =>
    createRetentionPorts({ ...databaseOptions, completionWarning: daemonCompletionWarning });
  const refreshBoundMarker = (projectId: string) => {
    // Advisory derived-view refresh (SHR-015 category (ii)): even the failure
    // to create the marker ports warns server-side and never changes the
    // committed route result, and every emission is contained.
    const emit = (text: string): void => {
      try {
        process.emitWarning(text, "SORAGE_INBOX_MARKER");
      } catch {
        // A diagnostic sink failure never changes a committed route outcome.
      }
    };
    try {
      if (!isNodeInboxMarkerEnabled()) return;
      const markerPorts = createNodeInboxMarkerPorts(databaseOptions);
      try {
        const refreshed = refreshProjectInboxMarker(markerPorts, projectId);
        if (!refreshed.ok) emit(refreshed.error.message);
      } finally {
        markerPorts.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(`the project inbox marker could not be refreshed: ${message}`);
    }
  };
  const actorInputOf = (
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): CoreResult<ReadActorInput, AppError> => {
    const as = query.get("as") ?? (typeof body.as === "string" ? body.as : undefined);
    const asUser = query.get("asUser") === "true" || body.asUser === true;
    if (as === undefined && asUser !== true) {
      return {
        ok: false,
        error: appError(
          "FORBIDDEN_ACTOR",
          "an HTTP request has no working directory; name the acting context with as=<project-slug> or asUser=true",
        ),
      };
    }
    return { ok: true, value: { path: "", userHome, as, asUser } };
  };

  async function resolveActor(body: Record<string, unknown>): Promise<CoreResult<ActorRef, AppError>> {
    if (body.asUser === true) return { ok: true, value: USER_ACTOR };
    if (typeof body.as === "string") {
      const slug = body.as;
      return withPorts(createNodeProjectPorts(), (ports) => {
        const found = ports.projects.findProjectBySlug(slug);
        if (!found.ok) return found;
        if (found.value === null) {
          return {
            ok: false,
            error: appError("PROJECT_NOT_FOUND", `no Project matches the slug '${slug}'`, { slug }),
          };
        }
        return { ok: true, value: projectActor(found.value.id) };
      });
    }
    return {
      ok: false,
      error: appError(
        "FORBIDDEN_ACTOR",
        "an HTTP request has no working directory; name the acting context with as=<project-slug> or asUser=true",
      ),
    };
  }

  function contextActor(context: DaemonRequestContext): CoreResult<ReadActorInput, AppError> {
    if (context.as === undefined && context.asUser !== true) {
      return {
        ok: false,
        error: appError(
          "FORBIDDEN_ACTOR",
          "an HTTP request has no working directory; name the acting context with as=<project-slug> or asUser=true",
        ),
      };
    }
    return { ok: true, value: { path: "", userHome, as: context.as, asUser: context.asUser } };
  }
  return {
    userHome,
    homeOf,
    databaseOptions,
    withPorts,
    createNodeProjectPorts,
    createNodeSendPorts,
    createNodeHandoffReadPorts,
    withHandoffRead,
    daemonCompletionWarning,
    createNodeReviewPorts,
    createNodeRevisionPorts,
    createNodeTerminalPorts,
    createNodeRetentionPorts,
    refreshBoundMarker,
    actorInputOf,
    resolveActor,
    contextActor,
  };
}

export function numericExpectations<K extends string>(
  body: Record<string, unknown>,
  keys: K[],
): CoreResult<Record<K, number>, AppError> {
  const parsed = {} as Record<K, number>;
  for (const key of keys) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return {
        ok: false,
        error: appError("CONFIG_INVALID", `${key} must be supplied as a number`, { key }),
      };
    }
    parsed[key] = value;
  }
  return { ok: true, value: parsed };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
