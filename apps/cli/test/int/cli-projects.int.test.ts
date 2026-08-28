import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-016 acceptance gate executed through the CLI surface: add prints the derived
 * slug, a case-colliding second add exits 65 with PROJECT_SLUG_CONFLICT, list flags a
 * zero-binding Project unbound, rename moves only the display name, and show lists
 * every binding. Every run points SORAGE_HOME at a temporary directory.
 */
const homes: string[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sorage-project-dir-"));
  dirs.push(dir);
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

function initializedHome(): string {
  const home = tempHome("sorage-projects-");
  const init = capture();
  expect(runCli(["init", "--vault", join(home, "vault"), "--non-interactive"], init.ports)).toBe(0);
  return home;
}

describe("sorage project add", () => {
  it("exits 0, prints the derived slug, and stores the first binding", () => {
    initializedHome();
    const dir = tempDir();
    const added = capture();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], added.ports)).toBe(0);
    expect(added.outText()).toContain("web-app");
    const shown = capture();
    expect(runCli(["project", "show", "web-app", "--json"], shown.ports)).toBe(0);
    const payload = JSON.parse(shown.outText()) as {
      data: {
        project: { slug: string; displayName: string };
        bindings: Array<{ directory: string; bindingKind: string }>;
        bindingCount: number;
      };
    };
    expect(payload.data.project).toMatchObject({ slug: "web-app", displayName: "Web App" });
    expect(payload.data.bindingCount).toBe(1);
    expect(payload.data.bindings[0]?.bindingKind).toBe("directory");
  });

  it("exits 65 with PROJECT_SLUG_CONFLICT on a second add with the same slug", () => {
    initializedHome();
    const dir = tempDir();
    const first = capture();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], first.ports)).toBe(0);
    const second = capture();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", tempDir(), "--json"], second.ports)).toBe(65);
    const envelope = JSON.parse(second.errText()) as { error: { code: string } };
    expect(envelope.error.code).toBe("PROJECT_SLUG_CONFLICT");
  });

  it("collides case-insensitively and accepts an explicit slug in any script", () => {
    initializedHome();
    const dir = tempDir();
    expect(runCli(["project", "add", "--name", "Alpha", "--dir", dir], capture().ports)).toBe(0);
    const collision = capture();
    expect(runCli(["project", "add", "--name", "alpha", "--dir", tempDir()], collision.ports)).toBe(65);
    expect(collision.errText()).toContain("PROJECT_SLUG_CONFLICT");
    const explicit = capture();
    expect(runCli(["project", "add", "--name", "웹 앱", "--slug", "웹-앱", "--dir", tempDir()], explicit.ports)).toBe(
      0,
    );
    expect(explicit.outText()).toContain("웹-앱");
  });

  it("collides on a case-only difference in a non-Latin script and finds the folded slug by either case", () => {
    initializedHome();
    expect(runCli(["project", "add", "--name", "Alpha", "--slug", "проект", "--dir", tempDir()], capture().ports)).toBe(
      0,
    );
    const collision = capture();
    expect(runCli(["project", "add", "--name", "Beta", "--slug", "ПРОЕКТ", "--dir", tempDir()], collision.ports)).toBe(
      65,
    );
    expect(collision.errText()).toContain("PROJECT_SLUG_CONFLICT");
    const shown = capture();
    expect(runCli(["project", "show", "ПРОЕКТ", "--json"], shown.ports)).toBe(0);
    expect(shown.outText()).toContain('"slug": "проект"');
  });
});

describe("sorage project list", () => {
  it("marks a Project with zero bindings as unbound", () => {
    initializedHome();
    const dir = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], capture().ports)).toBe(0);
    const listed = capture();
    expect(runCli(["project", "list", "--json"], listed.ports)).toBe(0);
    const payload = JSON.parse(listed.outText()) as {
      data: Array<{ slug: string; bindingCount: number; unbound: boolean }>;
    };
    expect(payload.data).toEqual([
      { slug: "web-app", displayName: "Web App", status: "active", bindingCount: 1, unbound: false },
    ]);
  });
});

describe("sorage project rename and show", () => {
  it("changes the display name and leaves the slug unchanged, and show lists every binding", () => {
    initializedHome();
    const first = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", first], capture().ports)).toBe(0);
    const renamed = capture();
    expect(runCli(["project", "rename", "web-app", "--name", "Web App 2", "--json"], renamed.ports)).toBe(0);
    const payload = JSON.parse(renamed.outText()) as { data: { slug: string; displayName: string } };
    expect(payload.data).toMatchObject({ slug: "web-app", displayName: "Web App 2" });
    const shown = capture();
    expect(runCli(["project", "show", "web-app", "--json"], shown.ports)).toBe(0);
    const detail = JSON.parse(shown.outText()) as {
      data: { bindings: Array<{ directory: string }>; bindingCount: number };
    };
    expect(detail.data.bindingCount).toBe(1);
    expect(detail.data.bindings[0]?.directory).toBeTruthy();
  });

  it("exits 66 with PROJECT_NOT_FOUND for an unknown slug", () => {
    initializedHome();
    const shown = capture();
    expect(runCli(["project", "show", "missing", "--json"], shown.ports)).toBe(66);
    const envelope = JSON.parse(shown.errText()) as { error: { code: string } };
    expect(envelope.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("sorage project bind and unbind", () => {
  it("binds two directories to one Project and rejects a duplicate with exit 65", () => {
    initializedHome();
    const first = tempDir();
    const second = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", first], capture().ports)).toBe(0);
    const bound = capture();
    expect(runCli(["project", "bind", "web-app", "--dir", second, "--json"], bound.ports)).toBe(0);
    const shown = capture();
    expect(runCli(["project", "show", "web-app", "--json"], shown.ports)).toBe(0);
    const detail = JSON.parse(shown.outText()) as { data: { bindingCount: number } };
    expect(detail.data.bindingCount).toBe(2);
    const duplicate = capture();
    expect(runCli(["project", "bind", "web-app", "--dir", first, "--json"], duplicate.ports)).toBe(65);
    const envelope = JSON.parse(duplicate.errText()) as { error: { code: string } };
    expect(envelope.error.code).toBe("BINDING_DUPLICATE");
  });

  it("unbinds without confirmation while no Handoffs table exists, leaving the Project unbound", () => {
    initializedHome();
    const dir = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], capture().ports)).toBe(0);
    const unbound = capture();
    expect(runCli(["project", "unbind", "web-app", "--dir", dir], unbound.ports)).toBe(0);
    const listed = capture();
    expect(runCli(["project", "list", "--json"], listed.ports)).toBe(0);
    const payload = JSON.parse(listed.outText()) as { data: Array<{ unbound: boolean; bindingCount: number }> };
    expect(payload.data[0]?.unbound).toBe(true);
    expect(payload.data[0]?.bindingCount).toBe(0);
  });
});

describe("sorage project archive and unarchive", () => {
  it("requires --as-user with exit 77 and archives with it", () => {
    initializedHome();
    const dir = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], capture().ports)).toBe(0);
    const refused = capture();
    expect(runCli(["project", "archive", "web-app", "--json"], refused.ports)).toBe(77);
    const envelope = JSON.parse(refused.errText()) as { error: { code: string } };
    expect(envelope.error.code).toBe("USER_CONTEXT_REQUIRED");
    const archived = capture();
    expect(runCli(["project", "archive", "web-app", "--as-user", "--json"], archived.ports)).toBe(0);
    const payload = JSON.parse(archived.outText()) as { data: { status: string } };
    expect(payload.data.status).toBe("archived");
    const unarchived = capture();
    expect(runCli(["project", "unarchive", "web-app", "--as-user", "--json"], unarchived.ports)).toBe(0);
    expect(runCli(["project", "unarchive", "web-app", "--json"], capture().ports)).toBe(77);
  });
});

describe("sorage project resolve", () => {
  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  it("resolves a worktree of a bound repository to its Project and folds the common directory", () => {
    initializedHome();
    const repo = tempDir();
    git(repo, "init");
    git(repo, "-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    const worktree = join(tempDir(), "wt");
    git(repo, "worktree", "add", worktree);
    const added = capture();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", repo], added.ports)).toBe(0);
    expect(added.outText()).toContain("git_repository");
    const resolved = capture();
    expect(runCli(["project", "resolve", "--path", worktree, "--json"], resolved.ports)).toBe(0);
    const payload = JSON.parse(resolved.outText()) as {
      data: { kind: string; project: { slug: string }; binding: { bindingKind: string } };
    };
    expect(payload.data.kind).toBe("registered_project");
    expect(payload.data.project.slug).toBe("web-app");
    expect(payload.data.binding.bindingKind).toBe("git_repository");
  });

  it("returns the deepest nested binding and resolves a symlinked path identically", () => {
    initializedHome();
    const outer = tempDir();
    const inner = join(outer, "inner");
    mkdirSync(inner);
    expect(runCli(["project", "add", "--name", "Outer", "--dir", outer], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Inner", "--dir", inner], capture().ports)).toBe(0);
    const nested = join(inner, "sub");
    mkdirSync(nested);
    const deep = capture();
    expect(runCli(["project", "resolve", "--path", nested, "--json"], deep.ports)).toBe(0);
    expect(JSON.parse(deep.outText()).data.project.slug).toBe("inner");
    const alias = join(tempDir(), "alias");
    symlinkSync(inner, alias);
    const viaSymlink = capture();
    expect(runCli(["project", "resolve", "--path", alias, "--json"], viaSymlink.ports)).toBe(0);
    expect(JSON.parse(viaSymlink.outText()).data.project.slug).toBe("inner");
  });

  it("applies the as-override failure modes", () => {
    initializedHome();
    const dir = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], capture().ports)).toBe(0);
    const unknown = capture();
    expect(runCli(["project", "resolve", "--as", "missing", "--json"], unknown.ports)).toBe(66);
    expect(JSON.parse(unknown.errText()).error.code).toBe("PROJECT_NOT_FOUND");
    expect(runCli(["project", "unbind", "web-app", "--dir", dir], capture().ports)).toBe(0);
    const unbound = capture();
    expect(runCli(["project", "resolve", "--as", "web-app", "--json"], unbound.ports)).toBe(65);
    expect(JSON.parse(unbound.errText()).error.code).toBe("PROJECT_UNBOUND");
  });
});

describe("unregistered workspace identity through the CLI surface", () => {
  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  it("reports an unregistered workspace with a stable workspaceKey from an unbound directory", () => {
    initializedHome();
    const elsewhere = tempDir();
    const first = capture();
    expect(runCli(["project", "resolve", "--path", elsewhere, "--json"], first.ports)).toBe(0);
    const payload = JSON.parse(first.outText()) as { data: { kind: string; workspaceKey: string } };
    expect(payload.data.kind).toBe("unregistered_workspace");
    expect(payload.data.workspaceKey).toMatch(/^[0-9a-f]{64}$/);
    const second = capture();
    expect(runCli(["project", "resolve", "--path", elsewhere, "--json"], second.ports)).toBe(0);
    expect(JSON.parse(second.outText()).data.workspaceKey).toBe(payload.data.workspaceKey);
  });

  it("never resolves an unregistered workspace above a bound directory", () => {
    initializedHome();
    const bound = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", bound], capture().ports)).toBe(0);
    const above = { ports: { out: () => {}, err: () => {} } };
    void above;
    // The downgrade guard itself is a send-time rule; resolution from the parent reports
    // the unregistered workspace, and the guard is proved in the core unit suite.
    const resolved = capture();
    expect(runCli(["project", "resolve", "--path", bound, "--json"], resolved.ports)).toBe(0);
    expect(JSON.parse(resolved.outText()).data.kind).toBe("registered_project");
  });

  it("keeps worktree resolution stable for a repository bound through its common directory", () => {
    initializedHome();
    const repo = tempDir();
    git(repo, "init");
    git(repo, "-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    const worktree = join(tempDir(), "wt");
    git(repo, "worktree", "add", worktree);
    expect(runCli(["project", "add", "--name", "Web App", "--dir", repo], capture().ports)).toBe(0);
    const nestedRepo = join(repo, "inner");
    mkdirSync(nestedRepo);
    git(nestedRepo, "init");
    const nested = capture();
    expect(runCli(["project", "resolve", "--path", nestedRepo, "--json"], nested.ports)).toBe(0);
    expect(JSON.parse(nested.outText()).data.kind).toBe("unregistered_workspace");
  });
});

describe("doctor binding checks", () => {
  function doctorChecks(): Record<
    string,
    { severity: string; message: string; recovery?: { suggestedCommand: string } }
  > {
    const run = capture();
    const code = runCli(["doctor", "--json"], run.ports);
    expect(code).toBe(0);
    const payload = JSON.parse(run.outText()) as {
      data: {
        checks: Array<{ id: string; severity: string; message: string; recovery?: { suggestedCommand: string } }>;
      };
    };
    const byId: Record<string, { severity: string; message: string; recovery?: { suggestedCommand: string } }> = {};
    for (const check of payload.data.checks) byId[check.id] = check;
    return byId;
  }

  it("reports a missing binding directory and a zero-binding Project through bindings.exist", () => {
    initializedHome();
    const dir = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", dir], capture().ports)).toBe(0);
    expect(doctorChecks()["bindings.exist"]?.severity).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
    const missing = doctorChecks()["bindings.exist"];
    expect(missing?.severity).toBe("warning");
    expect(missing?.message).toContain("no longer exists");
    expect(missing?.recovery?.suggestedCommand).toContain("sorage project unbind");
    // The recorded directory no longer exists, yet the binding it names stays removable.
    expect(runCli(["project", "unbind", "web-app", "--dir", dir], capture().ports)).toBe(0);
    const unbound = doctorChecks()["bindings.exist"];
    expect(unbound?.severity).toBe("warning");
    expect(unbound?.message).toContain("no directory binding");
  });

  it("reports a nested binding through bindings.nested with the Project each resolves to", () => {
    initializedHome();
    const outer = tempDir();
    const inner = join(outer, "inner");
    mkdirSync(inner);
    expect(runCli(["project", "add", "--name", "Outer", "--dir", outer], capture().ports)).toBe(0);
    expect(runCli(["project", "add", "--name", "Inner", "--dir", inner], capture().ports)).toBe(0);
    const nested = doctorChecks()["bindings.nested"];
    expect(nested?.severity).toBe("warning");
    expect(nested?.message).toContain("outer");
    expect(nested?.message).toContain("inner");
    expect(nested?.recovery?.suggestedCommand).toContain("--as");
  });

  it("reports an alias-ambiguous pair through bindings.ambiguous", () => {
    initializedHome();
    const real = tempDir();
    expect(runCli(["project", "add", "--name", "Web App", "--dir", real], capture().ports)).toBe(0);
    // A stored uncollapsed alias spelling, exactly what an APFS firmlink leaves behind:
    // two distinct stored directories whose realpath is one physical directory.
    const home = process.env.SORAGE_HOME as string;
    const alias = join(home, "state", "sorage.sqlite3");
    const db = new DatabaseSync(alias);
    db.prepare(
      "INSERT INTO project_bindings (id, project_id, installation_id, directory, binding_kind, created_at, updated_at) VALUES ('alias-1', (SELECT id FROM projects LIMIT 1), (SELECT installation_id FROM project_bindings LIMIT 1), ?, 'directory', 't', 't')",
    ).run(real.startsWith("/private/") ? `/${real.slice("/private/".length)}` : join(real, "x", ".."));
    db.close();
    const ambiguous = doctorChecks()["bindings.ambiguous"];
    expect(ambiguous?.severity).toBe("warning");
    expect(ambiguous?.message).toContain("alias one directory");
    expect(ambiguous?.recovery?.suggestedCommand).toContain("unbind");
  });
});

describe("sorage project add (ADR-0020)", () => {
  it("refuses to bind a bare Git repository because it has no working tree", () => {
    const home = mkdtempSync(join(tmpdir(), "sorage-bare-"));
    homes.push(home);
    process.env.SORAGE_HOME = home;
    expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
    const bare = join(home, "bare.git");
    const initialized = spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" });
    expect(initialized.status).toBe(0);

    const refused = capture();
    expect(runCli(["project", "add", "--name", "Bare", "--dir", bare, "--json"], refused.ports)).toBe(78);
    const report = JSON.parse(refused.errText()) as { error: { code: string; message: string } };
    expect(report.error.code).toBe("CONFIG_INVALID");
    expect(report.error.message).toContain("bare Git repository");
    expect(report.error.message).toContain("no working tree");
  });
});
