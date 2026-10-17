import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type AppError,
  appError,
  type Clock,
  err,
  ok,
  type Project,
  type ProjectBinding,
  type Result,
  type SendRecoveryPorts,
  type SendRecoveryReadPort,
  SystemClock,
  validateProjectSlug,
} from "@sorage/core";
import { createHomePaths, type HomeEnvironment } from "./home";
import { digestFile, inspectSourceFile } from "./import-source";
import { type InstallationInspectionReader, type PreflightInspectPorts, withInstallationInspection } from "./preflight";
import { createNodeResolutionBindings } from "./project-command-ports";

export interface NodeSendRecoveryOptions {
  env?: HomeEnvironment;
  userHome?: string;
  clock?: Clock;
  inspection?: PreflightInspectPorts;
}

/** No operational initialization, migration, drain, marker refresh or logging is wired here. */
export function createNodeSendRecoveryPorts(options: NodeSendRecoveryOptions = {}): SendRecoveryPorts {
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths(options.env ?? { SORAGE_HOME: process.env.SORAGE_HOME }, userHome);
  return {
    clock: options.clock ?? new SystemClock(),
    inspect(consume) {
      return withInstallationInspection(home.home, { ...options.inspection, userHome }, (observation) => {
        if (observation.kind === "refused") return err(observation.error);
        if (observation.migrationVersion < 4)
          return err(
            appError("STORAGE_SCHEMA_UNSUPPORTED", "the historical database layout has no send receipt domain"),
          );
        const read = recoveryReader(observation.reader, observation.config.installationId);
        return read.ok ? consume(read.value) : read;
      });
    },
    inspectSource(path, currentUserHome) {
      const expanded =
        path === "~" ? currentUserHome : path.startsWith("~/") ? join(currentUserHome, path.slice(2)) : path;
      const inspected = inspectSourceFile(expanded);
      return inspected.ok
        ? ok({ resolvedSourcePath: inspected.value.resolvedPath, originalName: basename(inspected.value.resolvedPath) })
        : inspected;
    },
    digestSource: digestFile,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v !== "";
const nullable = (v: unknown): v is string | null => v === null || typeof v === "string";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const corrupt = () => appError("STORAGE_INTEGRITY_ERROR", "the inspected recovery rows are malformed");

function project(row: unknown): Project | undefined {
  if (
    !record(row) ||
    !uuid(row.id) ||
    !text(row.slug) ||
    !validateProjectSlug(row.slug).ok ||
    row.slug !== row.slug.toLowerCase() ||
    !text(row.display_name) ||
    !nullable(row.description) ||
    (row.status !== "active" && row.status !== "archived") ||
    !text(row.created_at) ||
    !text(row.updated_at)
  )
    return undefined;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function binding(row: unknown): ProjectBinding | undefined {
  if (
    !record(row) ||
    !uuid(row.id) ||
    !uuid(row.project_id) ||
    !uuid(row.installation_id) ||
    !text(row.directory) ||
    !row.directory.startsWith("/") ||
    (row.binding_kind !== "directory" && row.binding_kind !== "git_repository") ||
    !text(row.created_at) ||
    !text(row.updated_at)
  )
    return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    installationId: row.installation_id,
    directory: row.directory,
    bindingKind: row.binding_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recoveryReader(
  db: InstallationInspectionReader,
  installationId: string,
): Result<SendRecoveryReadPort, AppError> {
  // Only these private reads are caught. The application consumer runs once outside this catch.
  const read = <T>(operation: () => T): Result<T, AppError> => {
    try {
      return ok(operation());
    } catch {
      return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "a private recovery read failed"));
    }
  };
  const registry = read(() => ({
    projects: db.prepare("SELECT * FROM projects ORDER BY slug COLLATE NOCASE").all().map(project),
    bindings: db.prepare("SELECT * FROM project_bindings ORDER BY directory").all().map(binding),
  }));
  if (!registry.ok) return registry;
  const projects: Project[] = [];
  const bindings: ProjectBinding[] = [];
  for (const row of registry.value.projects) {
    if (row === undefined) return err(corrupt());
    projects.push(row);
  }
  for (const row of registry.value.bindings) {
    if (row === undefined || row.installationId !== installationId || !projects.some((p) => p.id === row.projectId))
      return err(corrupt());
    bindings.push(row);
  }
  return ok({
    projectPorts: {
      installationId,
      bindings: createNodeResolutionBindings(),
      projects: {
        findProjectBySlug: (slug) => ok(projects.find((p) => p.slug === slug.toLowerCase()) ?? null),
        listProjects: () => ok(projects),
        listBindings: () => ok(bindings),
        listBindingsForProject: (id) => ok(bindings.filter((b) => b.projectId === id)),
      },
    },
    findSendReceipt(key) {
      const found = read(() =>
        db
          .prepare(
            "SELECT request_hash, response_json, expires_at FROM idempotency_keys WHERE key = ? AND scope = 'send'",
          )
          .get(key),
      );
      if (!found.ok) return found;
      const row = found.value;
      if (row === null || row === undefined) return ok(null);
      if (!record(row) || !text(row.request_hash) || !text(row.response_json) || !text(row.expires_at))
        return err(corrupt());
      return ok({ requestHash: row.request_hash, responseJson: row.response_json, expiresAt: row.expires_at });
    },
    findHandoff(id) {
      const found = read(() =>
        db
          .prepare(
            "SELECT id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id FROM handoffs WHERE id = ?",
          )
          .get(id),
      );
      if (!found.ok) return found;
      const row = found.value;
      if (row === null || row === undefined) return ok(null);
      if (
        !record(row) ||
        !uuid(row.id) ||
        !nullable(row.dispatch_group_id) ||
        !nullable(row.supersedes_handoff_id) ||
        !text(row.title) ||
        (row.sender_kind !== "registered_project" &&
          row.sender_kind !== "unregistered_workspace" &&
          row.sender_kind !== "user") ||
        !nullable(row.sender_project_id) ||
        !nullable(row.sender_workspace_key) ||
        !nullable(row.sender_path_snapshot) ||
        !uuid(row.recipient_project_id)
      )
        return err(corrupt());
      return ok({
        id: row.id,
        dispatchGroupId: row.dispatch_group_id,
        supersedesHandoffId: row.supersedes_handoff_id,
        title: row.title,
        senderKind: row.sender_kind,
        senderProjectId: row.sender_project_id,
        senderWorkspaceKey: row.sender_workspace_key,
        senderPathSnapshot: row.sender_path_snapshot,
        recipientProjectId: row.recipient_project_id,
      });
    },
  });
}
