import { appendFileSync } from "node:fs";

/**
 * TASK-114 test-only exec-instant helper (EPIC-017 plan r2 section 2.2,
 * decision P3): the start-gate wrapper passes its own `$$` and the shared exec
 * log path, and this helper appends `<wrapper pid> <Date.now()>`. The wrapper
 * `exec`s the compiled binary afterwards, so the wrapper PID becomes the
 * binary PID and the line binds the recorded instant to the spawned process.
 * The instant is slightly before the binary starts; the measurement limits in
 * the qualification note keep that approximation explicit. A missing or
 * unparsable line makes the harness run invalid.
 */
const pid = process.argv[2];
const logPath = process.argv[3];
if (pid === undefined || logPath === undefined || !/^\d+$/.test(pid)) {
  process.stderr.write("usage: exec-instant.ts <pid> <exec-log>\n");
  process.exit(2);
}
appendFileSync(logPath, `${pid} ${Date.now()}\n`, "utf8");
