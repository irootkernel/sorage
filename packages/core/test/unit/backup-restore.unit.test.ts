import { describe, expect, it } from "vitest";
import { backupRestore, validateSnapshot } from "../../src/backup-commands";
import { SNAPSHOT_FORMAT_VERSION, type SnapshotData, type SnapshotManifest } from "../../src/backup-snapshot";
import { type AppError, errorSpec } from "../../src/errors";
import type { VaultMarker } from "../../src/vault";

/**
 * The section-32 decision matrix of `backup restore` (BKP-021, RUN-014): a
 * running daemon refuses, a populated target refuses with
 * `RESTORE_TARGET_NOT_EMPTY`, a dry run performs every validation and writes
 * nothing, the writing restore adopts and rebuilds in the crash-convergent
 * order, and an altered Artifact byte aborts before any write.
 */

const marker: VaultMarker = {
  type: "sorage-vault",
  schemaVersion: 1,
  installationId: "source-installation",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function emptyData(): SnapshotData {
  return { projects: [], handoffs: [], events: [] };
}

function manifestOf(data: SnapshotData): SnapshotManifest {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    counts: {
      projects: data.projects.length,
      handoffs: data.handoffs.length,
      events: data.events.length,
      artifacts: data.handoffs.filter((handoff) => handoff.artifact !== null).length,
    },
  };
}

interface Recording {
  calls: string[];
  data: SnapshotData;
  manifest: SnapshotManifest;
  daemonRunning: boolean;
  targetEmpty: boolean;
  verifyFailsWith: AppError | null;
  lockLive: boolean;
}

function fakePorts(recording: Partial<Recording> = {}) {
  const state: Recording = {
    calls: [],
    data: emptyData(),
    manifest: { formatVersion: SNAPSHOT_FORMAT_VERSION, counts: { projects: 0, handoffs: 0, events: 0, artifacts: 0 } },
    daemonRunning: false,
    targetEmpty: true,
    verifyFailsWith: null,
    lockLive: false,
    ...recording,
  };
  return {
    state,
    ports: {
      sourcePath: "/backups/vault-copy",
      installationId: "target-installation",
      daemonRunning: () => ({ ok: true as const, value: state.daemonRunning }),
      lock: {
        acquire: () => {
          state.calls.push("lock.acquire");
          if (state.lockLive) {
            return {
              ok: false as const,
              error: { code: "SERVICE_PAUSED", message: "held", details: {} } as AppError,
            };
          }
          return { ok: true as const, value: { release: () => state.calls.push("lock.release") } };
        },
      },
      readSourceMarker: () => ({ ok: true as const, value: marker }),
      readSourceSnapshot: () => ({ ok: true as const, value: state.data }),
      readSourceManifest: () => ({ ok: true as const, value: state.manifest }),
      targetIsEmpty: () => ({ ok: true as const, value: state.targetEmpty }),
      verifyArtifacts: () => {
        state.calls.push("verifyArtifacts");
        if (state.verifyFailsWith !== null) return { ok: false as const, error: state.verifyFailsWith };
        return { ok: true as const, value: { verified: 0 } };
      },
      copyArtifacts: (data: SnapshotData) => {
        state.calls.push("copyArtifacts");
        return { ok: true as const, value: { copied: data.handoffs.length } };
      },
      adoptMarker: () => {
        state.calls.push("adoptMarker");
        return { ok: true as const, value: undefined };
      },
      adoptInstallationId: () => {
        state.calls.push("adoptInstallationId");
        return { ok: true as const, value: undefined };
      },
      rebuildDatabase: () => {
        state.calls.push("rebuildDatabase");
        return { ok: true as const, value: undefined };
      },
      regenerateApiToken: () => {
        state.calls.push("regenerateApiToken");
        return { ok: true as const, value: undefined };
      },
    },
  };
}

describe("backupRestore", () => {
  it("refuses while the daemon runs, before taking the lock", () => {
    const { ports, state } = fakePorts({ daemonRunning: true });
    const result = backupRestore(ports, { dryRun: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("SERVICE_PAUSED");
    expect(state.calls).toEqual([]);
  });

  it("propagates the pause when another process holds vault-move.lock (RUN-014)", () => {
    const { ports, state } = fakePorts({ lockLive: true });
    const result = backupRestore(ports, { dryRun: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("SERVICE_PAUSED");
    expect(state.calls).toEqual(["lock.acquire"]);
  });

  it("refuses a populated target with RESTORE_TARGET_NOT_EMPTY at exit 75", () => {
    const { ports } = fakePorts({ targetEmpty: false });
    const result = backupRestore(ports, { dryRun: true });
    expect(result.ok).toBe(false);
    const error = !result.ok ? result.error : null;
    expect(error?.code).toBe("RESTORE_TARGET_NOT_EMPTY");
    expect(error ? errorSpec(error.code).exitCode : 0).toBe(75);
  });

  it("aborts on a single altered Artifact byte before any write", () => {
    const { ports, state } = fakePorts({
      verifyFailsWith: { code: "ARTIFACT_CORRUPTED", message: "altered", details: {} },
    });
    const result = backupRestore(ports, { dryRun: false });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("ARTIFACT_CORRUPTED");
    expect(state.calls).toEqual(["lock.acquire", "verifyArtifacts", "lock.release"]);
  });

  it("performs every validation in a dry run and writes nothing", () => {
    const { ports, state } = fakePorts();
    const result = backupRestore(ports, { dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dryRun).toBe(true);
      expect(result.value.adoptedInstallationId).toBe("source-installation");
    }
    expect(state.calls).toEqual(["lock.acquire", "verifyArtifacts", "lock.release"]);
  });

  it("adopts, rebuilds, and regenerates the token in the crash-convergent order", () => {
    const { ports, state } = fakePorts();
    const result = backupRestore(ports, { dryRun: false });
    expect(result.ok).toBe(true);
    if (result.ok && !result.value.dryRun) {
      expect(result.value.events).toEqual(["VAULT_ADOPTED", "RESTORE_COMPLETED"]);
      expect(result.value.apiTokenRegenerated).toBe(true);
      expect(result.value.bindingsRestored).toBe(0);
    }
    expect(state.calls).toEqual([
      "lock.acquire",
      "verifyArtifacts",
      "copyArtifacts",
      "adoptMarker",
      "adoptInstallationId",
      "rebuildDatabase",
      "regenerateApiToken",
      "lock.release",
    ]);
  });
});

describe("validateSnapshot", () => {
  it("rejects a Handoff naming a Project the snapshot does not carry", () => {
    const data: SnapshotData = {
      projects: [],
      handoffs: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          recipientProjectId: "missing-project",
          senderKind: "user",
          senderProjectId: null,
          deletionRequests: [],
          artifact: null,
          reviewNote: null,
        } as unknown as SnapshotData["handoffs"][number],
      ],
      events: [],
    };
    const result = validateSnapshot(data, manifestOf(data));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it("rejects a ledger event naming a Handoff the snapshot does not carry", () => {
    const data: SnapshotData = {
      projects: [],
      handoffs: [],
      events: [
        {
          id: "eeeeeeee-0000-4000-8000-000000000001",
          handoffId: "missing-handoff",
          eventType: "HANDOFF_CREATED",
          actorKind: "user",
          actorId: null,
          rowVersion: 1,
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const result = validateSnapshot(data, manifestOf(data));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });

  it("rejects manifest counts that disagree with the parsed content", () => {
    const data = emptyData();
    const result = validateSnapshot(data, {
      counts: { projects: 3, handoffs: 0, events: 0, artifacts: 0 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VAULT_INTEGRITY_ERROR");
  });
});
