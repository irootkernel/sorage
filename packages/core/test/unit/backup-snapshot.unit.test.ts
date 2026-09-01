import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonLine,
  handoffShardPath,
  parseSnapshotManifest,
  redactEventMetadata,
  redactSnapshotData,
  type SnapshotData,
  snapshotFiles,
  snapshotManifest,
} from "../../src/backup-snapshot";

/**
 * The determinism and redaction contract of sections 26 and 27 (BKP-003,
 * BKP-024): two exports of unchanged data are byte-identical, keys sort
 * lexicographically at every level, LF endings hold everywhere, and the
 * redaction policy removes exactly the machine-local paths while stable
 * identifiers survive.
 */

function handoffOf(
  id: string,
  overrides: Partial<SnapshotData["handoffs"][number]> = {},
): SnapshotData["handoffs"][number] {
  return {
    id,
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "Brief",
    senderKind: "registered_project",
    senderProjectId: "11111111-1111-4111-8111-111111111111",
    senderWorkspaceKey: null,
    senderPathSnapshot: "/Users/someone/work/web-app",
    recipientProjectId: "22222222-2222-4222-8222-222222222222",
    currentArtifactId: `${id}-artifact`,
    revision: 1,
    rowVersion: 1,
    reviewState: "awaiting_recipient",
    acceptedRevision: null,
    acceptedAt: null,
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    consecutiveNoChangeResolutions: 0,
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    artifact: {
      id: `${id}-artifact`,
      handoffId: id,
      storageKey: `artifacts/${id}/${id}-artifact/brief.md`,
      originalName: "brief.md",
      storedName: "brief.md",
      mimeType: "text/markdown",
      sizeBytes: 7,
      sha256: "a".repeat(64),
      importedFromPath: "/Users/someone/work/web-app/brief.md",
      materialized: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    reviewNote: null,
    deletionRequests: [],
    ...overrides,
  };
}

function sampleData(): SnapshotData {
  return {
    projects: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        slug: "beta",
        displayName: "Beta",
        description: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        bindings: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            installationId: "99999999-9999-4999-8999-999999999999",
            bindingKind: "directory",
            directory: "/Users/someone/work/beta",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
    handoffs: [
      handoffOf("aaaaaaaa-0000-4000-8000-000000000001"),
      handoffOf("abbbbbbb-0000-4000-8000-000000000002", {
        reviewState: "changes_requested",
        reviewNote: {
          handoffId: "abbbbbbb-0000-4000-8000-000000000002",
          authorKind: "registered_project",
          authorProjectId: "22222222-2222-4222-8222-222222222222",
          targetRevision: 1,
          body: "Tighten",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    ],
    events: [
      {
        id: "eeeeeeee-0000-4000-8000-000000000002",
        handoffId: "aaaaaaaa-0000-4000-8000-000000000001",
        eventType: "HANDOFF_CREATED",
        actorKind: "registered_project",
        actorId: "11111111-1111-4111-8111-111111111111",
        rowVersion: 1,
        metadata: {
          fromPath: "/moved/from",
          toPath: "/moved/to",
          storageKey: "artifacts/x",
          nested: { directory: "/work", count: 2 },
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        handoffId: null,
        eventType: "VAULT_MOVED",
        actorKind: "user",
        actorId: null,
        rowVersion: null,
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("canonicalJson", () => {
  it("sorts keys lexicographically at every level, indents two spaces, and ends with one LF", () => {
    const printed = canonicalJson({ zebra: 1, alpha: { second: { b: 2, a: 1 }, first: true } });
    expect(printed).toBe(
      [
        "{",
        '  "alpha": {',
        '    "first": true,',
        '    "second": {',
        '      "a": 1,',
        '      "b": 2',
        "    }",
        "  },",
        '  "zebra": 1',
        "}",
        "",
      ].join("\n"),
    );
    expect(printed.endsWith("\n")).toBe(true);
    expect(printed.includes("\r")).toBe(false);
  });

  it("prints the compact one-line form for the ledger", () => {
    expect(canonicalJsonLine({ b: 2, a: 1 })).toBe('{"a":1,"b":2}\n');
  });
});

describe("redaction (BKP-003)", () => {
  it("drops the sender path snapshot, every binding directory, and metadata path fields recursively", () => {
    const redacted = redactSnapshotData(sampleData());
    const handoff = redacted.handoffs[0] as SnapshotData["handoffs"][number];
    const project = redacted.projects[0] as SnapshotData["projects"][number];
    const event = redacted.events[0] as SnapshotData["events"][number];
    expect(handoff.senderPathSnapshot).toBeUndefined();
    expect("senderPathSnapshot" in handoff).toBe(false);
    expect("directory" in (project.bindings[0] as SnapshotData["projects"][number]["bindings"][number])).toBe(false);
    expect(event.metadata).toEqual({ storageKey: "artifacts/x", nested: { count: 2 } });
  });

  it("keeps stable identifiers such as storageKey and the workspace key", () => {
    const redacted = redactEventMetadata({ storageKey: "artifacts/x", workspaceKey: "abc", title: "Brief" });
    expect(redacted).toEqual({ storageKey: "artifacts/x", workspaceKey: "abc", title: "Brief" });
  });
});

describe("snapshotFiles", () => {
  it("is byte-identical across two exports of unchanged data", () => {
    expect(snapshotFiles(sampleData())).toEqual(snapshotFiles(sampleData()));
  });

  it("shards handoffs by the first two hex characters of the id and names the file after it", () => {
    expect(handoffShardPath("aaaaaaaa-0000-4000-8000-000000000001")).toBe(
      "handoffs/aa/aaaaaaaa-0000-4000-8000-000000000001.json",
    );
    const paths = snapshotFiles(sampleData()).map((file) => file.path);
    expect(paths).toContain("projects.json");
    expect(paths).toContain("handoffs/aa/aaaaaaaa-0000-4000-8000-000000000001.json");
    expect(paths).toContain("handoffs/ab/abbbbbbb-0000-4000-8000-000000000002.json");
    expect(paths).toContain("events.jsonl");
    expect(paths).toContain("manifest.json");
  });

  it("orders the ledger by createdAt then id, one compact object per LF-terminated line", () => {
    const events = snapshotFiles(sampleData()).find((file) => file.path === "events.jsonl");
    expect(events).toBeDefined();
    const lines = (events as { content: string }).content.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string) as { id: string };
    const second = JSON.parse(lines[1] as string) as { id: string };
    expect(first.id).toBe("eeeeeeee-0000-4000-8000-000000000001");
    expect(second.id).toBe("eeeeeeee-0000-4000-8000-000000000002");
    expect(lines[0]).not.toContain("  ");
  });

  it("carries only the format version and the derived counts in manifest.json", () => {
    const manifestFile = snapshotFiles(sampleData()).find((file) => file.path === "manifest.json");
    expect(manifestFile).toBeDefined();
    const manifest = JSON.parse((manifestFile as { content: string }).content) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["counts", "formatVersion"]);
    expect(manifest.counts).toEqual({ projects: 1, handoffs: 2, events: 2, artifacts: 2 });
  });

  it("never embeds an export timestamp, hostname, username, or duration anywhere", () => {
    const files = snapshotFiles(sampleData());
    // Row timestamps are data; an export timestamp would be the only value that
    // changes between two exports of unchanged rows, so the manifest — the one
    // file with no row fields at all — must carry no timestamp, and no file may
    // name the generating host, process, or duration.
    const manifestFile = files.find((file) => file.path === "manifest.json");
    expect(manifestFile).toBeDefined();
    expect((manifestFile as { content: string }).content).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    for (const file of files) {
      expect(file.content.toLowerCase()).not.toContain("hostname");
      expect(file.content.toLowerCase()).not.toContain("durationms");
      expect(file.content).not.toContain(String(process.pid));
    }
  });
});

describe("parseSnapshotManifest", () => {
  it("accepts the manifest this build writes", () => {
    const manifest = snapshotManifest(sampleData());
    const parsed = parseSnapshotManifest(canonicalJson(manifest));
    expect(parsed.ok && parsed.value).toEqual(manifest);
  });

  it("classifies a newer snapshot format as VAULT_SCHEMA_UNSUPPORTED", () => {
    const raw = canonicalJson({ formatVersion: 99, counts: { projects: 0, handoffs: 0, events: 0, artifacts: 0 } });
    const parsed = parseSnapshotManifest(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.code).toBe("VAULT_SCHEMA_UNSUPPORTED");
  });

  it("rejects malformed counts as VAULT_INTEGRITY_ERROR", () => {
    const parsed = parseSnapshotManifest('{"formatVersion":1,"counts":{"projects":"many"}}');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });
});
