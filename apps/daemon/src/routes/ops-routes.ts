import { createNodeBackupCommandPorts } from "@sorage/adapters/src/backup-command-ports";
import { createNodeConfigCommandPorts } from "@sorage/adapters/src/config-command-ports";
import { schemaAdmissionOf } from "@sorage/adapters/src/daemon-command-ports";
import { createNodeDoctorPorts } from "@sorage/adapters/src/doctor";
import { createNodeVaultCommandPorts } from "@sorage/adapters/src/vault-command-ports";
import {
  appError,
  backupStatus,
  backupVerify,
  configureBackup,
  moveVault,
  ok,
  runBackupCommandAsync,
  runDoctor,
  validateConfigurationFile,
  vaultStatus,
  vaultVerify,
} from "@sorage/core";
import { readJsonBody, respond, respondError } from "../http-kit";
import type { RouteEntryInternal } from "../route-kit";

export function createOpsRoutes(): RouteEntryInternal[] {
  const routes: RouteEntryInternal[] = [];
  const add = (entry: RouteEntryInternal) => routes.push(entry);

  // ---- Vault and configuration validation (section 18.2) --------------------
  add({
    method: "POST",
    pattern: "/api/v1/config/validate",
    handler: async (_request, response, context) => {
      const result = validateConfigurationFile(createNodeConfigCommandPorts());
      return void respond(
        response,
        context,
        result.ok ? { ok: true, value: { valid: true, path: result.value.path } } : result,
      );
    },
  });
  add({
    method: "GET",
    pattern: "/api/v1/vault/status",
    handler: async (_request, response, context) => {
      const ports = createNodeVaultCommandPorts();
      const opened = ports.statusPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, vaultStatus(opened.value));
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/vault/verify",
    handler: async (_request, response, context) => {
      const ports = createNodeVaultCommandPorts();
      const opened = ports.verifyPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, vaultVerify(opened.value, { now: new Date() }));
    },
  });
  add({
    method: "POST",
    pattern: "/api/v1/vault/move",
    handler: async (request, response, context) => {
      const body = await readJsonBody(request);
      if (body.asUser !== true) {
        return void respondError(
          response,
          context,
          appError("USER_CONTEXT_REQUIRED", "vault move is a User-admin operation; pass asUser=true"),
        );
      }
      const ports = createNodeVaultCommandPorts({ targetPath: String(body.to ?? "") });
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.movePorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, moveVault(opened.value));
    },
  });

  // ---- Backup (section 18.7; restore is deliberately CLI-only) --------------
  add({
    method: "GET",
    pattern: "/api/v1/backup/status",
    handler: async (_request, response, context) => {
      const ports = createNodeBackupCommandPorts();
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.statusPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      return void respond(response, context, backupStatus(opened.value));
    },
  });

  add({
    method: "POST",
    pattern: "/api/v1/backup/run",
    idempotencyScope: "backup-run",
    handler: async (_request, response, context) => {
      const ports = createNodeBackupCommandPorts();
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.asyncRunPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      const result = await runBackupCommandAsync(opened.value, {
        ...(context.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
      });
      return void respond(response, context, result);
    },
  });

  add({
    method: "POST",
    pattern: "/api/v1/backup/verify",
    handler: async (_request, response, context) => {
      const ports = createNodeBackupCommandPorts();
      const drained = ports.drainAtStart();
      if (!drained.ok) return void respondError(response, context, drained.error);
      const opened = ports.verifyPorts();
      if (!opened.ok) return void respondError(response, context, opened.error);
      const report = backupVerify(opened.value, { now: new Date() });
      if (!report.ok) return void respondError(response, context, report.error);
      return void respond(response, context, ok({ ...report.value, blocking: report.value.findings.length > 0 }));
    },
  });

  const backupConfigAction = (action: "enable" | "disable" | "enable-push" | "disable-push") =>
    add({
      method: "POST",
      pattern: `/api/v1/backup/${action}`,
      handler: async (request, response, context) => {
        const body = await readJsonBody(request);
        if (body.asUser !== true) {
          return void respondError(
            response,
            context,
            appError("USER_CONTEXT_REQUIRED", `backup ${action} is a User-admin operation; pass asUser=true`),
          );
        }
        const store = createNodeConfigCommandPorts().store;
        const result = configureBackup(
          {
            read: () => {
              const read = store.read();
              if (!read.ok) return read;
              if (read.value === null)
                return { ok: false as const, error: appError("NOT_INITIALIZED", "Sorage is not initialized.") };
              return { ok: true as const, value: { config: read.value.config, etag: read.value.etag } };
            },
            write: (next, expect) => {
              const written = store.write(next, { etag: expect.etag });
              if (!written.ok) return written;
              return { ok: true as const, value: { etag: written.value.etag } };
            },
          },
          {
            action,
            asUser: true,
            ...(action === "enable"
              ? {
                  dailyAt: typeof body.dailyAt === "string" ? body.dailyAt : undefined,
                  ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
                }
              : {}),
            ...(action === "enable-push"
              ? {
                  remote: typeof body.remote === "string" ? body.remote : undefined,
                  branch: typeof body.branch === "string" ? body.branch : undefined,
                }
              : {}),
          },
        );
        return void respond(response, context, result);
      },
    });
  backupConfigAction("enable");
  backupConfigAction("disable");
  backupConfigAction("enable-push");
  backupConfigAction("disable-push");

  // ---- Diagnostics ----------------------------------------------------------
  add({
    method: "GET",
    pattern: "/api/v1/diagnostics",
    handler: async (_request, response, context) => {
      try {
        const ports = createNodeDoctorPorts();
        const report = runDoctor(ports, "");
        return void respond(response, context, { ok: true, value: report });
      } catch (error) {
        // The doctor's eager history-admission guard throws the typed
        // SchemaAdmissionError for a confirmed future database — translate
        // only that narrow case through the existing composition classifier
        // and error responder, and rethrow everything else to the server's
        // generic handler.
        const admission = schemaAdmissionOf(error);
        if (admission !== null) {
          return void respondError(response, context, admission);
        }
        throw error;
      }
    },
  });

  return routes;
}
