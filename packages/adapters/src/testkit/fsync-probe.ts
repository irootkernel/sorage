import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Durability conformance probe (NFR-008): on macOS, Sorage writes must be flushed with
 * F_FULLFSYNC (fcntl code 51), because Bun does not use libuv and plain fsync is not
 * guaranteed to survive power loss on APFS. The probe calls fcntl(fd, F_FULLFSYNC)
 * directly through bun:ffi in a fresh Bun child process, because test runners may host
 * modules in workers whose ESM loader cannot resolve bun: schemes. The run fails when
 * the kernel rejects the call.
 */
const F_FULLFSYNC = 51;

export interface ProbeResult {
  platform: string;
  fullFsyncSupported: boolean;
  detail: string;
}

const PROBE_CHILD = `
const { dlopen } = await import("bun:ffi");
const fs = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = fs.mkdtempSync(join(tmpdir(), "sorage-fsync-probe-"));
const path = join(dir, "probe.dat");
const fd = fs.openSync(path, "w");
try {
  fs.writeSync(fd, "durability probe");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    fcntl: { args: ["int", "int", "int"], returns: "int" },
  });
  const rc = lib.symbols.fcntl(fd, ${F_FULLFSYNC}, 0);
  console.log(JSON.stringify({ rc, error: null }));
} catch (error) {
  console.log(JSON.stringify({ rc: -1, error: String(error) }));
} finally {
  fs.closeSync(fd);
  fs.rmSync(dir, { recursive: true, force: true });
}
`;

/** Runs the durability conformance probe for the current platform. */
export function probeFullFsync(): ProbeResult {
  const platform = process.platform;
  if (platform !== "darwin") {
    return {
      platform,
      fullFsyncSupported: true,
      detail: "probe skipped: F_FULLFSYNC is macOS-only and Linux durability is future work (README fixed decision 18)",
    };
  }
  const runnerDir = mkdtempSync(join(tmpdir(), "sorage-fsync-runner-"));
  const probeScript = join(runnerDir, "probe.ts");
  writeFileSync(probeScript, PROBE_CHILD);
  try {
    const result = spawnSync("bun", ["run", probeScript], { encoding: "utf8", timeout: 30_000 });
    const line = (result.stdout ?? "").split("\n").find((entry) => entry.trim().startsWith("{"));
    if (result.status !== 0 || !line) {
      return {
        platform,
        fullFsyncSupported: false,
        detail: `probe child failed with status ${result.status}: ${(result.stderr ?? "").slice(0, 200)}`,
      };
    }
    const parsed = JSON.parse(line) as { rc: number; error: string | null };
    if (parsed.error !== null) {
      return { platform, fullFsyncSupported: false, detail: `F_FULLFSYNC probe threw: ${parsed.error}` };
    }
    if (parsed.rc < 0) {
      return {
        platform,
        fullFsyncSupported: false,
        detail: `fcntl(fd, F_FULLFSYNC=${F_FULLFSYNC}) returned ${parsed.rc}`,
      };
    }
    return {
      platform,
      fullFsyncSupported: true,
      detail: `fcntl(fd, F_FULLFSYNC=${F_FULLFSYNC}) returned ${parsed.rc}`,
    };
  } finally {
    rmSync(dirname(probeScript), { recursive: true, force: true });
  }
}
