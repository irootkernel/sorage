import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/** Packaging/resource checks only. Actual GEN/HND and Channel decisions require the separate frozen AJ-26 and AJ-29 observers. */
const source = fileURLToPath(new URL("../../skills/use-sorage", import.meta.url));
const checkout = resolve(source, "../..");
const root = mkdtempSync(join(tmpdir(), "sorage-standalone-skill-"));
const copy = join(root, "use-sorage");
cpSync(source, copy, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const skillPath = join(copy, "SKILL.md");
const text = readFileSync(skillPath, "utf8");
const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string);
const references = ["handoffs.md", "project-memos.md", "channels.md"];
const routing =
  text.split("\n\n").find((block) => block.startsWith("Before acting on an explicitly requested domain")) ?? "";

describe("the standalone shipped use-sorage resources", () => {
  it("copies only the shipped directory outside the checkout with valid frontmatter", () => {
    expect(readdirSync(root)).toEqual(["use-sorage"]);
    expect(relative(checkout, copy).startsWith("..")).toBe(true);
    expect(readFileSync(skillPath)).toEqual(readFileSync(join(source, "SKILL.md")));
    expect(text.startsWith("---\n")).toBe(true);
    const frontmatterEnd = text.indexOf("\n---\n", 4);
    expect(frontmatterEnd, "SKILL.md frontmatter must have a closing --- delimiter").toBeGreaterThan(0);
    const frontmatter = text.slice(0, frontmatterEnd);
    expect(frontmatter).toContain("name: use-sorage");
    expect(frontmatter).toMatch(/description: \S/);
  });

  it("ships one required reference per domain and links each from the entrypoint", () => {
    for (const reference of references) {
      const referencePath = join(copy, "references", reference);
      expect(existsSync(referencePath), reference).toBe(true);
      const body = readFileSync(referencePath, "utf8");
      expect(body.trim().length, reference).toBeGreaterThan(0);
      expect(
        body.split("\n").filter((line) => line.startsWith("# ")),
        reference,
      ).toHaveLength(1);
      expect(body.startsWith("# "), reference).toBe(true);
      expect(
        [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string),
        reference,
      ).toContain("../SKILL.md");
    }
    for (const target of ["references/handoffs.md", "references/project-memos.md", "references/channels.md"]) {
      expect(routing, target).toContain(`](${target})`);
    }
  });

  it("resolves every local Markdown resource entirely inside the standalone copy", () => {
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        expect(entry.isSymbolicLink(), path).toBe(false);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".md")) {
          for (const match of readFileSync(path, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
            const target = match[1] as string;
            if (/^https:\/\//.test(target) || target.startsWith("#")) continue;
            expect(isAbsolute(target), target).toBe(false);
            const resolved = resolve(dirname(path), decodeURIComponent(target.split("#")[0] as string));
            expect(relative(copy, resolved).startsWith(".."), target).toBe(false);
            expect(existsSync(resolved), target).toBe(true);
          }
        }
      }
    };
    visit(copy);
  });

  it("checks optional public reference source owners separately from standalone resources", () => {
    const publicLinks = links.filter((link) => link.startsWith("https://"));
    expect(publicLinks.length).toBeGreaterThan(0);
    for (const link of publicLinks) {
      const url = new URL(link);
      expect(url.host).toBe("github.com");
      const prefix = "/irootkernel/sorage/blob/main/";
      expect(url.pathname.startsWith(prefix)).toBe(true);
      expect(existsSync(resolve(checkout, url.pathname.slice(prefix.length))), link).toBe(true);
    }
  });
});

interface PublishedTool {
  name: string;
  inputSchema: {
    required?: string[];
    properties: Record<string, { type: string; items?: { type: string } }>;
  };
}

const published = (
  JSON.parse(readFileSync(join(checkout, "apps/cli/test/contract/golden/mcp-tools.json"), "utf8")) as {
    toolsResult: { tools: PublishedTool[] };
  }
).toolsResult.tools;
const errorCodes = new Set(
  (
    JSON.parse(readFileSync(join(checkout, "apps/cli/test/contract/golden/error-renderings.json"), "utf8")) as {
      code: string;
    }[]
  ).map(({ code }) => code),
);
const errorNamespaces = new Set([...errorCodes].map((code) => code.split("_")[0]));
const resources = new Map(
  ["SKILL.md", ...references.map((name) => `references/${name}`)].map((name) => [
    name,
    readFileSync(join(copy, name), "utf8"),
  ]),
);

/** Only the four-column shipped tool tables are parsed, not arbitrary Markdown. */
function catalogue(files: Map<string, string>) {
  return [...files].flatMap(([file, body]) =>
    [...body.matchAll(/^\| `((?:handoff|memo|channel|project)_[a-z_]+)` \| ([^|]+) \| ([^|]+) \| (.*) \|$/gm)].map(
      ([, name, required, optional]) => ({ file, name: name as string, required, optional }),
    ),
  );
}

function properties(cell: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, token] of (cell ?? "").matchAll(/`([^`]+)`/g)) {
    const parsed = /^([a-zA-Z]+): (string\[\]|integer\[\]|string|integer|boolean)$/.exec(token as string);
    expect(parsed, `invalid property declaration: ${token}`).not.toBeNull();
    const name = parsed?.[1] as string;
    expect(result.has(name), `duplicate property: ${name}`).toBe(false);
    result.set(name, parsed?.[2] as string);
  }
  return result;
}

function assertCatalogue(files: Map<string, string>) {
  const rows = catalogue(files);
  expect(rows.map(({ name }) => name).sort()).toEqual(published.map(({ name }) => name).sort());
  for (const tool of published) {
    const row = rows.find(({ name }) => name === tool.name);
    expect(row, tool.name).toBeDefined();
    const domain = tool.name.split("_")[0];
    const owner =
      domain === "project"
        ? "SKILL.md"
        : `references/${domain === "handoff" ? "handoffs" : domain === "memo" ? "project-memos" : "channels"}.md`;
    expect(row?.file, tool.name).toBe(owner);
    const required = properties(row?.required);
    const optional = properties(row?.optional);
    expect([...required.keys()].sort(), tool.name).toEqual([...(tool.inputSchema.required ?? [])].sort());
    expect(
      [...required.keys()].filter((key) => optional.has(key)),
      tool.name,
    ).toEqual([]);
    const actual = new Map([...required, ...optional]);
    const expected = Object.entries(tool.inputSchema.properties).map(([key, schema]) => [
      key,
      schema.type === "array" ? `${schema.items?.type}[]` : schema.type,
    ]);
    expect([...actual].sort(), tool.name).toEqual(expected.sort());
  }
}

function assertCurrentVocabulary(files: Map<string, string>) {
  const retired =
    /--as-participant|sorage channel (?:submit|handle|read|participant|assignment)\b|--(?:relay-to|assignment|context-session|context-node|context-attempt)\b|contentActivating|bodyPreviewUnavailable|CHN_(?:REPLAY_UNAVAILABLE|FORBIDDEN_ROLE|PARTICIPANT_INACTIVE|ASSIGNMENT_NOT_FOUND)/;
  const oldCaveat =
    /Every Channel command except|reads and waits are non-mutating for Channel domain records only|caller sandboxed read-only against the Sorage home|CLI where the home is writable/;
  for (const [file, body] of files) {
    expect(body, file).not.toMatch(retired);
    expect(body, file).not.toMatch(oldCaveat);
  }
}

function assertErrorVocabulary(files: Map<string, string>) {
  const checked = [...files.values()].flatMap((body) =>
    [...body.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)]
      .map((match) => match[1] as string)
      .filter((code) => errorNamespaces.has(code.split("_")[0])),
  );
  expect(checked.length, "the error vocabulary must not be empty").toBeGreaterThan(0);
  for (const code of checked) expect(errorCodes.has(code), code).toBe(true);
}

function assertWorkedExample(files: Map<string, string>) {
  const body = files.get("references/channels.md") as string;
  const calls = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    ([, json]) => JSON.parse(json as string) as { tool: string; arguments: Record<string, unknown> },
  );
  expect(calls.map(({ tool }) => tool)).toEqual([
    "channel_create",
    "channel_add",
    "channel_post",
    "channel_messages",
    "channel_ack",
  ]);
  for (const call of calls) {
    const schema = published.find(({ name }) => name === call.tool)?.inputSchema;
    expect(schema, call.tool).toBeDefined();
    expect(
      Object.keys(call.arguments).every((key) => Object.hasOwn(schema?.properties ?? {}, key)),
      call.tool,
    ).toBe(true);
    for (const key of schema?.required ?? [])
      expect(Object.hasOwn(call.arguments, key), `${call.tool}.${key}`).toBe(true);
    expect(call.arguments.cwd, call.tool).toMatch(/^\//);
  }
  expect(calls[1]?.arguments.role).toBe("worker");
  expect(calls[2]?.arguments.kind).toBe("report");
  const reportBody = calls[2]?.arguments.body;
  expect(typeof reportBody).toBe("string");
  expect((reportBody as string).trim().length).toBeGreaterThan(0);
  expect(calls[2]?.arguments).not.toHaveProperty("bodyFile");
  expect(calls[3]?.arguments.wait).toBe(true);
  expect(calls[4]?.arguments.seq).toEqual([1]);
  const cli = [...body.matchAll(/^sorage channel (create|add|post|messages|ack)\b/gm)].map((match) => match[1]);
  expect(cli).toEqual(["create", "add", "post", "messages", "ack"]);
}

/** Mutations affect only an in-memory copy; the injection is asserted before checking rejection. */
function mutate(file: string, before: string, after: string): Map<string, string> {
  const original = resources.get(file) as string;
  expect(original.split(before), `injection target: ${before}`).toHaveLength(2);
  const changed = original.replace(before, after);
  expect(changed).not.toBe(original);
  return new Map([...resources, [file, changed]]);
}

describe("the copied skill's published contract resources (not agent behavior)", () => {
  it("declares exactly the published tools, property types and required properties in their domains", () => {
    assertCatalogue(resources);
  });

  it("removes retired Channel instructions while preserving correct zero-write and domain recovery text", () => {
    assertCurrentVocabulary(resources);
    const positive = new Map(resources);
    positive.set("SKILL.md", `${text}\nCovered reads perform no startup recovery, migration, cleanup or log write.\n`);
    assertCurrentVocabulary(positive);
    expect(resources.get("references/handoffs.md")).toContain("--replay-only");
    expect(resources.get("references/project-memos.md")).toContain("--replay-only");
  });

  it("uses current error identifiers", () => {
    assertErrorVocabulary(resources);
    const positive = new Map(resources);
    positive.set("SKILL.md", `${text}\nUse \`SORAGE_HOME\` to select an installation.\n`);
    assertErrorVocabulary(positive);
  });

  it("ships the five separate MCP calls and CLI fallback in loop order", () => {
    assertWorkedExample(resources);
    assertWorkedExample(
      mutate("references/channels.md", '"body": "Checks complete."', '"body": "Another valid report."'),
    );
  });

  it("rejects each injected catalogue defect, including a missing common cwd", () => {
    const file = "references/channels.md";
    const row = catalogue(resources).find(({ name }) => name === "channel_post");
    expect(row).toBeDefined();
    const line = (resources.get(file) as string)
      .split("\n")
      .find((entry) => entry.startsWith("| `channel_post` |")) as string;
    for (const changed of [
      "",
      `${line}\n${line}`,
      line.replace("`channel_post`", "`channel_pots`"),
      line.replace("`channel: string`", "`channelId: string`"),
      line.replace("`channel: string`, ", "").replace(" | `body: string`", " | `channel: string`, `body: string`"),
      line.replace("`cwd: string`", "`workspace: string`"),
      line.replace(", `cwd: string`", ""),
      line.replace("`body: string`", "`body: integer`"),
    ]) {
      expect(changed).not.toBe(line);
      expect(() => assertCatalogue(mutate(file, line, changed))).toThrow();
    }
    assertCatalogue(resources);
  });

  it("detects retired-command/caveat/error regressions and a broken example with verified targets", () => {
    const file = "references/channels.md";
    expect(() =>
      assertCurrentVocabulary(
        mutate(file, "# Channel reference", "# Channel reference\n\nUse `sorage channel submit`."),
      ),
    ).toThrow();
    expect(() =>
      assertCurrentVocabulary(
        mutate(file, "# Channel reference", "# Channel reference\n\nUse the CLI where the home is writable."),
      ),
    ).toThrow();
    expect(() =>
      assertErrorVocabulary(mutate(file, "# Channel reference", "# Channel reference\n\n`CHN_UNKNOWN_CODE`")),
    ).toThrow();
    expect(() => assertWorkedExample(mutate(file, '"tool": "channel_ack"', '"tool": "channel_close"'))).toThrow();
    expect(() => assertWorkedExample(mutate(file, '"body": "Checks complete."', '"body": "  "'))).toThrow();
    assertCurrentVocabulary(resources);
    assertErrorVocabulary(resources);
    assertWorkedExample(resources);
  });
});
