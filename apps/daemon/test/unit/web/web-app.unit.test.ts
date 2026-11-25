import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockNode {
  tag: string;
  attributes: Record<string, string>;
  children: MockNode[];
  parent: MockNode | null;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  className: string;
  options: Array<{ value: string; disabled: boolean }>;
  listeners: Record<string, Array<(event: MockEvent) => void>>;
  readonly isConnected: boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  appendChild(child: MockNode): MockNode;
  insertBefore(child: MockNode, ref: MockNode | null): MockNode;
  replaceChildren(...nodes: MockNode[]): void;
  remove(): void;
  addEventListener(type: string, listener: (event: MockEvent) => void): void;
  dispatch(type: string, extra?: Partial<MockEvent>): void;
  requestSubmit(): void;
}

interface MockEvent {
  type: string;
  key?: string;
  isComposing?: boolean;
  keyCode?: number;
  preventDefault(): void;
}

function makeNode(tag: string, root: { current: MockNode | null }): MockNode {
  const node: MockNode = {
    tag,
    attributes: {},
    children: [],
    parent: null,
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    className: "",
    options: [],
    listeners: {},
    get isConnected() {
      let cur: MockNode | null = node;
      while (cur !== null) {
        if (cur === root.current) return true;
        cur = cur.parent;
      }
      return false;
    },
    setAttribute(name: string, value: string) {
      node.attributes[name] = value;
      if (name === "value") node.value = value;
    },
    getAttribute(name: string) {
      return Object.hasOwn(node.attributes, name) ? (node.attributes[name] ?? null) : null;
    },
    removeAttribute(name: string) {
      delete node.attributes[name];
    },
    appendChild(child: MockNode) {
      if (child.parent !== null) {
        const idx = child.parent.children.indexOf(child);
        if (idx !== -1) child.parent.children.splice(idx, 1);
      }
      child.parent = node;
      node.children.push(child);
      if (node.tag === "select" && child.tag === "option") {
        node.options.push({ value: child.value, disabled: false });
      }
      return child;
    },
    insertBefore(child: MockNode, ref: MockNode | null) {
      if (child.parent !== null) {
        const idx = child.parent.children.indexOf(child);
        if (idx !== -1) child.parent.children.splice(idx, 1);
      }
      child.parent = node;
      const idx = ref === null ? -1 : node.children.indexOf(ref);
      if (idx === -1) node.children.push(child);
      else node.children.splice(idx, 0, child);
      return child;
    },
    replaceChildren(...nodes: MockNode[]) {
      for (const existing of node.children) existing.parent = null;
      node.children = [];
      for (const child of nodes) node.appendChild(child);
    },
    remove() {
      if (node.parent === null) return;
      const idx = node.parent.children.indexOf(node);
      if (idx !== -1) node.parent.children.splice(idx, 1);
      node.parent = null;
    },
    addEventListener(type: string, listener: (event: MockEvent) => void) {
      if (!node.listeners[type]) node.listeners[type] = [];
      node.listeners[type]?.push(listener);
    },
    dispatch(type: string, extra: Partial<MockEvent> = {}) {
      const event: MockEvent = {
        type,
        preventDefault() {},
        ...extra,
      };
      for (const listener of node.listeners[type] ?? []) listener(event);
    },
    requestSubmit() {
      node.dispatch("submit");
    },
  };
  return node;
}

function walk(node: MockNode, predicate: (candidate: MockNode) => boolean, out: MockNode[] = []): MockNode[] {
  if (predicate(node)) out.push(node);
  for (const child of node.children) walk(child, predicate, out);
  return out;
}

function collectText(node: MockNode): string {
  return [node.textContent, ...node.children.map((child) => collectText(child))].filter(Boolean).join("\n");
}

interface ScheduledTimer {
  id: number;
  delay: number;
  fn: () => void;
  cancelled: boolean;
}

async function harness(options: {
  hash?: string;
  fetchImpl: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) => Promise<{
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
  }>;
}) {
  vi.resetModules();
  const rootRef: { current: MockNode | null } = { current: null };
  const bodyRoot = makeNode("body", rootRef);
  rootRef.current = bodyRoot;
  const viewNode = makeNode("main", rootRef);
  viewNode.setAttribute("id", "view");
  const sessionNote = makeNode("p", rootRef);
  sessionNote.setAttribute("id", "session-note");
  const memoRecovery = makeNode("aside", rootRef);
  memoRecovery.setAttribute("id", "memo-recovery");
  bodyRoot.appendChild(sessionNote);
  bodyRoot.appendChild(memoRecovery);
  bodyRoot.appendChild(viewNode);

  const storage = new Map<string, string>([["sorage-session", "session-token"]]);
  const timers: ScheduledTimer[] = [];
  let nextTimerId = 1;
  let encodeCalls = 0;

  class CountingTextEncoder extends TextEncoder {
    override encode(input?: string): Uint8Array<ArrayBuffer> {
      encodeCalls += 1;
      return super.encode(input);
    }
  }

  const locationObj = {
    origin: "http://127.0.0.1:41234",
    pathname: "/",
    hash: options.hash ?? "#/dashboard",
  };

  const windowListeners: Record<string, Array<() => void>> = {};
  const fetchCalls: Array<{ url: string; init: unknown }> = [];

  const windowObj: {
    addEventListener(type: string, fn: () => void): void;
    confirm(): boolean;
  } = {
    addEventListener(type: string, fn: () => void) {
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type]?.push(fn);
    },
    confirm: () => true,
  };

  const globals = {
    window: windowObj,
    document: {
      createElement: (tag: string) => makeNode(tag, rootRef),
      getElementById: (id: string) =>
        id === "view" ? viewNode : id === "session-note" ? sessionNote : id === "memo-recovery" ? memoRecovery : null,
      querySelectorAll: () => [],
      body: bodyRoot,
    },
    location: locationObj,
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      fetchCalls.push({ url, init });
      return options.fetchImpl(url, init);
    },
    URLSearchParams,
    TextEncoder: CountingTextEncoder,
    AbortController,
    Blob,
    crypto: { randomUUID },
    setTimeout: (fn: () => void, delay = 0) => {
      const entry: ScheduledTimer = { id: nextTimerId++, delay, fn, cancelled: false };
      timers.push(entry);
      return entry.id;
    },
    clearTimeout: (id: number) => {
      const entry = timers.find((item) => item.id === id);
      if (entry) entry.cancelled = true;
    },
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  const { route } = await import("../../../src/web/main");
  const { fetchAllHandoffs } = await import("../../../src/web/api");
  const { decodeHashSegment, hashQuery } = await import("../../../src/web/hash");
  const { renderMarkdownSafe } = await import("../../../src/web/markdown");
  const { memoEditor } = await import("../../../src/web/memos/views");
  const { memoState } = await import("../../../src/web/memos/state");
  return {
    api: {
      route,
      fetchAllHandoffs,
      decodeHashSegment,
      hashQuery,
      renderMarkdownSafe: (input: string) => renderMarkdownSafe(input) as unknown as MockNode,
      memoEditor,
      memoState,
    },
    viewNode,
    sessionNote,
    location: locationObj,
    fetchCalls,
    timers,
    encodeCount: () => encodeCalls,
    resetEncodeCount: () => {
      encodeCalls = 0;
    },
    flushTimers: (maxDelay = 1000) => {
      const runnable = timers.filter((entry) => !entry.cancelled && entry.delay <= maxDelay);
      for (const entry of runnable) {
        entry.cancelled = true;
        entry.fn();
      }
    },
    activeTimers: () => timers.filter((entry) => !entry.cancelled && entry.delay <= 1000),
  };
}

async function flushMicrotasks(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

afterEach(() => vi.unstubAllGlobals());

describe("TASK-150 Web UI script unit behavior", () => {
  it("renders Markdown angle brackets and ampersands via textContent without double-escaping (#5)", async () => {
    const h = await harness({
      hash: "#/diagnostics",
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, data: { checks: [] } }) }),
    });
    const rendered = h.api.renderMarkdownSafe(
      "# Heading <T> & Co\n- item a < b & c > d\n<script>alert(1)</script> & <img onerror=alert(2)>",
    );
    expect(rendered.tag).toBe("div");
    expect(rendered.children[0]?.tag).toBe("h3");
    expect(rendered.children[0]?.textContent).toBe("Heading <T> & Co");
    expect(rendered.children[1]?.tag).toBe("ul");
    expect(rendered.children[1]?.children[0]?.tag).toBe("li");
    expect(rendered.children[1]?.children[0]?.textContent).toBe("item a < b & c > d");
    expect(rendered.children[2]?.tag).toBe("p");
    expect(rendered.children[2]?.textContent).toBe("<script>alert(1)</script> & <img onerror=alert(2)>");
    const fullText = collectText(rendered);
    expect(fullText).not.toContain("&lt;");
    expect(fullText).not.toContain("&gt;");
    expect(fullText).not.toContain("&amp;");
    expect(walk(rendered, (node) => node.tag === "script" || node.tag === "img")).toHaveLength(0);
  });

  it("percent-encodes listing filter values and handles malformed hash segments safely (#6a)", async () => {
    const h = await harness({
      hash: "#/inbox?sender=alpha%2Bbeta%26includeDeleted%3Dtrue&state=a%3Fb%23c%25d",
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, data: { handoffs: [] } }) }),
    });
    await flushMicrotasks();
    const call = h.fetchCalls.find((entry) => entry.url.startsWith("/api/v1/handoffs"));
    if (!call) throw new Error("Expected handoffs fetch call");
    const parsed = new URL(call.url, "http://127.0.0.1");
    expect(parsed.searchParams.get("sender")).toBe("alpha+beta&includeDeleted=true");
    expect(parsed.searchParams.get("includeDeleted")).toBeNull();
    expect(parsed.searchParams.get("state")).toBe("a?b#c%d");
    // Unencoded `?` inside query string is preserved by indexOf("?").
    h.location.hash = "#/inbox?sender=foo?bar";
    expect(h.api.hashQuery()).toBe("sender=foo?bar");
    // Malformed percent encoding does not throw URIError.
    expect(h.api.decodeHashSegment("%E0%A4%A")).toBe("%E0%A4%A");
    expect(h.api.decodeHashSegment("id%2Fwith%2Bchars")).toBe("id/with+chars");
  });

  it("deduplicates backupPage runs by run.id across distinct JSON objects (#6b)", async () => {
    const sharedRun = () => ({
      id: "run-1",
      triggeredBy: "manual",
      startedAt: "2026-11-22T00:00:00.000Z",
      outcome: "success",
      snapshotOutcome: "success",
      commitOutcome: "committed",
      commitSha: "abcdef1234567890",
      pushOutcome: "pushed",
      failureCode: null,
    });
    const failedRun = () => ({
      id: "run-2",
      triggeredBy: "scheduled",
      startedAt: "2026-11-22T01:00:00.000Z",
      outcome: "failure",
      snapshotOutcome: "success",
      commitOutcome: "committed",
      commitSha: "1234567890abcdef",
      pushOutcome: "failure",
      failureCode: "BACKUP_PUSH_FAILED",
    });
    const h = await harness({
      hash: "#/backup",
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            lastAttempt: failedRun(),
            lastSuccess: sharedRun(),
            lastCommit: sharedRun(),
            lastPush: sharedRun(),
            lastFailure: failedRun(),
            nextDueAt: null,
            schedule: { enabled: false, at: "03:00", timezone: "UTC" },
          },
        }),
      }),
    });
    await flushMicrotasks();
    const tbody = walk(h.viewNode, (node) => node.tag === "tbody")[0];
    if (!tbody) throw new Error("Expected tbody");
    expect(tbody.children).toHaveLength(2);
  });

  it("paginates fetchAllHandoffs beyond 200 items, deduplicates overlapping IDs, and stops when stale (#6c)", async () => {
    const makeRow = (index: number) => ({
      id: `h-${index}`,
      title: `Handoff ${index}`,
      reviewState: "awaiting_recipient",
      pinned: false,
      archivedAt: null,
      deletedAt: null,
      pendingDeletionRequest: index === 205,
      updatedAt: `2026-11-22T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    });
    const page1 = Array.from({ length: 200 }, (_, i) => makeRow(i + 1));
    // Include an overlapping item (h-200) plus 5 new items to prove cross-page dedup.
    const page2 = [makeRow(200), ...Array.from({ length: 5 }, (_, i) => makeRow(201 + i))];

    const h = await harness({
      hash: "#/dashboard",
      fetchImpl: async (url) => {
        if (url.startsWith("/api/v1/backup/status")) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                lastAttempt: null,
                lastSuccess: null,
                lastCommit: null,
                lastPush: null,
                lastFailure: null,
                schedule: { enabled: false },
              },
            }),
          };
        }
        const parsed = new URL(url, "http://127.0.0.1");
        const cursor = parsed.searchParams.get("cursor");
        if (cursor === null) {
          return {
            status: 200,
            ok: true,
            json: async () => ({ ok: true, data: { handoffs: page1, nextCursor: "cur+page/2&x=1" } }),
          };
        }
        expect(cursor).toBe("cur+page/2&x=1");
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true, data: { handoffs: page2, nextCursor: null } }),
        };
      },
    });
    await flushMicrotasks(20);
    const awaitingCard = walk(h.viewNode, (node) => node.getAttribute("data-state") === "awaiting_recipient")[0];
    if (!awaitingCard) throw new Error("Expected awaiting_recipient card");
    expect(awaitingCard.children[0]?.textContent).toBe("205");
    // Recent updates still shows top 10.
    const recentRows = walk(h.viewNode, (node) => node.tag === "tbody")[0]?.children ?? [];
    expect(recentRows).toHaveLength(10);
    // Repeated cursor stops cleanly without infinite recursion.
    let staleFlag = false;
    const staleResult = await h.api.fetchAllHandoffs("/api/v1/handoffs?asUser=true&limit=200", () => staleFlag);
    expect("status" in staleResult && staleResult.status).toBe(200);
    staleFlag = true;
    const abortedResult = await h.api.fetchAllHandoffs("/api/v1/handoffs?asUser=true&limit=200", () => staleFlag);
    expect("stale" in abortedResult && abortedResult.stale).toBe(true);
  });

  it("debounces Memo editor preview/byte-counting while keeping drafts synced, flushing on submit, and clearing on teardown (#6d)", async () => {
    const projectId = "a1000000-0000-4000-8000-000000000001";
    const installationId = "a1000000-0000-4000-8000-000000000002";
    const postedBodies: string[] = [];
    const h = await harness({
      hash: "#/diagnostics",
      fetchImpl: async (url, init) => {
        if (url === "/api/v1/health")
          return { status: 200, ok: true, json: async () => ({ ok: true, data: { installationId } }) };
        if (url === "/api/v1/config") {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                config: {
                  artifact: { maxBytes: 65536 },
                  gitBackup: { enabled: false, largeArtifactWarningBytes: 1024 },
                },
              },
            }),
          };
        }
        if (url === "/api/v1/memos" && init?.method === "POST") {
          postedBodies.push(String(init.body));
          return {
            status: 500,
            ok: false,
            json: async () => ({ ok: false, error: { code: "INTERNAL_ERROR", message: "stop" } }),
          };
        }
        return { status: 200, ok: true, json: async () => ({ ok: true, data: { checks: [] } }) };
      },
    });
    await flushMicrotasks();

    const mount = makeNode("div", { current: h.viewNode });
    h.viewNode.replaceChildren(mount);
    h.api.memoEditor(mount as unknown as HTMLElement, projectId, null);
    await flushMicrotasks();

    const titleInput = walk(mount, (node) => node.tag === "input")[0];
    const bodyInput = walk(mount, (node) => node.tag === "textarea")[0];
    const form = walk(mount, (node) => node.tag === "form")[0];
    const preview = walk(mount, (node) => node.getAttribute("aria-label") === "Memo preview")[0];
    if (!titleInput || !bodyInput || !form || !preview) throw new Error("Expected Memo editor controls");

    h.resetEncodeCount();
    titleInput.value = "Fast title";
    titleInput.dispatch("input");
    for (let i = 1; i <= 15; i++) {
      bodyInput.value = `Line <${i}> & burst`;
      bodyInput.dispatch("input");
    }
    // Draft is synchronized immediately on input while expensive byte-counting is deferred.
    expect(h.api.memoState.drafts[`new:${projectId}`]).toEqual({ title: "Fast title", body: "Line <15> & burst" });
    expect(h.encodeCount()).toBe(0);
    expect(h.activeTimers()).toHaveLength(1);

    // Firing the single coalesced debounce timer rebuilds preview & byte count once.
    h.flushTimers(200);
    expect(h.encodeCount()).toBeGreaterThan(0);
    expect(collectText(preview)).toContain("Line <15> & burst");

    // Fast edit followed immediately by submit cancels pending timer and flushes synchronously.
    h.resetEncodeCount();
    bodyInput.value = "Final immediate <save> & flush";
    bodyInput.dispatch("input");
    expect(h.activeTimers()).toHaveLength(1);
    form.dispatch("submit");
    expect(h.activeTimers()).toHaveLength(0);
    await flushMicrotasks(80);
    expect(postedBodies).toHaveLength(1);
    expect(JSON.parse(postedBodies[0] ?? "{}")).toMatchObject({
      projectId,
      title: "Fast title",
      body: "Final immediate <save> & flush",
    });

    // Pending debounce timer is cleared when navigating away via route().
    bodyInput.value = "After nav";
    bodyInput.dispatch("input");
    expect(h.activeTimers()).toHaveLength(1);
    h.location.hash = "#/diagnostics";
    h.api.route();
    expect(h.activeTimers()).toHaveLength(0);
  });
});
