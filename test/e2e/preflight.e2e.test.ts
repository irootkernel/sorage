import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

function storageProof(root: string): string[] {
  if (!existsSync(root)) return ["absent"];
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    const hash = rootStat.isSymbolicLink() ? "" : createHash("sha256").update(readFileSync(root)).digest("hex");
    return [`f . ${rootStat.mode} ${rootStat.mtimeMs} ${rootStat.dev}:${rootStat.ino} ${hash}`];
  }
  const rows = [`@ ${rootStat.mode} ${rootStat.mtimeMs} ${rootStat.dev}:${rootStat.ino}`];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isSymbolicLink()) rows.push(`l ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino}`);
      else if (stat.isDirectory()) {
        rows.push(`d ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino}`);
        walk(path);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        rows.push(`f ${rel} ${stat.mode} ${stat.mtimeMs} ${stat.dev}:${stat.ino} ${hash}`);
      }
    }
  };
  walk(root);
  return rows.sort();
}

describe("compiled preflight", () => {
  it("reports an absent home and rejects confirmation without creating the home", () => {
    const parent = makeTempDir("sorage-preflight-e2e-");
    const home = join(parent, "absent");
    const report = sorage(["preflight", "--json"], { home });
    expect(report.status).toBe(0);
    expect(report.stderr).toBe("");
    const body = JSON.parse(report.stdout) as { ok: boolean; data: { status: string; checks: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("fresh");
    expect(body.data.checks).toHaveLength(8);
    expect(existsSync(home)).toBe(false);

    const human = sorage(["preflight"], { home });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("Preflight status: fresh");
    expect(human.stdout).toContain("Recovery: This status does not authorize initialization.");

    for (const args of [
      ["preflight", "--confirm"],
      ["--confirm", "preflight"],
      ["preflight", "--help"],
    ]) {
      const run = sorage(args, { home });
      expect(existsSync(home)).toBe(false);
      if (args.at(-1) === "--help") expect(run.status).toBe(0);
      else {
        expect(run.status).toBe(2);
        expect(run.stdout).toBe("");
      }
    }
  });

  it("leaves an initialized installation unchanged and reports compatible", () => {
    const home = makeTempDir("sorage-preflight-e2e-init-");
    expect(sorage(["init", "--non-interactive"], { home }).status).toBe(0);
    const before = storageProof(home);
    const report = sorage(["preflight", "--json"], { home });
    const body = JSON.parse(report.stdout) as { ok: boolean; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("compatible");
    expect(report.status).toBe(0);
    expect(storageProof(home)).toEqual(before);
  });

  it("reports a partial installation and a non-directory home without changing them", () => {
    const partial = makeTempDir("sorage-preflight-e2e-partial-");
    expect(sorage(["init", "--non-interactive"], { home: partial }).status).toBe(0);
    rmSync(join(partial, "vault", ".sorage-vault.json"));
    const partialBefore = storageProof(partial);
    const partialRun = sorage(["preflight", "--json"], { home: partial });
    const partialBody = JSON.parse(partialRun.stdout) as { ok: boolean; data: { status: string } };
    expect(partialBody.ok).toBe(true);
    expect(partialBody.data.status).toBe("recovery_required");
    expect(partialRun.status).toBe(78);
    expect(storageProof(partial)).toEqual(partialBefore);

    const parent = makeTempDir("sorage-preflight-e2e-file-");
    const fileHome = join(parent, "not-a-directory");
    writeFileSync(fileHome, "file");
    const fileBefore = storageProof(fileHome);
    const fileRun = sorage(["preflight", "--json"], { home: fileHome });
    const fileBody = JSON.parse(fileRun.stdout) as { ok: boolean; data: { status: string } };
    expect(fileBody.ok).toBe(true);
    expect(fileBody.data.status).toBe("unverifiable");
    expect(fileRun.status).toBe(75);
    expect(storageProof(fileHome)).toEqual(fileBefore);
  });
});
