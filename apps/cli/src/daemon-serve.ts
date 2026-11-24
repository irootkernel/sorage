import { schemaAdmissionOf } from "@sorage/adapters/src/daemon-command-ports";
import { type AppError, errorSpec } from "@sorage/core";
import { serveDaemon } from "@sorage/daemon";
import { defaultPorts, renderAppError } from "./cli-output";

/**
 * Foreground entry for `sorage daemon serve`: the sole CLI module importing
 * `@sorage/daemon`, reached only through `main.ts`'s dynamic import branch so
 * non-serve CLI commands never evaluate daemon code.
 */
export function runDaemonServe(argv: string[]): number {
  Promise.resolve()
    .then(() =>
      serveDaemon({
        armSignals: (drain) => {
          process.on("SIGTERM", drain);
          process.on("SIGINT", drain);
        },
      }),
    )
    .then(() => {
      process.stdout.write(`sorage daemon serving\n`);
    })
    .catch((error: unknown) => {
      const admission = schemaAdmissionOf(error);
      if (admission !== null) {
        process.exitCode = renderAppError(admission, defaultPorts, argv.includes("--json"));
        return;
      }
      const typed = error as AppError | null;
      if (typed?.code === "STORAGE_SCHEMA_UNSUPPORTED" || typed?.code === "STORAGE_INTEGRITY_ERROR") {
        process.exitCode = renderAppError(typed, defaultPorts, argv.includes("--json"));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`the daemon could not start: ${message}\n`);
      // PORT_IN_USE and SERVICE_PAUSED carry their documented exit codes; an
      // unrecognized failure stays in the invalid-configuration category.
      const code = (error as { code?: unknown } | null)?.code;
      process.exitCode = typeof code === "string" ? errorSpec(code as Parameters<typeof errorSpec>[0]).exitCode : 78;
    });
  // The daemon owns the process until it stops; the serve promise keeps it alive.
  return -1;
}
