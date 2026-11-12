import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function fixture(check: (root: string) => void): void {
  const root = mkdtempSync("/tmp/sorage-toolchain-test-");
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync("scripts/toolchain.sh", join(root, "scripts/toolchain.sh"));
    writeFileSync(join(root, ".bun-version"), "1.2.3\n");
    writeFileSync(join(root, ".node-version"), "4.5.6\n");
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function install(root: string, kind: string, pin: string, actual = pin): void {
  const bin = join(root, ".toolchains", kind, pin, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, kind);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo '${actual}'; else printf '%s\\n' "$0" "$@"; fi\n`);
  chmodSync(path, 0o755);
}
function run(root: string, command = "bun", args = ["argument with spaces"]) {
  return spawnSync("/bin/sh", [join(root, "scripts/toolchain.sh"), command, ...args], {
    encoding: "utf8",
    env: { ...process.env, SORAGE_HOME: join(root, "home") },
  });
}
describe("project runtime admission", () => {
  it("refuses dependency installation without managed Node", () =>
    fixture((root) => {
      install(root, "bun", "1.2.3");
      const result = run(root, "bun", ["install"]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("make toolchain-install");
    }));
  it.each(["download", "checksum"])("preserves existing runtimes after %s failure", (failure) =>
    fixture((root) => {
      install(root, "node", "4.5.6", "v4.5.6");
      const launcher = join(root, "scripts/toolchain.sh");
      writeFileSync(launcher, readFileSync(launcher, "utf8").replaceAll("/usr/bin/curl", '"$root/curl"'));
      const curl = join(root, "curl");
      writeFileSync(
        curl,
        failure === "download"
          ? "#!/bin/sh\nexit 7\n"
          : '#!/bin/sh\nfor last do :; done\ncase "$*" in *SHASUMS256*) printf "%064d  bun-darwin-aarch64.zip\\n" 0 > "$last";; *) printf archive > "$last";; esac\n',
      );
      chmodSync(curl, 0o755);
      const result = run(root, "install");
      expect(result.status).not.toBe(0);
      if (failure === "checksum") expect(result.stderr).toContain("checksum mismatch");
      expect(readFileSync(join(root, ".toolchains/node/4.5.6/bin/node"), "utf8")).toContain("v4.5.6");
    }),
  );
  it("fails when the managed version is missing despite a system runtime", () =>
    fixture((root) => {
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("make toolchain-install");
    }));
  it("rejects a different version before forwarding arguments", () =>
    fixture((root) => {
      install(root, "bun", "1.2.3", "9.9.9");
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("observed 9.9.9");
    }));
  it("chooses the managed executable and preserves arguments", () =>
    fixture((root) => {
      install(root, "bun", "1.2.3");
      const result = run(root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("/.toolchains/bun/1.2.3/bin/bun\nargument with spaces\n");
    }));
  it("selects Node independently from Bun", () =>
    fixture((root) => {
      install(root, "bun", "1.2.3");
      install(root, "node", "4.5.6", "v4.5.6");
      expect(run(root, "node").stdout).toContain("/.toolchains/node/4.5.6/bin/node");
    }));
  it("uses a new pin without changing the launcher", () =>
    fixture((root) => {
      const before = readFileSync(join(root, "scripts/toolchain.sh"), "utf8");
      install(root, "bun", "7.8.9");
      writeFileSync(join(root, ".bun-version"), "7.8.9\n");
      expect(run(root).stdout).toContain("/.toolchains/bun/7.8.9/bin/bun");
      expect(readFileSync(join(root, "scripts/toolchain.sh"), "utf8")).toBe(before);
    }));
  it("rejects invalid pins", () =>
    fixture((root) => {
      writeFileSync(join(root, ".bun-version"), "latest\n");
      expect(run(root).stderr).toContain("invalid .bun-version");
    }));
});
