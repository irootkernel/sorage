import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/main";

/** The shipped Channel catalog is the nine executable leaf commands; group commands are not catalog entries. */
const catalogPath = fileURLToPath(new URL("../../../../skills/use-sorage/references/channels.md", import.meta.url));

interface CatalogLine {
  path: string;
  flags: string[];
  text: string;
}

function buildProgramForTest(): Command {
  return buildProgram({ out: () => {}, err: () => {} });
}

/** The root long flags the real program registers, read from `buildProgram` rather than restated by hand. */
function rootFlagsOf(program: Command): Set<string> {
  return new Set(
    program.options
      .map((option) => option.long)
      .filter((flag): flag is string => flag !== undefined && flag !== "--help"),
  );
}

function channelGroupOf(program: Command): Command {
  const group = program.commands.find((command) => command.name() === "channel");
  if (group === undefined) throw new Error("the channel command group is not registered");
  return group;
}

/** Collects the executable leaf paths (`create`, `participant add`, ...) without the group commands or `help`. */
function leafCommandsOf(group: Command): Map<string, Command> {
  const leaves = new Map<string, Command>();
  for (const command of group.commands) {
    if (command.name() === "help") continue;
    const nested = command.commands.filter((child) => child.name() !== "help");
    if (nested.length === 0) {
      leaves.set(command.name(), command);
      continue;
    }
    for (const leaf of nested) leaves.set(`${command.name()} ${leaf.name()}`, leaf);
  }
  return leaves;
}

function flagOf(command: Command): string[] {
  return command.options
    .map((option) => option.long)
    .filter((flag): flag is string => flag !== undefined && flag !== "--help");
}

/** Parses only catalog bullets and derives each command path and the flags its template names. */
function parseCatalog(text: string): CatalogLine[] {
  const lines: CatalogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("- `sorage channel ")) continue;
    const template = line.match(/^- `(sorage channel [^`]+)`/)?.[1];
    if (template === undefined) continue;
    const tokens = template.split(/\s+/).slice(2);
    const pathTokens: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("<") || token.startsWith("[") || token.startsWith("(") || token.startsWith("--")) break;
      pathTokens.push(token);
    }
    lines.push({
      path: pathTokens.join(" "),
      flags: [...line.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]),
      text: line,
    });
  }
  return lines;
}

const catalog = parseCatalog(readFileSync(catalogPath, "utf8"));
const program = buildProgramForTest();
const leaves = leafCommandsOf(channelGroupOf(program));
const rootFlags = rootFlagsOf(program);
const catalogByPath = new Map<string, CatalogLine[]>();
for (const line of catalog) catalogByPath.set(line.path, [...(catalogByPath.get(line.path) ?? []), line]);
const flagsOf = (path: string): string[] => (catalogByPath.get(path) ?? []).flatMap((line) => line.flags);

describe("the shipped Channel catalog", () => {
  it("covers exactly the executable leaf Channel commands", () => {
    expect([...catalogByPath.keys()].sort()).toEqual([...leaves.keys()].sort());
  });

  it("names only root globals the real program defines", () => {
    for (const [path, command] of leaves) {
      const local = new Set(flagOf(command));
      for (const line of catalogByPath.get(path) ?? []) {
        for (const flag of line.flags) {
          expect(local.has(flag) || rootFlags.has(flag), `${path} ${flag}`).toBe(true);
        }
      }
    }
  });

  it("documents exactly each leaf command's local options, leaving root globals to their own checks", () => {
    for (const [path, command] of leaves) {
      const real = new Set(flagOf(command));
      // A real root global is compared only where the command declares it locally, like
      // handle's required --expected-row-version; the remaining globals are checked root-side.
      const rootOnly = new Set([...rootFlags].filter((flag) => !real.has(flag)));
      const documented = new Set(flagsOf(path).filter((flag) => !rootOnly.has(flag)));
      expect([...documented].sort(), path).toEqual([...real].sort());
    }
  });

  it("registers every root global the rebuilt Channel catalog uses", () => {
    for (const flag of ["--json", "--limit"]) {
      expect([...rootFlags], flag).toContain(flag);
    }
  });

  it("carries the rebuilt surface's globals on exactly the documented commands", () => {
    for (const line of catalog) expect(line.flags, line.text).toContain("--json");
    for (const path of leaves.keys()) {
      const flags = flagsOf(path);
      if (path === "messages") {
        expect(flags, path).toContain("--limit");
      } else {
        expect(flags, path).not.toContain("--limit");
      }
    }
    // The removed machinery never returns: no cursor, no version comparison, no
    // participant assertion, no keys, no replay-only, no confirmation.
    const excluded = [
      "--cursor",
      "--expected-row-version",
      "--as-user",
      "--as-participant",
      "--idempotency-key",
      "--replay-only",
      "--confirm",
      "--confirm-pinned",
      "--expected-revision",
      "--target-revision",
      "--supersedes",
      "--allow-external-source",
      "--allow-unregistered",
    ];
    for (const flag of excluded)
      expect(
        catalog.filter((line) => line.flags.includes(flag)),
        flag,
      ).toEqual([]);
  });

  it("keeps each messages template's options coherent with waiting mode", () => {
    for (const line of catalogByPath.get("messages") ?? []) {
      if (line.flags.includes("--wait")) {
        expect(line.flags, line.text).not.toContain("--all");
      } else {
        expect(line.flags, line.text).not.toContain("--interval");
        expect(line.flags, line.text).not.toContain("--timeout");
      }
    }
  });
});
