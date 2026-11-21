import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { BINARY, envelopeOf, makeTempDir, runCleanups, sorage } from "./helpers";

afterEach(runCleanups);

it("reclaims only exact dead precommit stages while a real blocked preparer is alive", async () => {
  const root = makeTempDir("aj36-cleanup-");
  const home = join(root, "home");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  for (const path of [alpha, beta]) mkdirSync(path);
  const binary = process.env.SORAGE_AJ36_BINARY ?? BINARY;
  const command = (args: string[]) => {
    const result = sorage([...args, "--json"], { binary, home, cwd: alpha });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return envelopeOf(result).data as Record<string, unknown>;
  };
  command(["init", "--non-interactive"]);
  command(["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", alpha]);
  command(["project", "add", "--name", "Beta", "--slug", "beta", "--dir", beta]);
  const { exchangeId } = command([
    "exchange",
    "create",
    "--member",
    "beta",
    "--goal",
    "Keep liveness ownership",
    "--criterion",
    "Always honor live preparation",
    "--operation-id",
    "create",
  ]);

  const source = join(root, "prepare.ts");
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const storage = join(repository, "packages/adapters/src/exchange-working-store.ts");
  writeFileSync(
    source,
    `import { Database } from "bun:sqlite";
    import { createExchangeWorkingStore } from ${JSON.stringify(storage)};
    const [exchangeId, stateDir, vaultPath] = process.argv.slice(2);
    const db = new Database(stateDir + "/sorage.sqlite3");
    const store = createExchangeWorkingStore({ db, stateDir, vaultPath });
    const result = store.prepare({ exchangeId, classification: "binary", maxBytes: 70000, chunks: [Buffer.alloc(66000, 42)] });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    console.log(result.value.id);
    setInterval(() => {}, 1000);
  `,
  );
  const stateDir = join(home, "state");
  const staging = join(stateDir, "exchange-working", "staging");
  const owners = join(stateDir, "exchange-working", "owners");
  const workers: { child: ChildProcess; close: Promise<unknown> }[] = [];
  const start = async () => {
    const child = spawn(
      "/bin/sh",
      ["scripts/toolchain.sh", "bun", source, String(exchangeId), stateDir, join(home, "vault")],
      {
        cwd: repository,
        env: { ...process.env, SORAGE_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    const close = new Promise((done) => child.once("close", done));
    workers.push({ child, close });
    try {
      const id = await Promise.race([
        new Promise<string>((done) => lines.once("line", done)),
        close.then(() => {
          throw new Error(`The actual preparer exited: ${diagnostics}`);
        }),
      ]);
      expect(existsSync(join(staging, id))).toBe(true);
      expect(existsSync(join(owners, id))).toBe(true);
      return { child, close, id };
    } finally {
      lines.close();
    }
  };
  try {
    const dead = await start();
    const live = await start();
    live.child.kill("SIGSTOP");
    dead.child.kill("SIGKILL");
    await dead.close;
    const unmarked = "01111111-1111-4111-8111-111111111111";
    writeFileSync(join(staging, unmarked), "unknown liveness");
    expect(command(["exchange", "cleanup", String(exchangeId)])).toMatchObject({
      cleanup: "not-completed",
      reclaimedStages: 1,
    });
    expect(existsSync(join(staging, dead.id))).toBe(false);
    expect(existsSync(join(owners, dead.id))).toBe(false);
    expect(existsSync(join(staging, live.id))).toBe(true);
    expect(existsSync(join(owners, live.id))).toBe(true);
    expect(existsSync(join(staging, unmarked))).toBe(true);
  } finally {
    for (const { child } of workers) child.kill("SIGKILL");
    await Promise.all(workers.map(({ close }) => close));
  }
}, 20_000);
