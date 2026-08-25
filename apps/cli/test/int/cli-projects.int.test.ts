import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
