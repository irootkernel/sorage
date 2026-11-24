import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LineSplitter } from "../contract/mcp-line-splitter";

/**
 * Managed-Bun lazy-bootstrap runtime proof (TASK-159, dossier §7.6):
 * Vitest runs under Node ESM where `require.cache` is unavailable or empty for
 * ESM imports, so every check spawns a separate fresh managed Bun process
 * directly from `.toolchains/bun/<.bun-version>/bin/bun` (not `scripts/toolchain.sh`,
 * which `cd`s to the repository root) using absolute `file://` URLs derived from
 * the repository root so actor `cwd` resolution stays intact.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const bunVersion = readFileSync(join(repoRoot, ".bun-version"), "utf8").trim();
const managedBun = join(repoRoot, ".toolchains", "bun", bunVersion, "bin", "bun");
if (!existsSync(managedBun)) {
  throw new Error(`Managed Bun ${bunVersion} not found at ${managedBun}; run make toolchain-install`);
}
const mainPath = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const mainUrl = new URL("../../src/main.ts", import.meta.url).href;
const internalProbesUrl = new URL("../../src/internal-probes.ts", import.meta.url).href;
const daemonServeUrl = new URL("../../src/daemon-serve.ts", import.meta.url).href;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn !== undefined) {
      try {
        fn();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runManagedBun(script: string, options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return spawnSync(managedBun, ["-e", script], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function runCliSubprocess(args: string[], options: { cwd: string; home: string }) {
  return spawnSync(managedBun, [mainPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, SORAGE_HOME: options.home },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function createExchangeFixture() {
  const root = makeTempDir("sorage-lazy-bootstrap-");
  const home = join(root, "home");
  const workA = join(root, "work-a");
  const workB = join(root, "work-b");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });

  const step = (args: string[], cwd = workA) => {
    const res = runCliSubprocess([...args, "--json"], { cwd, home });
    expect(res.status, res.stderr || res.stdout).toBe(0);
    return JSON.parse(res.stdout) as { ok: boolean; data: Record<string, unknown> };
  };

  step(["init", "--non-interactive"]);
  step(["project", "add", "--name", "Alpha", "--slug", "alpha", "--dir", workA]);
  step(["project", "add", "--name", "Beta", "--slug", "beta", "--dir", workB]);
  const created = step([
    "exchange",
    "create",
    "--member",
    "beta",
    "--goal",
    "Verify lazy bootstrap",
    "--criterion",
    "No daemon module loaded on renew",
    "--operation-id",
    "lazy-bootstrap-create",
  ]);
  const exchangeId = String(created.data.exchangeId);
  const joined = step(["exchange", "join", exchangeId]);
  const claimId = String(joined.data.claimId);
  return { root, home, workA, workB, exchangeId, claimId };
}

function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function runAsyncMcpStdioCase(
  argv: string[],
  fixture: { root: string; home: string; workA: string },
): Promise<{
  exitCode: number | null;
  initAnswer: Record<string, unknown>;
  report: { mainReturn: number; daemonCache: string[]; mcpServerLoaded: boolean };
}> {
  const reportFile = join(fixture.root, `mcp-report-${argv.join("_")}.json`);
  const script = `
    import { writeFileSync } from "node:fs";
    const { main } = await import(${JSON.stringify(mainUrl)});
    const ret = await main(${JSON.stringify(argv)});
    process.on("beforeExit", () => {
      const keys = Object.keys(require.cache);
      writeFileSync(
        ${JSON.stringify(reportFile)},
        JSON.stringify({
          mainReturn: ret,
          daemonCache: keys.filter((k) => k.includes("apps/daemon/src")),
          mcpServerLoaded: keys.some((k) => k.includes("apps/cli/src/mcp-server")),
        }),
      );
    });
  `;
  const child = spawn(managedBun, ["-e", script], {
    cwd: fixture.workA,
    env: { ...process.env, SORAGE_HOME: fixture.home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const initAnswer = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for MCP initialize; stderr=${stderr}`)), 15_000);
    const splitter = new LineSplitter();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(chunk)) {
        if (line.trim() === "") continue;
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
        return;
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`MCP child exited early (${String(code)}); stderr=${stderr}`));
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
  });

  child.stdin?.end();
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
    mainReturn: number;
    daemonCache: string[];
    mcpServerLoaded: boolean;
  };
  return { exitCode, initAnswer, report };
}

describe("managed-Bun lazy bootstrap and daemon isolation (TASK-159)", () => {
  it("runs non-exiting main(['exchange', 'renew', ...]) in a fresh process with zero apps/daemon/src cache entries", () => {
    const fixture = createExchangeFixture();
    const reportFile = join(fixture.root, "renew-report.json");
    const script = `
      import { writeFileSync } from "node:fs";
      let capturedOut = "";
      let capturedErr = "";
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        capturedOut += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        capturedErr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stderr.write;
      const { main } = await import(${JSON.stringify(mainUrl)});
      const code = await main(["exchange", "renew", ${JSON.stringify(fixture.exchangeId)}, "--claim", ${JSON.stringify(fixture.claimId)}, "--json"]);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      const keys = Object.keys(require.cache);
      writeFileSync(
        ${JSON.stringify(reportFile)},
        JSON.stringify({
          code,
          stdout: capturedOut,
          stderr: capturedErr,
          daemonCache: keys.filter((k) => k.includes("apps/daemon/src")),
        }),
      );
    `;
    const run = runManagedBun(script, {
      cwd: fixture.workA,
      env: { ...process.env, SORAGE_HOME: fixture.home },
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
      code: number;
      stdout: string;
      stderr: string;
      daemonCache: string[];
    };
    expect(report.code).toBe(0);
    expect(report.stderr).toBe("");
    const envelope = JSON.parse(report.stdout) as { ok: boolean; data: { exchangeId: string; claimId: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.exchangeId).toBe(fixture.exchangeId);
    expect(envelope.data.claimId).toBe(fixture.claimId);
    expect(report.daemonCache).toEqual([]);
  });

  it("runs the non-exiting internal probe entry in a fresh process with zero apps/daemon/src cache entries", async () => {
    const root = makeTempDir("sorage-lazy-probe-");
    const closedPort = await reserveClosedPort();
    const reportFile = join(root, "probe-report.json");
    const script = `
      import { writeFileSync } from "node:fs";
      const { runInternalProbeOnce } = await import(${JSON.stringify(internalProbesUrl)});
      const code = await runInternalProbeOnce(["__port-probe", "127.0.0.1", ${JSON.stringify(String(closedPort))}]);
      const keys = Object.keys(require.cache);
      writeFileSync(
        ${JSON.stringify(reportFile)},
        JSON.stringify({
          code,
          daemonCache: keys.filter((k) => k.includes("apps/daemon/src")),
        }),
      );
    `;
    const run = runManagedBun(script, {
      cwd: root,
      env: { ...process.env, SORAGE_HOME: join(root, "home") },
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as { code: number; daemonCache: string[] };
    expect(report.code).toBe(1);
    expect(report.daemonCache).toEqual([]);
  });

  it("positive control: importing daemon-serve.ts in a fresh managed-Bun process populates apps/daemon/src in require.cache", () => {
    const root = makeTempDir("sorage-lazy-daemon-pos-");
    const reportFile = join(root, "daemon-pos-report.json");
    const script = `
      import { writeFileSync } from "node:fs";
      await import(${JSON.stringify(daemonServeUrl)});
      const keys = Object.keys(require.cache);
      writeFileSync(
        ${JSON.stringify(reportFile)},
        JSON.stringify({
          daemonCache: keys.filter((k) => k.includes("apps/daemon/src")),
        }),
      );
    `;
    const run = runManagedBun(script, {
      cwd: root,
      env: { ...process.env, SORAGE_HOME: join(root, "home") },
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as { daemonCache: string[] };
    expect(report.daemonCache.length).toBeGreaterThan(0);
  });

  it("exercises all four async main() MCP argv branches in fresh managed-Bun processes", async () => {
    const fixture = createExchangeFixture();

    // 1. Plain `main(["mcp"])`
    const plain = await runAsyncMcpStdioCase(["mcp"], fixture);
    expect(plain.exitCode).toBe(0);
    expect((plain.initAnswer.result as { serverInfo: { name: string } }).serverInfo.name).toBe("sorage");
    expect(plain.report.mainReturn).toBe(-1);
    expect(plain.report.mcpServerLoaded).toBe(true);
    expect(plain.report.daemonCache).toEqual([]);

    // 2. Global-flag `main(["--json", "mcp"])`
    const globalFlag = await runAsyncMcpStdioCase(["--json", "mcp"], fixture);
    expect(globalFlag.exitCode).toBe(0);
    expect((globalFlag.initAnswer.result as { serverInfo: { name: string } }).serverInfo.name).toBe("sorage");
    expect(globalFlag.report.mainReturn).toBe(-1);
    expect(globalFlag.report.mcpServerLoaded).toBe(true);
    expect(globalFlag.report.daemonCache).toEqual([]);

    // 3. `main(["mcp", "--help"])` — synchronous Commander exit 0, never imports mcp-server.ts or daemon
    const helpReportFile = join(fixture.root, "mcp-help-report.json");
    const helpScript = `
      import { writeFileSync } from "node:fs";
      let out = "";
      let err = "";
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((c: string | Uint8Array) => { out += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((c: string | Uint8Array) => { err += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); return true; }) as typeof process.stderr.write;
      const { main } = await import(${JSON.stringify(mainUrl)});
      const code = await main(["mcp", "--help"]);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      const keys = Object.keys(require.cache);
      writeFileSync(${JSON.stringify(helpReportFile)}, JSON.stringify({
        code,
        out,
        err,
        mcpServerCache: keys.filter((k) => k.includes("apps/cli/src/mcp-server")),
        daemonCache: keys.filter((k) => k.includes("apps/daemon/src")),
      }));
    `;
    const helpRun = runManagedBun(helpScript, {
      cwd: fixture.workA,
      env: { ...process.env, SORAGE_HOME: fixture.home },
    });
    expect(helpRun.status, helpRun.stderr || helpRun.stdout).toBe(0);
    const helpReport = JSON.parse(readFileSync(helpReportFile, "utf8")) as {
      code: number;
      out: string;
      err: string;
      mcpServerCache: string[];
      daemonCache: string[];
    };
    expect(helpReport.code).toBe(0);
    expect(helpReport.out).toContain("STDIO MCP adapter");
    expect(helpReport.mcpServerCache).toEqual([]);
    expect(helpReport.daemonCache).toEqual([]);

    // 4. `main(["mcp", "extra"])` — synchronous Commander exit 2, never imports mcp-server.ts or daemon
    const extraReportFile = join(fixture.root, "mcp-extra-report.json");
    const extraScript = `
      import { writeFileSync } from "node:fs";
      let out = "";
      let err = "";
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((c: string | Uint8Array) => { out += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((c: string | Uint8Array) => { err += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); return true; }) as typeof process.stderr.write;
      const { main } = await import(${JSON.stringify(mainUrl)});
      const code = await main(["mcp", "extra"]);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      const keys = Object.keys(require.cache);
      writeFileSync(${JSON.stringify(extraReportFile)}, JSON.stringify({
        code,
        out,
        err,
        mcpServerCache: keys.filter((k) => k.includes("apps/cli/src/mcp-server")),
        daemonCache: keys.filter((k) => k.includes("apps/daemon/src")),
      }));
    `;
    const extraRun = runManagedBun(extraScript, {
      cwd: fixture.workA,
      env: { ...process.env, SORAGE_HOME: fixture.home },
    });
    expect(extraRun.status, extraRun.stderr || extraRun.stdout).toBe(0);
    const extraReport = JSON.parse(readFileSync(extraReportFile, "utf8")) as {
      code: number;
      out: string;
      err: string;
      mcpServerCache: string[];
      daemonCache: string[];
    };
    expect(extraReport.code).toBe(2);
    expect(extraReport.err).toContain("arguments");
    expect(extraReport.mcpServerCache).toEqual([]);
    expect(extraReport.daemonCache).toEqual([]);
  });
});
