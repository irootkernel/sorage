import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeInboxMarkerPorts } from "@sorage/adapters/src/inbox-marker-ports";
import { acquireLock, createNodeLockProbePorts } from "@sorage/adapters/src/lockfile";
import { reconcileReboundInboxMarker } from "@sorage/core";
import { runCli } from "../../src/main";

/**
 * The derived inbox marker of TASK-038 (HND-026) through the real CLI: the default
 * `false` writes nothing anywhere, enabling the key rewrites `.sorage/INBOX.md`
 * under every recipient binding directory on each creation and state change, a
 * deleted marker is recreated by the next state change, a corrupted marker changes
 * no command result, and a marker that cannot be written only warns.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) {
      chmodSync(join(home, "work-b2"), 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  }
  delete process.env.SORAGE_HOME;
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ports: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    outText(): string {
      return out.join("");
    },
    errText(): string {
      return err.join("");
    },
  };
}

function run(args: string[]): { exit: number; err: string } {
  const cap = capture();
  const exit = runCli(args, cap.ports);
  return { exit, err: cap.errText() };
}

function fixture(): { home: string; workA: string; workB1: string; workB2: string } {
  const home = tempHome("sorage-marker-");
  const workA = join(home, "work-a");
  const workB1 = join(home, "work-b1");
  const workB2 = join(home, "work-b2");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB1, { recursive: true });
  mkdirSync(workB2, { recursive: true });
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", workA], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Beta", "--dir", workB1], capture().ports)).toBe(0);
  expect(runCli(["project", "bind", "beta", "--dir", workB2], capture().ports)).toBe(0);
  return { home, workA, workB1, workB2 };
}

function send(title: string): string {
  const cap = capture();
  const exit = runCli(
    ["send", "--as", "alpha", "--to", "beta", "--title", title, "--body", `# ${title}`, "--json"],
    cap.ports,
  );
  expect(exit).toBe(0);
  return (JSON.parse(cap.outText()) as { data: { handoffs: Array<{ handoffId: string }> } }).data.handoffs[0]
    ?.handoffId as string;
}

const markerOf = (dir: string): string => join(dir, ".sorage", "INBOX.md");

describe("the derived inbox marker behind handoff.inboxMarker", () => {
  it("writes nothing anywhere while the key is at its default of false", () => {
    const { home, workB1, workB2 } = fixture();
    send("Default off");
    expect(existsSync(markerOf(workB1))).toBe(false);
    expect(existsSync(markerOf(workB2))).toBe(false);
    expect(existsSync(join(home, "work-a", ".sorage"))).toBe(false);
  });

  it("rewrites the marker under every recipient binding on creation and each state change", () => {
    const { workB1, workB2 } = fixture();
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const id = send("Marker case");
    for (const dir of [workB1, workB2]) {
      const marker = readFileSync(markerOf(dir), "utf8");
      expect(marker).toContain(`${id} awaiting_recipient "Marker case" revision 1`);
    }
    expect(run(["review", "set", id, "--as", "beta", "--text", "Rework"]).exit).toBe(0);
    expect(readFileSync(markerOf(workB1), "utf8")).toContain(`${id} changes_requested "Marker case" revision 1`);
    expect(run(["revise", id, "--as", "alpha", "--no-change", "--reason", "Done elsewhere"]).exit).toBe(0);
    // A no-change resolution resolves the Note without moving the Revision (REV-017).
    expect(readFileSync(markerOf(workB1), "utf8")).toContain(`${id} awaiting_recipient "Marker case" revision 1`);
    expect(run(["accept", id, "--as", "beta", "--expected-revision", "1", "--expected-row-version", "3"]).exit).toBe(0);
    expect(readFileSync(markerOf(workB1), "utf8")).toContain(`${id} accepted "Marker case" revision 1`);
    expect(readFileSync(markerOf(workB2), "utf8")).toBe(readFileSync(markerOf(workB1), "utf8"));
  });

  it("recreates a deleted marker on the next state change", () => {
    const { workB1 } = fixture();
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const id = send("Recreate case");
    rmSync(markerOf(workB1));
    expect(existsSync(markerOf(workB1))).toBe(false);
    expect(run(["pin", id, "--as-user"]).exit).toBe(0);
    expect(existsSync(markerOf(workB1))).toBe(true);
    expect(readFileSync(markerOf(workB1), "utf8")).toContain(id);
  });

  it("commits a new binding when advisory marker lock contention times out", () => {
    const { home } = fixture();
    const extra = join(home, "extra-binding");
    mkdirSync(extra);
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const held = acquireLock({
      path: join(home, "run", "inbox-marker.lock"),
      lock: "inbox-marker",
      ports: createNodeLockProbePorts(),
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    try {
      const bound = run(["project", "bind", "beta", "--dir", extra]);
      expect(bound.exit).toBe(0);
      expect(bound.err).toContain("warning:");
    } finally {
      held.release();
    }
    const markerPorts = createNodeInboxMarkerPorts();
    const beta = markerPorts.projectPorts.projects.findProjectBySlug("beta");
    expect(beta.ok && beta.value !== null).toBe(true);
    if (!beta.ok || beta.value === null) return;
    const bindings = markerPorts.projectPorts.projects.listBindingsForProject(beta.value.id);
    expect(bindings.ok && bindings.value.some((binding) => binding.directory === realpathSync(extra))).toBe(true);
  });

  it("moves the derived marker when a recipient binding is rebound", () => {
    const { home, workB1, workB2 } = fixture();
    const workB3 = join(home, "work-b3");
    mkdirSync(workB3);
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const id = send("Rebound marker");
    expect(existsSync(markerOf(workB1))).toBe(true);
    const moved = run(["project", "rebind", "beta", "--from", workB1, "--to", workB3]);
    expect(moved.exit).toBe(0);
    expect(existsSync(markerOf(workB1))).toBe(false);
    expect(readFileSync(markerOf(workB3), "utf8")).toContain(id);
    expect(readFileSync(markerOf(workB2), "utf8")).toContain(id);
    expect(existsSync(join(home, "run", "inbox-marker.lock"))).toBe(false);
  });

  it("preserves the current owner's marker when retired-path cleanup is delayed", () => {
    const { home, workB1 } = fixture();
    const workB3 = join(home, "work-b3");
    mkdirSync(workB3);
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    send("Beta before move");
    const markerPorts = createNodeInboxMarkerPorts();
    const beta = markerPorts.projectPorts.projects.findProjectBySlug("beta");
    expect(beta.ok && beta.value !== null).toBe(true);
    if (!beta.ok || beta.value === null) return;
    expect(run(["project", "rebind", "beta", "--from", workB1, "--to", workB3]).exit).toBe(0);
    expect(run(["project", "add", "--name", "Gamma", "--dir", workB1]).exit).toBe(0);
    expect(readFileSync(markerOf(workB1), "utf8")).toContain("(no open Handoffs)");
    expect(run(["send", "--as", "alpha", "--to", "gamma", "--title", "Gamma inbox", "--body", "# Gamma"]).exit).toBe(0);
    const gammaMarker = readFileSync(markerOf(workB1), "utf8");
    expect(gammaMarker).toContain("Gamma inbox");
    const delayed = reconcileReboundInboxMarker(markerPorts, beta.value.id, realpathSync(workB1), realpathSync(workB3));
    expect(delayed.ok).toBe(true);
    expect(readFileSync(markerOf(workB1), "utf8")).toBe(gammaMarker);
  });

  it("replaces a retired marker with a new owner's empty inbox after path reuse", () => {
    const { home, workB1 } = fixture();
    const workB3 = join(home, "work-b3");
    mkdirSync(workB3);
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const betaHandoff = send("Beta before reuse");
    const stale = readFileSync(markerOf(workB1), "utf8");
    const markerPorts = createNodeInboxMarkerPorts();
    const beta = markerPorts.projectPorts.projects.findProjectBySlug("beta");
    expect(beta.ok && beta.value !== null).toBe(true);
    if (!beta.ok || beta.value === null) return;
    expect(run(["project", "rebind", "beta", "--from", workB1, "--to", workB3]).exit).toBe(0);
    expect(run(["project", "add", "--name", "Gamma", "--dir", workB1]).exit).toBe(0);
    writeFileSync(markerOf(workB1), stale);
    const delayed = reconcileReboundInboxMarker(markerPorts, beta.value.id, realpathSync(workB1), realpathSync(workB3));
    expect(delayed.ok).toBe(true);
    expect(readFileSync(markerOf(workB1), "utf8")).toContain("(no open Handoffs)");
    expect(readFileSync(markerOf(workB1), "utf8")).not.toContain(betaHandoff);
  });

  it("keeps the marker when a binding changes kind at the same stored directory", () => {
    const { workB1 } = fixture();
    expect(spawnSync("git", ["init", workB1], { encoding: "utf8" }).status).toBe(0);
    expect(run(["project", "rebind", "beta", "--from", workB1, "--to", workB1]).exit).toBe(0);
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const id = send("Same path marker");
    const common = join(workB1, ".git");
    expect(readFileSync(markerOf(common), "utf8")).toContain(id);
    rmSync(join(common, "HEAD"));
    expect(run(["project", "rebind", "beta", "--from", common, "--to", common]).exit).toBe(0);
    expect(readFileSync(markerOf(common), "utf8")).toContain(id);
  });

  it("never becomes authority: a corrupted marker changes no command result", () => {
    const { workB1 } = fixture();
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    const id = send("Corrupt case");
    writeFileSync(markerOf(workB1), "\x00 totally garbage \x00", "utf8");
    const inbox = capture();
    expect(runCli(["inbox", "--as", "beta", "--json"], inbox.ports)).toBe(0);
    expect(inbox.outText()).toContain(id);
    expect(run(["accept", id, "--as", "beta", "--expected-revision", "1", "--expected-row-version", "1"]).exit).toBe(0);
    expect(run(["get", id, "--as", "beta"]).exit).toBe(0);
  });

  it("warns without failing the command when a binding directory rejects the write", () => {
    const { workB2 } = fixture();
    expect(run(["config", "set", "handoff.inboxMarker", "true", "--as-user"]).exit).toBe(0);
    chmodSync(workB2, 0o500);
    const id = send("Read-only case");
    expect(existsSync(markerOf(workB2))).toBe(false);
    expect(run(["review", "set", id, "--as", "beta", "--text", "Note"]).exit).toBe(0);
    expect(run(["review", "withdraw", id, "--as", "beta"]).exit).toBe(0);
    const accept = run(["accept", id, "--as", "beta", "--expected-revision", "1", "--expected-row-version", "3"]);
    expect(accept.exit).toBe(0);
    expect(accept.err).toContain("warning:");
    expect(accept.err).toContain("inbox marker");
  });
});
