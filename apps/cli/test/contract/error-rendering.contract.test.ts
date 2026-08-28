import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The TASK-037 contract over the whole symbolic error catalogue: every code's exit
 * category, HTTP status, and recovery presence must match the section 15 and 16
 * tables of interfaces-and-operations.md in both directions, and both renderings —
 * the JSON error envelope and the human `CODE: message` / `Recovery:` lines — are
 * pinned by one generated golden. Refresh the golden by running once with
 * SORAGE_UPDATE_GOLDENS=1 and reviewing the diff.
 *
 * The renderers are loaded through a dynamic import after the environment is pinned,
 * because the CLI reads its deterministic request id and home at module scope.
 */
process.env.SORAGE_TEST_REQUEST_ID = "2f0ac9a0-0000-4000-8000-0000000000aa";
const home = mkdtempSync(join(tmpdir(), "sorage-error-rendering-"));
process.env.SORAGE_HOME = home;

const core = await import("@sorage/core");
const cli = await import("../../src/main");

const docsPath = fileURLToPath(new URL("../../../../docs/interfaces-and-operations.md", import.meta.url));
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));
const updateGoldens = process.env.SORAGE_UPDATE_GOLDENS === "1";

afterAll(() => {
  if (!updateGoldens) rmSync(home, { recursive: true, force: true });
});

interface DocsRow {
  code: string;
  httpStatus: number;
  recovery: string;
}

function parseSection15(): Map<string, DocsRow> {
  const text = readFileSync(docsPath, "utf8");
  const section = text.slice(text.indexOf("## 15. Symbolic error codes"), text.indexOf("## 16. Exit codes"));
  const rows = new Map<string, DocsRow>();
  for (const match of section.matchAll(/^\| `([A-Z_]+)` \| (\d+) \| [^|]+ \| (.+) \|$/gm)) {
    const [, code, status, recovery] = match;
    rows.set(code as string, {
      code: code as string,
      httpStatus: Number(status),
      recovery: (recovery as string).trim(),
    });
  }
  return rows;
}

function parseSection16(): Map<string, number> {
  const text = readFileSync(docsPath, "utf8");
  const section = text.slice(text.indexOf("## 16. Exit codes"), text.indexOf("## 17."));
  const exits = new Map<string, number>();
  for (const match of section.matchAll(/^\| (\d+) \| [^|]+ \| (.+) \|$/gm)) {
    const exit = Number(match[1]);
    for (const code of (match[2] as string).matchAll(/`([A-Z_]+)`/g)) {
      exits.set(code[1] as string, exit);
    }
  }
  return exits;
}

function renderings(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const code of core.ERROR_CODES) {
    const spec = core.errorSpec(code);
    const error = core.appError(code, "rendering probe");
    const json = core.errorEnvelope(error, "2f0ac9a0-0000-4000-8000-0000000000aa");
    const humanOut: string[] = [];
    const humanErr: string[] = [];
    const exit = cli.renderAppError(error, { out: (t) => humanOut.push(t), err: (t) => humanErr.push(t) }, false);
    out.push({
      code,
      exitCode: spec.exitCode,
      httpStatus: spec.httpStatus,
      recovery: spec.recovery ?? null,
      renderedExitCode: exit,
      json,
      human: humanErr.join(""),
    });
  }
  return out;
}

describe("the symbolic error catalogue contract", () => {
  const docs15 = parseSection15();
  const docs16 = parseSection16();
  const codes = core.ERROR_CODES as readonly string[];

  it("keeps the catalogue and the section 15 table in two-way sync", () => {
    const inCodeNotDocs = codes.filter((code) => !docs15.has(code));
    const inDocsNotCode = [...docs15.keys()].filter((code) => !codes.includes(code));
    expect(inCodeNotDocs, "codes emitted but absent from the table").toEqual([]);
    expect(inDocsNotCode, "table rows without a catalogue entry").toEqual([]);
    expect(codes).toHaveLength(49);
  });

  it("maps every code to the HTTP status and recovery the table documents", () => {
    for (const code of codes) {
      const spec = core.errorSpec(code as never);
      const row = docs15.get(code);
      expect(row, `${code} has a section 15 row`).toBeDefined();
      expect(spec.httpStatus, `${code} HTTP status`).toBe(row?.httpStatus);
      expect(spec.recovery, `${code} carries its documented recovery`).toBeDefined();
      expect(row?.recovery ?? "", `${code} documents a recovery`).not.toBe("");
    }
  });

  it("assigns every code the exit category of the section 16 grouping exactly once", () => {
    for (const code of codes) {
      const spec = core.errorSpec(code as never);
      expect(docs16.has(code), `${code} appears in the section 16 grouping`).toBe(true);
      expect(spec.exitCode, `${code} exit category`).toBe(docs16.get(code));
    }
    expect(
      [...docs16.keys()].filter((code) => !codes.includes(code)),
      "no phantom rows",
    ).toEqual([]);
  });

  it("pins both renderings of every code against the golden", () => {
    const rendered = renderings();
    for (const entry of rendered) {
      expect(entry.renderedExitCode, `${entry.code} rendered exit`).toBe(entry.exitCode);
      expect((entry.json as { error: { recovery?: unknown } }).error.recovery).toBeDefined();
      expect(entry.human as string).toContain(`${entry.code}: rendering probe`);
      expect(entry.human as string).toContain("Recovery: ");
    }
    const goldenPath = `${goldenDir}error-renderings.json`;
    const serialized = `${JSON.stringify(rendered, null, 2)}\n`;
    if (updateGoldens) {
      mkdirSync(goldenDir, { recursive: true });
      writeFileSync(goldenPath, serialized);
      return;
    }
    expect(serialized).toBe(readFileSync(goldenPath, "utf8"));
  });
});
