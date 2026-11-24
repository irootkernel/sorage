import { configPutOnce, portHeldOnce, probeHealthOnce } from "@sorage/adapters/src/daemon-probes";
import { errorSpec } from "@sorage/core";
import { knownErrorCode } from "./cli-output";

/**
 * Non-exiting entry for the internal probe subprocesses (`__health-probe`,
 * `__config-put`, `__port-probe`), returning the exit code so both the
 * exiting wrapper and managed-Bun runtime tests share one code path.
 */
export async function runInternalProbeOnce(
  argv: string[],
  writeOut: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (argv[0] === "__health-probe") {
    const host = argv[1] ?? "127.0.0.1";
    const port = Number.parseInt(argv[2] ?? "46321", 10);
    const expected = argv[3];
    const body = await probeHealthOnce(host, port);
    return body !== null && (expected === undefined || body.installationId === expected) ? 0 : 1;
  }
  if (argv[0] === "__config-put") {
    const host = argv[1] ?? "127.0.0.1";
    const port = Number.parseInt(argv[2] ?? "46321", 10);
    const key = argv[3] ?? "";
    const value = argv[4] ?? "";
    const parsedRevision = argv[5] !== undefined ? Number.parseInt(argv[5], 10) : undefined;
    const expectedRevision =
      parsedRevision !== undefined && Number.isSafeInteger(parsedRevision) ? parsedRevision : undefined;
    const outcome = await configPutOnce(host, port, key, value, expectedRevision);
    if (outcome !== null) writeOut(`${JSON.stringify(outcome.body, null, 2)}\n`);
    const body = outcome?.body as { ok?: unknown; error?: { code?: unknown } } | undefined;
    return outcome === null ? 1 : body?.ok === true ? 0 : errorSpec(knownErrorCode(body?.error?.code)).exitCode;
  }
  if (argv[0] === "__port-probe") {
    const host = argv[1] ?? "127.0.0.1";
    const port = Number.parseInt(argv[2] ?? "46321", 10);
    const held = await portHeldOnce(host, port);
    return held ? 0 : 1;
  }
  return 1;
}

/** Dispatches an internal subprocess probe and owns process exit until its answer arrives. */
export function runInternalProbe(argv: string[]): number {
  void runInternalProbeOnce(argv)
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(1);
    });
  // The probe owns the process until its answer exists; nothing else may run.
  return -1;
}
