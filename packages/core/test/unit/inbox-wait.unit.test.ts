import { describe, expect, it } from "vitest";
import { ok } from "../../src/errors";
import type { HandoffReadPorts, HandoffView, ListQuery } from "../../src/handoff-read";
import { waitForNewInboxItems } from "../../src/handoff-read";

/**
 * The `inbox --wait` semantics of CLI-020 at the use-case level: the wait wakes only
 * on an item that did not exist when it began, honors the filter of its query on
 * every poll, and times out with the documented empty list. Time is driven by an
 * injected clock and sleep so the cadence itself is asserted, never wall time.
 */

let nowMs = 0;
const clock = { now: () => new Date(nowMs) };

function view(id: string, updatedAtMs: number): HandoffView {
  return {
    id,
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: `Handoff ${id}`,
    senderKind: "registered_project",
    senderProjectId: "00000000-0000-4000-8000-0000000000a1",
    senderProjectSlug: "alpha",
    senderWorkspaceKey: null,
    senderPathSnapshot: null,
    recipientProjectId: "00000000-0000-4000-8000-0000000000b1",
    recipientProjectSlug: "beta",
    revision: 1,
    rowVersion: 1,
    reviewState: "awaiting_recipient",
    nextActors: { reviewNextActor: "recipient", administrativeNextActor: null },
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    currentArtifact: null,
    createdAt: new Date(updatedAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    pendingDeletionRequest: false,
    hasReviewNote: false,
    consecutiveNoChangeResolutions: 0,
  };
}

/** The User scope resolves without the Project ports, so the wait never touches them. */
function portsOf(page: () => HandoffView[]): HandoffReadPorts {
  return {
    projectPorts: null as never,
    handoffs: {
      listPage: (_scope, filters) =>
        ok({
          items: [...page()]
            .filter((item) => filters.state === undefined || item.reviewState === filters.state)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          lastSortKey: null,
        }),
      findHandoffView: () => ok(null),
      recordFirstFetch: () => ok(undefined),
    },
    config: { vaultPath: "/vault", verifyChecksumOnFetch: false },
    artifact: { checksum: () => ok(""), pathOf: () => ok("") },
    ids: { next: () => "event" },
    clock,
  } as HandoffReadPorts;
}

const userActor = { path: "/w", userHome: "/h", as: undefined, asUser: true };
const query: ListQuery = { limit: 50, filters: { includeArchived: false, includeDeleted: false } };

function resetClock(): void {
  nowMs = 0;
}

describe("waitForNewInboxItems", () => {
  it("times out with an empty list and timedOut after the budget", () => {
    resetClock();
    const existing = [view("h1", 1_000)];
    const result = waitForNewInboxItems(
      portsOf(() => existing),
      userActor,
      query,
      {
        intervalSeconds: 2,
        timeoutSeconds: 5,
        sleepMs: (ms) => {
          nowMs += ms;
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.handoffs).toEqual([]);
    }
    // 5s budget, 2s interval: the third sleep clamps to the remaining second.
    expect(nowMs).toBe(5_000);
  });

  it("returns the item that appeared during the wait, before the timeout", () => {
    resetClock();
    const items = [view("h1", 1_000)];
    const ports = portsOf(() => items);
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 2,
      timeoutSeconds: 30,
      sleepMs: (ms) => {
        nowMs += ms;
        if (nowMs === 4_000) items.push(view("h2", nowMs));
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["h2"]);
    }
    expect(nowMs).toBe(4_000);
  });

  it("does not wake when an already-seen item only changes", () => {
    resetClock();
    const items = [view("h1", 1_000)];
    const result = waitForNewInboxItems(
      portsOf(() => items),
      userActor,
      query,
      {
        intervalSeconds: 1,
        timeoutSeconds: 3,
        sleepMs: (ms) => {
          nowMs += ms;
          // A state change bumps updatedAt and rowVersion but creates no new id.
          const current = items[0];
          if (current !== undefined) {
            items[0] = { ...current, rowVersion: 2, updatedAt: new Date(nowMs).toISOString() };
          }
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.handoffs).toEqual([]);
    }
  });

  it("does not wake when an off-page item only changes state, because the seed pages through the whole inbox", () => {
    resetClock();
    // Three items with a page size of two: h3 lives on the second page of the seed.
    const items = [view("h1", 1_000), view("h2", 900), view("h3", 800)];
    const ports = portsOf(() => items);
    // The stub returns everything in one call, so simulate paging by slicing in the
    // test through a wrapper that respects the limit: the seed walks both pages.
    const paged = portsOf(() => items);
    paged.handoffs.listPage = (_scope, filters, limit, after) => {
      const all = items
        .filter((item) => filters.state === undefined || item.reviewState === filters.state)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = after === null ? 0 : all.findIndex((item) => `${item.updatedAt}|${item.id}` === after) + 1;
      const slice = all.slice(start, start + limit);
      const last = slice[slice.length - 1];
      return ok({
        items: slice,
        lastSortKey: slice.length === limit && last !== undefined ? `${last.updatedAt}|${last.id}` : null,
      });
    };
    const result = waitForNewInboxItems(
      { ...paged, handoffs: paged.handoffs },
      userActor,
      { ...query, limit: 2 },
      {
        intervalSeconds: 1,
        timeoutSeconds: 3,
        sleepMs: (ms) => {
          nowMs += ms;
          // h3 changes state and jumps to the head of the listing on the next poll.
          const h3 = items[2];
          if (h3 !== undefined) {
            items[2] = { ...h3, rowVersion: 2, updatedAt: new Date(nowMs).toISOString() };
          }
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.handoffs).toEqual([]);
    }
  });

  it("pages past churned known items to find a new item hidden below the first page", () => {
    resetClock();
    const items = [view("h1", 1_000), view("h2", 900), view("h3", 800)];
    const paged = portsOf(() => items);
    paged.handoffs.listPage = (_scope, filters, limit, after) => {
      const all = items
        .filter((item) => filters.state === undefined || item.reviewState === filters.state)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = after === null ? 0 : all.findIndex((item) => `${item.updatedAt}|${item.id}` === after) + 1;
      const slice = all.slice(start, start + limit);
      const last = slice[slice.length - 1];
      return ok({
        items: slice,
        lastSortKey: slice.length === limit && last !== undefined ? `${last.updatedAt}|${last.id}` : null,
      });
    };
    const result = waitForNewInboxItems(
      { ...paged, handoffs: paged.handoffs },
      userActor,
      { ...query, limit: 2 },
      {
        intervalSeconds: 1,
        timeoutSeconds: 30,
        sleepMs: (ms) => {
          nowMs += ms;
          if (nowMs === 1_000) {
            // Both first-page items churn while the new h4 lands below them.
            const first = items[0];
            const second = items[1];
            if (first !== undefined) {
              items[0] = { ...first, rowVersion: 2, updatedAt: new Date(nowMs + 5).toISOString() };
            }
            if (second !== undefined) {
              items[1] = { ...second, rowVersion: 2, updatedAt: new Date(nowMs + 4).toISOString() };
            }
            items.push(view("h4", nowMs + 3));
          }
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["h4"]);
    }
  });

  it("never sees items its query filters out, and times out", () => {
    resetClock();
    const items: HandoffView[] = [];
    const result = waitForNewInboxItems(
      portsOf(() => items),
      userActor,
      {
        ...query,
        filters: { state: "awaiting_recipient", includeArchived: false, includeDeleted: false },
      },
      {
        intervalSeconds: 1,
        timeoutSeconds: 2,
        sleepMs: (ms) => {
          nowMs += ms;
          // A terminal item exists but the SQL filter of the query excludes it.
          items.push({ ...view(`h-${nowMs}`, nowMs), reviewState: "declined" });
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.handoffs).toEqual([]);
    }
  });
});
