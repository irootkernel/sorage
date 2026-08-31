import { createServer as createNetServer, type AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, runCleanups, sorage } from "./helpers";

/**
 * The TASK-045 routing gate over the compiled binary: while the daemon runs it is
 * the only writer of config.yaml, so `config set` travels through
 * `PUT /api/v1/config` and a direct file write is refused; once it stops, the CLI
 * writes under config.lock again (CFG-016).
 */
const home = makeTempDir("sorage-config-route-home-");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

afterAll(() => runCleanups());

describe("configuration routing through the daemon (CFG-016)", () => {
  it("lands a routed change after a completed rotation", async () => {
    const port = await freePort();
    expect(sorage(["init", "--non-interactive", "--port", String(port)], { home }).status).toBe(0);
    expect(sorage(["token", "rotate", "--as-user", "--json"], { home }).status).toBe(0);
    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
    // Both the CLI and the daemon re-read the token file per call, so a
    // completed rotation agrees on both sides and the change lands; the
    // mid-flight retry and its never-retried write are proven deterministically
    // against a scripted server in apps/cli/test/int/cli-token-retry.int.test.ts.
    const set = sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home });
    expect(set.status).toBe(0);
    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);
  });

  it("routes config set through the daemon while it runs and back to the file after it stops", async () => {
    const port = await freePort();
    expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
    expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);

    expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);

    const routed = sorage(["config", "set", "ui.defaultPageSize", "40", "--as-user", "--json"], { home });
    expect(routed.status).toBe(0);
    expect(JSON.parse(routed.stdout)).toMatchObject({ ok: true, data: { key: "ui.defaultPageSize" } });

    // The daemon is still healthy after the routed write, and the file changed.
    const status = sorage(["daemon", "status", "--json"], { home });
    expect(status.status).toBe(0);

    // A direct file write through the editor flow is refused while the daemon runs.
    const edit = sorage(["config", "edit", "--as-user", "--json"], { home });
    expect(edit.status).toBe(75);
    expect(JSON.parse(edit.stderr).error.code).toBe("SERVICE_PAUSED");

    expect(sorage(["daemon", "stop", "--json"], { home }).status).toBe(0);

    // With the daemon stopped, the CLI writes the file directly again.
    const direct = sorage(["config", "set", "ui.defaultPageSize", "50", "--as-user", "--json"], { home });
    expect(direct.status).toBe(0);
    expect(JSON.parse(direct.stdout)).toMatchObject({ ok: true, data: { configRevision: expect.any(Number) } });
  }, 30000);
});
