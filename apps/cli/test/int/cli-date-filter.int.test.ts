import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main";

/**
 * The TASK-067 date-filter proof (WEB-003, CLI-009): the inclusive
 * `updatedSince` and `updatedUntil` bounds ride the same cursor filter set as
 * every other filter, so a Web, CLI, or API listing carrying the same bound
 * returns the same rows, a cursor minted under one bound set fails with
 * CURSOR_INVALID under another, and a malformed or reversed bound fails
 * validation before any listing runs.
 */
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
  delete process.env.SORAGE_HOME;
});

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

function seeded(): { home: string; alpha: string } {
  const home = mkdtempSync(join(tmpdir(), "sorage-datefilter-"));
  homes.push(home);
  process.env.SORAGE_HOME = home;
  const alpha = join(home, "alpha");
  mkdirSync(alpha, { recursive: true });
  expect(runCli(["init", "--non-interactive"], capture().ports)).toBe(0);
  expect(runCli(["project", "add", "--name", "Alpha", "--dir", alpha], capture().ports)).toBe(0);
  const document = join(home, "brief.md");
  writeFileSync(document, "# brief\n");
  const second = join(home, "second.md");
  writeFileSync(second, "# second\n");
  const send = capture();
  expect(
    runCli(
      ["send", "--to", "alpha", "--title", "Dated", "--file", document, "--allow-external-source", "--json"],
      send.ports,
    ),
  ).toBe(0);
  // A second Handoff so a one-row page overflows and mints a cursor.
  const send2 = capture();
  expect(
    runCli(
      ["send", "--to", "alpha", "--title", "Also dated", "--file", second, "--allow-external-source", "--json"],
      send2.ports,
    ),
  ).toBe(0);
  return { home, alpha };
}

describe("the WEB-003 date bounds", () => {
  it("return the same rows through the CLI bound flags and reject a mismatched cursor", () => {
    const { alpha } = seeded();
    const bounded = capture();
    expect(
      runCli(
        [
          "inbox",
          "--json",
          "--as",
          "alpha",
          "--updated-since",
          "2000-01-01T00:00:00Z",
          "--updated-until",
          "2999-01-01T00:00:00Z",
        ],
        bounded.ports,
      ),
    ).toBe(0);
    const listed = JSON.parse(bounded.outText()) as {
      data: { handoffs: unknown[]; nextCursor: string | null };
    };
    expect(listed.data.handoffs.length).toBe(2);

    const empty = capture();
    expect(runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "2999-01-01T00:00:00Z"], empty.ports)).toBe(
      0,
    );
    expect((JSON.parse(empty.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(0);

    // A cursor minted with one bound set fails under another: the bounds are
    // part of the filter hash exactly like state and sender.
    const paged = capture();
    expect(
      runCli(
        ["inbox", "--json", "--as", "alpha", "--limit", "1", "--updated-since", "2000-01-01T00:00:00Z"],
        paged.ports,
      ),
    ).toBe(0);
    const cursor = (JSON.parse(paged.outText()) as { data: { nextCursor: string | null } }).data.nextCursor;
    expect(cursor).not.toBeNull();
    const mismatched = capture();
    const code = runCli(
      ["inbox", "--json", "--as", "alpha", "--cursor", cursor as string, "--updated-until", "2999-01-01T00:00:00Z"],
      mismatched.ports,
    );
    expect(code).toBe(64);
    expect(mismatched.errText()).toContain("CURSOR_INVALID");
  });

  it("keeps the whole-second boundary inclusive against fractional rows", () => {
    const { alpha } = seeded();
    // The stored updatedAt always carries milliseconds; a whole-second bound
    // must not lexicographically exclude rows inside its own boundary second.
    const since = capture();
    expect(runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "2000-01-01T00:00:00Z"], since.ports)).toBe(
      0,
    );
    expect((JSON.parse(since.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(2);
    // A fractional bound and its equal-instant whole-second spelling agree.
    const fractional = capture();
    expect(
      runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "2000-01-01T00:00:00.000Z"], fractional.ports),
    ).toBe(0);
    expect((JSON.parse(fractional.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(2);
    // Mixed shapes compare as instants, not strings.
    const mixed = capture();
    expect(
      runCli(
        [
          "inbox",
          "--json",
          "--as",
          "alpha",
          "--updated-since",
          "2000-01-01T00:00:00Z",
          "--updated-until",
          "2999-01-01T00:00:00.001Z",
        ],
        mixed.ports,
      ),
    ).toBe(0);
    expect((JSON.parse(mixed.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(2);
    // A sub-millisecond zero tail names the same instant and stays accepted.
    const tail = capture();
    expect(
      runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "2000-01-01T00:00:00.0000Z"], tail.ports),
    ).toBe(0);
    expect((JSON.parse(tail.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(2);
    // One- and two-digit zero fractions name their whole millisecond.
    for (const shortFraction of ["2000-01-01T00:00:00.0Z", "2000-01-01T00:00:00.00Z"]) {
      const shortRun = capture();
      expect(runCli(["inbox", "--json", "--as", "alpha", "--updated-since", shortFraction], shortRun.ports)).toBe(0);
      expect((JSON.parse(shortRun.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(2);
    }
    // A sub-millisecond remainder is refused rather than silently reshaped.
    const halfMillisecond = capture();
    expect(
      runCli(
        ["inbox", "--json", "--as", "alpha", "--updated-until", "2999-01-01T00:00:00.0005Z"],
        halfMillisecond.ports,
      ),
    ).not.toBe(0);
    expect(halfMillisecond.errText()).toContain("finer than one millisecond");
    // An impossible calendar value is a configuration error, not an empty page.
    const impossible = capture();
    expect(
      runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "9999-99-99T99:99:99Z"], impossible.ports),
    ).not.toBe(0);
    expect(impossible.errText()).toContain("not a real UTC instant");
  });

  it("keeps the whole-second until boundary inclusive on its own second", () => {
    const { alpha } = seeded();
    // `until` at a past whole second excludes rows created now; `since` at a
    // future whole second excludes them too; both prove the until comparison
    // actually bounds instead of always passing.
    const excluded = capture();
    expect(
      runCli(["inbox", "--json", "--as", "alpha", "--updated-until", "2000-01-01T00:00:00Z"], excluded.ports),
    ).toBe(0);
    expect((JSON.parse(excluded.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(0);
    const futureSince = capture();
    expect(
      runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "2999-01-01T00:00:00Z"], futureSince.ports),
    ).toBe(0);
    expect((JSON.parse(futureSince.outText()) as { data: { handoffs: unknown[] } }).data.handoffs.length).toBe(0);
  });

  it("validates the bounds on the wait surface too", () => {
    const { alpha } = seeded();
    const wait = capture();
    const code = runCli(
      ["inbox", "--wait", "--timeout", "1", "--json", "--as", "alpha", "--updated-since", "garbage"],
      wait.ports,
    );
    expect(code).not.toBe(0);
    expect(wait.errText()).toContain("ISO-8601");
  });

  it("reject malformed and reversed bounds before any listing runs", () => {
    const { alpha } = seeded();
    const malformed = capture();
    expect(runCli(["inbox", "--json", "--as", "alpha", "--updated-since", "yesterday"], malformed.ports)).not.toBe(0);
    expect(malformed.errText()).toContain("ISO-8601");
    const reversed = capture();
    expect(
      runCli(
        [
          "inbox",
          "--json",
          "--as",
          "alpha",
          "--updated-since",
          "2999-01-01T00:00:00Z",
          "--updated-until",
          "2000-01-01T00:00:00Z",
        ],
        reversed.ports,
      ),
    ).not.toBe(0);
    expect(reversed.errText()).toContain("updatedSince");
  });
});
