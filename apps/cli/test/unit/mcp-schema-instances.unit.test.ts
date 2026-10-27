import { describe, expect, it } from "vitest";
import { toolsListResult } from "../../src/mcp-server";
import { MCP_TOOLS } from "../../src/mcp-catalogue";

/**
 * A test-local evaluator for exactly the JSON Schema keywords the catalogue
 * uses (c2-decision item 6). It throws on any keyword it does not implement,
 * so a new keyword in a schema fails here rather than passing silently.
 */
type Schema = Record<string, unknown>;

const IMPLEMENTED = new Set([
  "type",
  "properties",
  "additionalProperties",
  "required",
  "oneOf",
  "allOf",
  "anyOf",
  "not",
  "if",
  "then",
  "const",
  "enum",
  "items",
  "minItems",
  "minimum",
  "maximum",
  "default",
]);

function validate(schema: unknown, value: unknown, path: string): string | undefined {
  if (schema === true) return undefined;
  if (typeof schema !== "object" || schema === null)
    throw new Error(`unsupported schema at ${path}: ${String(schema)}`);
  for (const key of Object.keys(schema as Schema)) {
    if (!IMPLEMENTED.has(key)) throw new Error(`unimplemented keyword '${key}' at ${path}`);
  }
  const record = schema as Schema;
  if (record.type !== undefined) {
    const expected = record.type;
    const matches =
      (expected === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) ||
      (expected === "array" && Array.isArray(value)) ||
      (expected === "string" && typeof value === "string") ||
      (expected === "boolean" && typeof value === "boolean") ||
      (expected === "integer" && typeof value === "number" && Number.isInteger(value));
    if (!matches) return `${path}: expected ${String(expected)}`;
  }
  if (record.const !== undefined && value !== record.const)
    return `${path}: expected const ${JSON.stringify(record.const)}`;
  if (record.enum !== undefined && !(record.enum as unknown[]).some((option) => value === option))
    return `${path}: not in enum`;
  if (Array.isArray(value)) {
    if (record.minItems !== undefined && value.length < (record.minItems as number))
      return `${path}: fewer than ${String(record.minItems)} items`;
    if (record.items !== undefined) {
      for (let index = 0; index < value.length; index++) {
        const failure = validate(record.items, value[index], `${path}[${String(index)}]`);
        if (failure !== undefined) return failure;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    // required is checked by own property, and additionalProperties:false
    // refuses every key the schema does not declare (c3-decision item 7).
    for (const name of (record.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(object, name)) return `${path}: missing required '${name}'`;
    }
    const declared = new Set(Object.keys((record.properties as Record<string, unknown>) ?? {}));
    if (record.additionalProperties === false) {
      for (const name of Object.keys(object)) {
        if (!declared.has(name)) return `${path}: unknown property '${name}'`;
      }
    }
    for (const [name, propertySchema] of Object.entries((record.properties as Record<string, unknown>) ?? {})) {
      if (Object.hasOwn(object, name)) {
        const failure = validate(propertySchema, object[name], `${path}.${name}`);
        if (failure !== undefined) return failure;
      }
    }
  }
  if (typeof value === "number") {
    if (record.minimum !== undefined && value < (record.minimum as number)) return `${path}: below minimum`;
    if (record.maximum !== undefined && value > (record.maximum as number)) return `${path}: above maximum`;
  }
  for (const sub of (record.allOf as Schema[] | undefined) ?? []) {
    const failure = validate(sub, value, path);
    if (failure !== undefined) return failure;
  }
  const anyOf = record.anyOf as Schema[] | undefined;
  if (anyOf !== undefined && !anyOf.some((sub) => validate(sub, value, path) === undefined))
    return `${path}: matched no anyOf branch`;
  const oneOf = record.oneOf as Schema[] | undefined;
  if (oneOf !== undefined) {
    const matched = oneOf.filter((sub) => validate(sub, value, path) === undefined);
    if (matched.length !== 1) return `${path}: matched ${String(matched.length)} oneOf branches, expected exactly 1`;
  }
  const not = record.not as Schema | undefined;
  if (not !== undefined && validate(not, value, path) === undefined) return `${path}: matched the not schema`;
  const ifSchema = record.if as Schema | undefined;
  if (ifSchema !== undefined) {
    const then = record.then as Schema | undefined;
    if (validate(ifSchema, value, path) === undefined && then !== undefined) {
      const failure = validate(then, value, path);
      if (failure !== undefined) return failure;
    }
  }
  return undefined;
}

function schemaOf(name: string): Schema {
  const tool = toolsListResult().find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.inputSchema as Schema;
}

function valid(name: string, instance: Record<string, unknown>): void {
  expect(validate(schemaOf(name), instance, name), `${name} should accept ${JSON.stringify(instance)}`).toBeUndefined();
}

function invalid(name: string, instance: Record<string, unknown>): void {
  expect(validate(schemaOf(name), instance, name), `${name} should reject ${JSON.stringify(instance)}`).toBeDefined();
}

describe("the published schemas judged by instances (C3 item 6)", () => {
  it("walks every node of every schema and finds only implemented keywords", () => {
    // A static walk over every schema node (c3-decision item 7, CO-3): each
    // object node's keys must all be implemented, and the walk itself visits
    // properties, items, allOf, anyOf, oneOf, not, if and then — not only the
    // empty-instance paths the {} case exercised.
    const CONTAINERS = ["properties", "items", "allOf", "anyOf", "oneOf", "not", "if", "then"];
    const visited = new Set<string>();
    const walk = (node: unknown, path: string): void => {
      if (node === true || node === false) return;
      if (typeof node !== "object" || node === null) return;
      for (const key of Object.keys(node as Schema)) {
        if (!IMPLEMENTED.has(key) && !(CONTAINERS as string[]).includes(key))
          throw new Error(`unimplemented keyword '${key}' at ${path}`);
      }
      const record = node as Schema;
      visited.add(path);
      for (const [name, property] of Object.entries((record.properties as Record<string, unknown>) ?? {})) {
        walk(property, `${path}.${name}`);
      }
      for (const container of ["items", "not", "if", "then"] as const) {
        const sub = record[container];
        if (sub !== undefined) walk(sub, `${path}.${container}`);
      }
      for (const container of ["allOf", "anyOf", "oneOf"] as const) {
        const list = record[container] as Schema[] | undefined;
        for (let index = 0; index < (list ?? []).length; index++) {
          walk(list?.[index], `${path}.${container}[${String(index)}]`);
        }
      }
    };
    for (const tool of toolsListResult()) walk(tool.inputSchema, tool.name as string);
    expect(visited.size).toBeGreaterThan(31);
  });

  it("handoff_send: the body/file group and replayOnly only when true", () => {
    valid("handoff_send", { to: ["alpha"], title: "T", body: "b" });
    valid("handoff_send", { to: ["alpha"], title: "T", file: "f.md" });
    valid("handoff_send", { to: ["alpha"], title: "T", body: "b", replayOnly: false });
    invalid("handoff_send", { to: ["alpha"], title: "T" });
    invalid("handoff_send", { to: ["alpha"], title: "T", body: "b", file: "f.md" });
    invalid("handoff_send", { to: ["alpha"], title: "T", body: "b", replayOnly: true });
  });

  it("handoff_revise: reason exactly when noChange is true, and false counts as absent", () => {
    valid("handoff_revise", { handoffId: "h", body: "b" });
    valid("handoff_revise", { handoffId: "h", noChange: true, reason: "r" });
    valid("handoff_revise", { handoffId: "h", body: "b", noChange: false });
    invalid("handoff_revise", { handoffId: "h", noChange: true });
    invalid("handoff_revise", { handoffId: "h", body: "b", reason: "r" });
    invalid("handoff_revise", { handoffId: "h", body: "b", noChange: false, reason: "r" });
    // With false counting as absent, a false flag alone supplies no source.
    invalid("handoff_revise", { handoffId: "h", noChange: false });
    invalid("handoff_revise", { handoffId: "h" });
  });

  it("reporting: mandatory observations, exact/optional source groups and enum", () => {
    const observations = { handoffId: "h", expectedRevision: 1, expectedRowVersion: 2 };
    valid("handoff_comment_show", { handoffId: "h" });
    valid("handoff_comment_set", { ...observations, text: "Report" });
    valid("handoff_comment_set", { ...observations, file: "r.md", purpose: "change_request" });
    invalid("handoff_comment_set", observations);
    invalid("handoff_comment_set", { ...observations, text: "Report", file: "r.md" });
    invalid("handoff_comment_set", { ...observations, text: "Report", purpose: "reply" });
    invalid("handoff_comment_set", { handoffId: "h", text: "Report", expectedRevision: 1 });
    for (const tool of ["handoff_processing_start", "handoff_processing_complete"]) {
      valid(tool, observations);
      valid(tool, { ...observations, commentText: "Report" });
      valid(tool, { ...observations, commentFile: "r.md" });
      invalid(tool, { ...observations, commentText: "Report", commentFile: "r.md" });
      invalid(tool, { handoffId: "h", expectedRowVersion: 2 });
      invalid(tool, { ...observations, asUser: true });
    }
  });

  it("handoff_inbox: wait true cannot combine with cursor; false can", () => {
    valid("handoff_inbox", { wait: true });
    valid("handoff_inbox", { wait: false, cursor: "c" });
    valid("handoff_inbox", { cursor: "c" });
    invalid("handoff_inbox", { wait: true, cursor: "c" });
  });

  it("memo_list: project and allProjects true are exclusive; false is not", () => {
    valid("memo_list", { project: "alpha" });
    valid("memo_list", { allProjects: true });
    valid("memo_list", { project: "alpha", allProjects: false });
    invalid("memo_list", { project: "alpha", allProjects: true });
  });

  it("memo mutations: body sources exclusive, at-least-one on update, replayOnly only when true", () => {
    valid("memo_add", { title: "t" });
    valid("memo_add", { title: "t", body: "b" });
    valid("memo_add", { title: "t", bodyFile: "f.md" });
    invalid("memo_add", { title: "t", body: "b", bodyFile: "f.md" });
    invalid("memo_add", { body: "b" });
    valid("memo_add", { title: "t", replayOnly: false });
    invalid("memo_add", { title: "t", replayOnly: true });
    valid("memo_update", { memoId: "m", expectedRowVersion: 2, title: "t" });
    valid("memo_update", { memoId: "m", expectedRowVersion: 2, body: "b" });
    invalid("memo_update", { memoId: "m", expectedRowVersion: 2 });
    invalid("memo_update", { memoId: "m", expectedRowVersion: 2, title: "t", body: "b", bodyFile: "f.md" });
    valid("memo_done", { memoId: "m", expectedRowVersion: 2, replayOnly: false });
    invalid("memo_done", { memoId: "m", expectedRowVersion: 2, replayOnly: true });
  });

  it("channel_post: the relay to condition both ways", () => {
    valid("channel_post", { channel: "c", from: "h", kind: "report", body: "b" });
    valid("channel_post", { channel: "c", from: "h", kind: "relay_request", body: "b", to: "main" });
    invalid("channel_post", { channel: "c", from: "h", kind: "relay_request", body: "b" });
    invalid("channel_post", { channel: "c", from: "h", kind: "report", body: "b", to: "main" });
    invalid("channel_post", { channel: "c", from: "h", kind: "report" });
  });

  it("bounds and array forms: safe-integer maximum, minItems, enum, item minimum", () => {
    valid("handoff_inbox", { limit: 9007199254740991 });
    invalid("handoff_inbox", { limit: 9007199254740992 });
    invalid("handoff_inbox", { limit: -1 });
    valid("channel_ack", { channel: "c", seq: [1, 2] });
    invalid("channel_ack", { channel: "c", seq: [] });
    invalid("channel_ack", { channel: "c", seq: [0] });
    invalid("channel_ack", { channel: "c", seq: ["1"] });
    invalid("channel_add", { channel: "c", handle: "h", role: "boss" });
    invalid("memo_list", { state: "archived" });
  });
});

describe("the common rules are published on every tool (C4 item 3)", () => {
  it("declares exactly the runtime properties plus cwd, and additionalProperties false", () => {
    for (const tool of toolsListResult()) {
      const name = tool.name as string;
      const properties = (tool.inputSchema as Schema).properties as Record<string, unknown>;
      expect(Object.hasOwn(properties, "cwd"), name).toBe(true);
      expect(properties.cwd, name).toEqual({ type: "string" });
      expect((tool.inputSchema as Schema).additionalProperties, name).toBe(false);
      // The published names are exactly the runtime property names plus cwd
      // (c3-decision item 3, first bullet): neither a missing option nor an
      // invented one can drift between the two halves.
      const runtime = MCP_TOOLS.find((entry) => entry.name === name);
      expect(runtime, name).toBeDefined();
      expect(Object.keys(properties).sort(), name).toEqual([...Object.keys(runtime?.properties ?? {}), "cwd"].sort());
    }
  });

  it("accepts cwd strings and refuses non-string cwd and unknown properties by instance", () => {
    valid("handoff_inbox", { cwd: "/x" });
    invalid("handoff_inbox", { cwd: 1 });
    invalid("handoff_inbox", { mystery: true });
    invalid("memo_list", { cwd: "/x", mystery: "no" });
  });
});

describe("integer bounds hold on every integer property (C4 item 6)", () => {
  const MAX = 9007199254740991;

  function integerProperties(): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    for (const tool of toolsListResult()) {
      for (const [name, property] of Object.entries(
        (tool.inputSchema as Schema).properties as Record<string, Schema>,
      )) {
        const items = property.items as { type?: string } | undefined;
        if (property.type === "integer" || items?.type === "integer") found.push([tool.name as string, name]);
      }
    }
    return found;
  }

  it("tests the safe maximum, one above it and -1 on every integer property", () => {
    const properties = integerProperties();
    expect(properties.length).toBeGreaterThan(10);
    for (const [toolName, property] of properties) {
      // The ack items carry their own minimum; option integers share the parser
      // bounds. Each instance goes through the same published schema.
      valid(toolName, sampleWith(toolName, property, MAX));
      invalid(toolName, sampleWith(toolName, property, MAX + 1));
      invalid(toolName, sampleWith(toolName, property, -1));
      // An array-typed integer property (seq) carries the bound on its items,
      // so the same three instances are tested against the items schema too.
      const tool = toolsListResult().find((entry) => entry.name === toolName);
      const items = ((tool?.inputSchema as Schema).properties as Record<string, Schema>)[property]?.items;
      if (items !== undefined) {
        expect(validate(items, MAX, `${toolName}.${property}[]`)).toBeUndefined();
        expect(validate(items, MAX + 1, `${toolName}.${property}[]`)).toBeDefined();
        expect(validate(items, -1, `${toolName}.${property}[]`)).toBeDefined();
      }
    }
  });
});

/** A minimal instance that supplies the tool's requireds plus the named integer. */
function sampleWith(toolName: string, property: string, value: number): Record<string, unknown> {
  const tool = toolsListResult().find((entry) => entry.name === toolName);
  const schema = tool?.inputSchema as Schema;
  const tool0 = toolsListResult().find((entry) => entry.name === toolName);
  const declaredProperty = ((tool0?.inputSchema as Schema).properties as Record<string, Schema>)[property];
  const isItems = declaredProperty?.type === "array";
  const instance: Record<string, unknown> = { [property]: isItems ? [value] : value };
  for (const name of (schema.required as string[] | undefined) ?? []) {
    if (name === property) continue;
    const declared = (schema.properties as Record<string, Schema>)[name];
    if (declared?.type === "string") instance[name] = `sample-${name}`;
    else if (declared?.type === "integer") instance[name] = 1;
    else if (declared?.type === "boolean") instance[name] = true;
    else if (declared?.type === "array") instance[name] = [1];
  }
  // Satisfy the exactly-one exclusive groups the sample needs.
  if (toolName === "handoff_send" && property !== "body" && property !== "file") instance.body = "b";
  if (toolName === "handoff_revise" && property !== "body" && property !== "file" && property !== "noChange") {
    instance.body = "b";
  }
  if (
    (toolName === "handoff_review_set" || toolName === "handoff_comment_set") &&
    property !== "text" &&
    property !== "file"
  )
    instance.text = "n";
  if (toolName === "channel_post" && property !== "body" && property !== "bodyFile") instance.body = "b";
  if (
    toolName === "memo_update" &&
    !("title" in instance) &&
    property !== "title" &&
    property !== "body" &&
    property !== "bodyFile"
  ) {
    instance.title = "t";
  }
  return instance;
}
