import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";

/**
 * The in-process connection window of the zero-write inventory tests
 * (c1-decision item 15, c2-decision item 3, `flake-record-c1.md`).
 *
 * In-process `runCli` fixture commands leak writer connections from the
 * Project and Handoff port factories, and a GC-time close of one inside an
 * inventory window checkpoints the WAL and deletes the sidecars, breaking the
 * comparison. Every `node:sqlite` connection is registered on its first
 * statement and marked on `close()`; the registry holds each connection
 * strongly, so no tracked connection closes at GC time.
 *
 * A window settles the leaked fixture connections once, before its baseline
 * capture, and never again. After the read under test it asserts that no
 * connection opened inside the window is still open, then the caller captures
 * the raw inventory: a read that wrongly leaves a connection open fails the
 * assertion, and a read that wrongly creates or changes a file fails the
 * comparison, instead of either being cleaned up before observation.
 */

interface ConnectionRecord {
  serial: number;
  closed: boolean;
}

interface Registry {
  records: Map<object, ConnectionRecord>;
  serial: number;
  patched: boolean;
}

const REGISTRY = Symbol.for("sorage.test.sqlite-connection-window");
const globalRegistry = globalThis as unknown as Record<symbol, Registry | undefined>;
if (globalRegistry[REGISTRY] === undefined) {
  globalRegistry[REGISTRY] = { records: new Map(), serial: 0, patched: false };
}
const registry = globalRegistry[REGISTRY] as Registry;

if (!registry.patched) {
  registry.patched = true;
  const proto = DatabaseSync.prototype as unknown as Record<string, unknown>;
  for (const method of ["exec", "prepare"] as const) {
    const original = proto[method] as (...args: unknown[]) => unknown;
    proto[method] = function patched(this: object, ...args: unknown[]) {
      if (!registry.records.has(this)) {
        registry.serial += 1;
        registry.records.set(this, { serial: registry.serial, closed: false });
      }
      return original.apply(this, args);
    };
  }
  const originalClose = proto.close as () => void;
  proto.close = function patchedClose(this: object) {
    const record = registry.records.get(this);
    if (record !== undefined) record.closed = true;
    return originalClose.apply(this as never);
  };
}

/**
 * Closes every tracked connection that is still open and returns how many it
 * closed. Call it once, before a window's baseline capture — never before the
 * post-read capture.
 */
export function settleConnections(): number {
  let settled = 0;
  for (const [db, record] of registry.records) {
    if (record.closed) continue;
    record.closed = true;
    settled += 1;
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      // A connection whose close already completed closes silently here.
    }
  }
  return settled;
}

/** The mark of a window: connections registered after it were opened inside it. */
export function openWindow(): number {
  return registry.serial;
}

/** The connections opened after the mark that are still open. */
export function connectionsOpenedSince(mark: number): object[] {
  const open: object[] = [];
  for (const [db, record] of registry.records) {
    if (record.serial > mark && !record.closed) open.push(db);
  }
  return open;
}

/** Fails when a connection opened inside the window is still open. */
export function assertWindowConnectionsClosed(mark: number, label: string): void {
  expect(connectionsOpenedSince(mark).length, `${label}: connections opened inside the window still open`).toBe(0);
}
