import { describe, expect, it } from "vitest";
import { appError, err, ok } from "../../src/errors";
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
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((view) => ({ view, contentIntegrity: "ok" as const })),
          lastSortKey: null,
        }),
      findHandoffView: () => ok(null),
      loadHandoff: () => ok(null),
      recordFirstFetch: () => ok(undefined),
    },
    config: { vaultPath: "/vault", verifyChecksumOnFetch: false },
    artifact: {
      verifyArtifactBody: () => ok(undefined),
      localPathOfArtifact: () => ok(""),
      openArtifactBody: () => {
        throw new Error("not used here");
      },
    },
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
    const existing = [view("h1", -1_000)];
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
    const items = [view("h1", -1_000)];
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
    const items = [view("h1", -1_000)];
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
    const items = [view("h1", -1_000), view("h2", -900), view("h3", -800)];
    const _ports = portsOf(() => items);
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
        items: slice.map((view) => ({ view, contentIntegrity: "ok" as const })),
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
    const items = [view("h1", -1_000), view("h2", -900), view("h3", -800)];
    const paged = portsOf(() => items);
    paged.handoffs.listPage = (_scope, filters, limit, after) => {
      const all = items
        .filter((item) => filters.state === undefined || item.reviewState === filters.state)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = after === null ? 0 : all.findIndex((item) => `${item.updatedAt}|${item.id}` === after) + 1;
      const slice = all.slice(start, start + limit);
      const last = slice[slice.length - 1];
      return ok({
        items: slice.map((view) => ({ view, contentIntegrity: "ok" as const })),
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

  it("returns items created at or after the invocation instant from the seed without sleeping", () => {
    resetClock();
    // Both the invocation instant itself and a later instant count as new.
    const items = [view("seed-now", 0)];
    let sleeps = 0;
    const result = waitForNewInboxItems(
      portsOf(() => items),
      userActor,
      query,
      {
        intervalSeconds: 2,
        timeoutSeconds: 5,
        sleepMs: (ms) => {
          sleeps += 1;
          nowMs += ms;
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["seed-now"]);
    }
    expect(sleeps).toBe(0);
  });

  it("delivers a new item from a seed that completes exactly at the deadline", () => {
    resetClock();
    let calls = 0;
    const ports = portsOf(() => []);
    ports.handoffs.listPage = () => {
      calls += 1;
      // The seed itself consumes the whole budget, then lists a post-invocation item.
      nowMs += 5_000;
      return ok({
        items: [{ view: view("late-seed", 0), contentIntegrity: "ok" as const }],
        lastSortKey: null,
      });
    };
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 2,
      timeoutSeconds: 5,
      sleepMs: (ms) => {
        nowMs += ms;
      },
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["late-seed"]);
    }
  });

  it("retries a retryable seed failure at the poll cadence and treats a late arrival as new", () => {
    resetClock();
    const items = [view("old", -1_000)];
    const ports = portsOf(() => items);
    const inner = ports.handoffs.listPage;
    let attempts = 0;
    ports.handoffs.listPage = (...args) => {
      attempts += 1;
      if (attempts === 1) return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
      return inner(...args);
    };
    const sleeps: number[] = [];
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 2,
      timeoutSeconds: 10,
      sleepMs: (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        // The arrival lands while the seed is being retried, at the invocation instant.
        if (sleeps.length === 1) items.push(view("new-during-retry", 0));
      },
    });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2_000]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["new-during-retry"]);
    }
  });

  it("restarts a partly paged seed and keeps a second-page pre-invocation item known", () => {
    resetClock();
    const items = [view("old-head", -3_000), view("old-second-page", -2_000)];
    const ports = portsOf(() => items);
    const paged = (itemsNow: HandoffView[], after: string | null | undefined) => {
      const all = [...itemsNow].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start =
        after === null || after === undefined
          ? 0
          : all.findIndex((item) => `${item.updatedAt}|${item.id}` === after) + 1;
      const slice = all.slice(start, start + 1);
      const last = slice[slice.length - 1];
      return {
        items: slice.map((item) => ({ view: item, contentIntegrity: "ok" as const })),
        lastSortKey: slice.length === 1 && last !== undefined ? `${last.updatedAt}|${last.id}` : null,
      };
    };
    let failedSecondPage = false;
    ports.handoffs.listPage = (_scope, _filters, _limit, after) => {
      // The first seed fails on its second page; the whole seed then restarts.
      if (after !== null && after !== undefined && !failedSecondPage) {
        failedSecondPage = true;
        return err(appError("CONTENT_MATERIALIZING", "still activating"));
      }
      return ok(paged(items, after));
    };
    const result = waitForNewInboxItems(
      ports,
      userActor,
      { ...query, limit: 1 },
      {
        intervalSeconds: 1,
        timeoutSeconds: 3,
        sleepMs: (ms) => {
          nowMs += ms;
          // The second-page known item changes state and jumps to the head.
          const changed = items[1];
          if (changed !== undefined) items[1] = { ...changed, rowVersion: 2, updatedAt: new Date(nowMs).toISOString() };
        },
      },
    );
    expect(failedSecondPage).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.handoffs).toEqual([]);
    }
  });

  it("returns a post-invocation item found by the restarted seed's second page", () => {
    resetClock();
    const items = [
      view("old-head", -3_000),
      // Created at the invocation instant but sorted onto the second page.
      { ...view("new-second-page", 0), updatedAt: new Date(-4_000).toISOString() },
    ];
    const ports = portsOf(() => items);
    const paged = (itemsNow: HandoffView[], after: string | null | undefined) => {
      const all = [...itemsNow].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start =
        after === null || after === undefined
          ? 0
          : all.findIndex((item) => `${item.updatedAt}|${item.id}` === after) + 1;
      const slice = all.slice(start, start + 1);
      const last = slice[slice.length - 1];
      return {
        items: slice.map((item) => ({ view: item, contentIntegrity: "ok" as const })),
        lastSortKey: slice.length === 1 && last !== undefined ? `${last.updatedAt}|${last.id}` : null,
      };
    };
    let failedSecondPage = false;
    ports.handoffs.listPage = (_scope, _filters, _limit, after) => {
      if (after !== null && after !== undefined && !failedSecondPage) {
        failedSecondPage = true;
        return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
      }
      return ok(paged(items, after));
    };
    const result = waitForNewInboxItems(
      ports,
      userActor,
      { ...query, limit: 1 },
      {
        intervalSeconds: 1,
        timeoutSeconds: 3,
        sleepMs: (ms) => {
          nowMs += ms;
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["new-second-page"]);
    }
  });

  it("retries a retryable poll failure and returns the arrival that follows", () => {
    resetClock();
    const items = [view("old", -1_000)];
    const ports = portsOf(() => items);
    const inner = ports.handoffs.listPage;
    let listCalls = 0;
    ports.handoffs.listPage = (...args) => {
      listCalls += 1;
      // The seed completes on the first call; the first poll then fails.
      if (listCalls === 2) return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
      return inner(...args);
    };
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 1,
      timeoutSeconds: 10,
      sleepMs: (ms) => {
        nowMs += ms;
        if (nowMs === 2_000) items.push(view("arrival", nowMs));
      },
    });
    expect(listCalls).toBe(3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(false);
      expect(result.value.handoffs.map((handoff) => handoff.id)).toEqual(["arrival"]);
    }
  });

  it("clears an earlier poll failure after a successful empty poll and times out ordinarily", () => {
    resetClock();
    const ports = portsOf(() => []);
    const inner = ports.handoffs.listPage;
    let listCalls = 0;
    ports.handoffs.listPage = (...args) => {
      listCalls += 1;
      // The seed completes first; only the first poll fails.
      if (listCalls === 2) return err(appError("CONTENT_MATERIALIZING", "still activating"));
      return inner(...args);
    };
    let sleeps = 0;
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 1,
      timeoutSeconds: 3,
      sleepMs: (ms) => {
        sleeps += 1;
        nowMs += ms;
      },
    });
    expect(listCalls).toBe(4);
    expect(sleeps).toBe(3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timedOut).toBe(true);
      expect(result.value.handoffs).toEqual([]);
    }
  });

  it("reports a retryable poll failure that persists at the deadline as its typed error", () => {
    resetClock();
    const ports = portsOf(() => []);
    const inner = ports.handoffs.listPage;
    let listCalls = 0;
    ports.handoffs.listPage = (...args) => {
      listCalls += 1;
      // The seed completes on the first call; every subsequent poll fails.
      if (listCalls > 1) return err(appError("STORAGE_INSPECTION_UNAVAILABLE", "busy"));
      return inner(...args);
    };
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 1,
      timeoutSeconds: 2,
      sleepMs: (ms) => {
        nowMs += ms;
      },
    });
    expect(!result.ok && result.error.code).toBe("STORAGE_INSPECTION_UNAVAILABLE");
    expect(listCalls).toBe(3);
  });

  it("returns a non-retryable poll failure immediately", () => {
    resetClock();
    const ports = portsOf(() => []);
    const inner = ports.handoffs.listPage;
    let polls = 0;
    ports.handoffs.listPage = (...args) => {
      polls += 1;
      if (polls === 2) return err(appError("ARTIFACT_CORRUPTED", "corrupt"));
      return inner(...args);
    };
    let sleeps = 0;
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 1,
      timeoutSeconds: 30,
      sleepMs: (ms) => {
        sleeps += 1;
        nowMs += ms;
      },
    });
    expect(!result.ok && result.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(polls).toBe(2);
    expect(sleeps).toBe(1);
  });

  it("measures the deadline from invocation, so a slow seed consumes the budget", () => {
    resetClock();
    const ports = portsOf(() => []);
    const inner = ports.handoffs.listPage;
    let seeded = false;
    ports.handoffs.listPage = (...args) => {
      if (!seeded) {
        seeded = true;
        nowMs += 4_000;
      }
      return inner(...args);
    };
    const result = waitForNewInboxItems(ports, userActor, query, {
      intervalSeconds: 2,
      timeoutSeconds: 5,
      sleepMs: (ms) => {
        nowMs += ms;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.timedOut).toBe(true);
    expect(nowMs).toBe(5_000);
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
