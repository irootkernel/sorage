import { describe, expect, it } from "vitest";
import { type AppError, ok, type Result } from "../../src/errors";
import type { ArtifactReadHandle } from "../../src/artifacts";
import { fetchHandoff, prepareHandoffFetch } from "../../src/handoff-read";
import type { HandoffArtifactSummary, HandoffReadPorts, HandoffView } from "../../src/handoff-read";
import type { NewDomainEvent } from "../../src/events";

/**
 * The serving preparation and settlement order of section 11.3 and HND-012/
 * HND-020: the participant answer comes before the tombstone answer, so a
 * nonparticipant learns nothing about a live or a deleted Handoff — no
 * checksum, no safe acquisition, no first-fetch — while an authorized actor
 * sees HANDOFF_DELETED on a tombstone and acquires nothing. The safe
 * acquisition precedes settlement, so an unsafe or failed open records no
 * first fetch, and the local-path probe closes before the facade settles.
 */

const INSTALLATION = "00000000-0000-4000-8000-0000000000i1";
const SENDER_PROJECT = "00000000-0000-4000-8000-0000000000a1";
const RECIPIENT_PROJECT = "00000000-0000-4000-8000-0000000000b1";
const KEY = "artifacts/h-1/a-1/doc.md";
const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

interface Spies {
  checksumCalls: number;
  openCalls: number;
  probeCloses: number;
  recordCalls: number;
}

function artifactOf(overrides: Partial<HandoffArtifactSummary> = {}): HandoffArtifactSummary {
  return {
    id: "a-1",
    storageKey: KEY,
    originalName: "doc.md",
    mimeType: "text/markdown",
    sizeBytes: 5,
    sha256: SHA,
    materialized: true,
    ...overrides,
  };
}

function viewOf(overrides: Partial<HandoffView> = {}): HandoffView {
  return {
    id: "h-1",
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "The document",
    senderKind: "registered_project",
    senderProjectId: SENDER_PROJECT,
    senderProjectSlug: "alpha",
    senderWorkspaceKey: null,
    senderPathSnapshot: null,
    recipientProjectId: RECIPIENT_PROJECT,
    recipientProjectSlug: "beta",
    revision: 1,
    rowVersion: 1,
    reviewState: "awaiting_recipient",
    nextActors: { reviewNextActor: "recipient", administrativeNextActor: null },
    read: { revision: 1, status: "unrecorded", readAt: null },
    processing: { revision: 1, status: "unrecorded", startedAt: null, completedAt: null },
    comment: null,
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    currentArtifact: artifactOf(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pendingDeletionRequest: false,
    hasReviewNote: false,
    consecutiveNoChangeResolutions: 0,
    ...overrides,
  };
}

function fakeHandle(spies: Spies, closeFails = false): ArtifactReadHandle {
  let closed = false;
  return {
    sizeBytes: 5,
    read: () => ok(new Uint8Array(0)),
    close: () => {
      if (closed) return;
      if (closeFails) throw new Error("injected close failure");
      closed = true;
      spies.probeCloses += 1;
    },
  };
}

function portsOf(
  handoff: HandoffView | null,
  spies: Spies,
  options: { verifyChecksumOnFetch?: boolean; openFails?: boolean; recordFails?: boolean; closeFails?: boolean } = {},
): HandoffReadPorts {
  spies.checksumCalls = 0;
  spies.openCalls = 0;
  spies.probeCloses = 0;
  spies.recordCalls = 0;
  const acquire = (): Result<ArtifactReadHandle, AppError> => {
    spies.openCalls += 1;
    if (options.openFails === true) {
      return { ok: false, error: { code: "ARTIFACT_CORRUPTED", message: "injected open failure" } as AppError };
    }
    return ok(fakeHandle(spies, options.closeFails === true));
  };
  return {
    projectPorts: {
      installationId: INSTALLATION,
      bindings: {
        physicalIdentity: () => null,
        realPath: (path: string) => ok(path),
        absentRealPath: (path: string) => ok(path),
        gitCommonDirectory: () => null,
        resolveDirectory: (path: string) => ok({ directory: path, bindingKind: "directory" as const }),
      },
      projects: {
        listBindings: () => ok([]),
        listProjects: () => ok([]),
        findProjectBySlug: () => ok(null),
        listBindingsForProject: () => ok([]),
      },
      handoffs: { openHandoffCount: () => ({ ok: true, value: 0 }) },
    } as never,
    handoffs: {
      listPage: () => ok({ items: [], lastSortKey: null }),
      findHandoffView: () => ok(handoff),
      loadHandoff: () => ok(handoff === null ? null : { view: handoff, contentIntegrity: "ok" }),
      recordFirstFetch: (_handoffId: string, _event: NewDomainEvent): Result<void, AppError> => {
        spies.recordCalls += 1;
        if (options.recordFails === true) {
          return { ok: false, error: { code: "INTERNAL_ERROR", message: "injected settlement failure" } as AppError };
        }
        return ok(undefined);
      },
    },
    config: { vaultPath: "/vault", verifyChecksumOnFetch: options.verifyChecksumOnFetch === true },
    artifact: {
      verifyArtifactBody: () => {
        spies.checksumCalls += 1;
        return ok(undefined);
      },
      localPathOfArtifact: () => {
        const probe = acquire();
        if (!probe.ok) return probe;
        try {
          probe.value.close();
        } catch {
          return { ok: false, error: { code: "ARTIFACT_CORRUPTED", message: "injected close failure" } as AppError };
        }
        return ok(`/vault/${KEY}`);
      },
      openArtifactBody: acquire,
    },
    ids: { next: () => "event-1" },
    clock: { now: () => new Date("2026-01-02T00:00:00.000Z") },
  } as HandoffReadPorts;
}

const userActor = { path: "/w", userHome: "/h", as: undefined, asUser: true };
const outsiderActor = { path: "/nowhere", userHome: "/h", as: undefined, asUser: false };

describe("prepareHandoffFetch participant privacy and acquisition order", () => {
  it("answers a nonparticipant with HANDOFF_NOT_FOUND for a live Handoff without any content work", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf(), spies);
    const prepared = prepareHandoffFetch(ports, outsiderActor, "h-1", { kind: "body" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("HANDOFF_NOT_FOUND");
    expect(spies.checksumCalls).toBe(0);
    expect(spies.openCalls).toBe(0);
    expect(spies.recordCalls).toBe(0);
  });

  it("answers a nonparticipant with HANDOFF_NOT_FOUND, not HANDOFF_DELETED, on a tombstone", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const tombstone = viewOf({ deletedAt: "2026-01-03T00:00:00.000Z" });
    const ports = portsOf(tombstone, spies);
    const viaBody = prepareHandoffFetch(ports, outsiderActor, "h-1", { kind: "body" });
    expect(viaBody.ok).toBe(false);
    if (viaBody.ok) return;
    expect(viaBody.error.code).toBe("HANDOFF_NOT_FOUND");
    const viaFetch = fetchHandoff(ports, outsiderActor, "h-1");
    expect(viaFetch.ok).toBe(false);
    if (viaFetch.ok) return;
    expect(viaFetch.error.code).toBe("HANDOFF_NOT_FOUND");
    expect(spies.checksumCalls).toBe(0);
    expect(spies.openCalls).toBe(0);
    expect(spies.recordCalls).toBe(0);
  });

  it("keeps HANDOFF_DELETED for an authorized actor on a tombstone with no acquisition", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const tombstone = viewOf({ deletedAt: "2026-01-03T00:00:00.000Z" });
    const ports = portsOf(tombstone, spies);
    const prepared = prepareHandoffFetch(ports, userActor, "h-1", { kind: "body" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("HANDOFF_DELETED");
    expect(spies.openCalls).toBe(0);
    expect(spies.recordCalls).toBe(0);
  });

  it("keeps HANDOFF_NOT_FOUND for a missing id", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(null, spies);
    const prepared = prepareHandoffFetch(ports, userActor, "missing", { kind: "body" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("HANDOFF_NOT_FOUND");
  });

  it("keeps ARTIFACT_MATERIALIZING for a present unmaterialized Artifact without acquisition", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf({ currentArtifact: artifactOf({ materialized: false }) }), spies);
    const prepared = prepareHandoffFetch(ports, userActor, "h-1", { kind: "body" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("ARTIFACT_MATERIALIZING");
    expect(spies.openCalls).toBe(0);
  });

  it("delegates the if-configured checksum policy to body acquisition before settlement", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf(), spies, { verifyChecksumOnFetch: true });
    ports.artifact.openArtifactBody = (artifactId, policy) => {
      expect(artifactId).toBe("a-1");
      expect(policy).toEqual({ verifyFileDigest: "if-configured", verifyChecksumOnFetch: true });
      spies.openCalls += 1;
      spies.checksumCalls += 1;
      return { ok: false, error: { code: "ARTIFACT_CORRUPTED", message: "injected checksum mismatch" } as AppError };
    };
    const prepared = prepareHandoffFetch(ports, userActor, "h-1", { kind: "body" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(spies.checksumCalls).toBe(1);
    expect(spies.openCalls).toBe(1);
    expect(spies.recordCalls).toBe(0);
  });

  it("fails an unsafe or missing open before any settlement", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf(), spies, { openFails: true });
    const viaBody = prepareHandoffFetch(ports, userActor, "h-1", { kind: "body" });
    expect(viaBody.ok).toBe(false);
    if (viaBody.ok) return;
    expect(viaBody.error.code).toBe("ARTIFACT_CORRUPTED");
    const viaFacade = fetchHandoff(portsOf(viewOf(), spies, { openFails: true }), userActor, "h-1");
    expect(viaFacade.ok).toBe(false);
    if (viaFacade.ok) return;
    expect(viaFacade.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(spies.recordCalls).toBe(0);
  });

  it("closes the local-path probe before the facade settles", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf(), spies);
    const prepared = prepareHandoffFetch(ports, userActor, "h-1", { kind: "local-path" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.kind).toBe("local-path");
    if (prepared.value.kind !== "local-path") return;
    // The probe has already closed by the time preparation succeeds, so no
    // descriptor outlives the facade and settlement follows a finished close.
    expect(spies.probeCloses).toBe(1);
    expect(spies.recordCalls).toBe(0);
    const settled = prepared.value.settleFirstFetch();
    expect(settled.ok).toBe(true);
    expect(spies.recordCalls).toBe(1);
    // The returned path is the readable notation the facade contract promises.
    expect(prepared.value.localPath).toBe(`/vault/${KEY}`);
  });

  it("settles current reading even when a historical first fetch already exists", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const fetched = fetchHandoff(portsOf(viewOf(), spies), userActor, "h-1");
    expect(fetched.ok).toBe(true);
    expect(spies.recordCalls).toBe(1);
    // Historical first fetch never substitutes for current-Revision evidence.
    const again = fetchHandoff(
      portsOf(viewOf({ firstFetchedAt: "2026-01-02T00:00:00.000Z" }), spies),
      userActor,
      "h-1",
    );
    expect(again.ok).toBe(true);
    expect(spies.recordCalls).toBe(1);
  });

  it("propagates a settlement failure through the facade after the probe closed", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf(), spies, { recordFails: true });
    const fetched = fetchHandoff(ports, userActor, "h-1");
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.code).toBe("INTERNAL_ERROR");
    expect(spies.probeCloses).toBe(1);
  });

  it("fails preparation when the probe close fails, before any settlement", () => {
    const spies: Spies = { checksumCalls: 0, openCalls: 0, probeCloses: 0, recordCalls: 0 };
    const ports = portsOf(viewOf(), spies, { closeFails: true });
    const prepared = prepareHandoffFetch(ports, userActor, "h-1", { kind: "local-path" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(spies.recordCalls).toBe(0);
    const viaFacade = fetchHandoff(portsOf(viewOf(), spies, { closeFails: true }), userActor, "h-1");
    expect(viaFacade.ok).toBe(false);
    if (viaFacade.ok) return;
    expect(viaFacade.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(spies.recordCalls).toBe(0);
  });
});
