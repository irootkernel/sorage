import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AppError, err, ok } from "../../src/errors";
import { sendHandoffs, sendRequestHash, type SendInput, type SendPorts } from "../../src/handoff-commands";
import {
  fetchHandoff,
  getHandoff,
  resolveHandoffParticipantRole,
  type HandoffReadPorts,
  type HandoffView,
  type ReadActorInput,
} from "../../src/handoff-read";
import type { ProjectCommandPorts } from "../../src/project-commands";
import type { Project, ProjectBinding } from "../../src/projects";
import { reportingRole, setRecipientComment } from "../../src/reporting-commands";
import { requestDeletion, type RetentionPorts } from "../../src/retention-commands";
import { setReviewNote, type ReviewPorts } from "../../src/review-commands";
import { reviseHandoff, type RevisionPorts } from "../../src/revision-commands";
import { acceptHandoff, declineHandoff, withdrawHandoff, type TerminalPorts } from "../../src/terminal-commands";
import { workspaceKey } from "../../src/primitives/identity";

const INSTALLATION = "00000000-0000-4000-8000-0000000000i1";
const ALPHA_ID = "00000000-0000-4000-8000-0000000000a1";
const BETA_ID = "00000000-0000-4000-8000-0000000000b1";
const ARCHIVED_ID = "00000000-0000-4000-8000-0000000000c1";
const SELF_RECOVERY = "Choose a different --to recipient Project, or send with --as <other-project> or --as-user";
const NOW = "2026-11-22T00:00:00.000Z";

function makeProject(id: string, slug: string, status: "active" | "archived" = "active"): Project {
  return {
    id,
    slug,
    displayName: slug,
    description: null,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeBinding(
  id: string,
  projectId: string,
  directory: string,
  bindingKind: "directory" | "git_repository" = "directory",
): ProjectBinding {
  return {
    id,
    projectId,
    installationId: INSTALLATION,
    directory,
    bindingKind,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeProjectPorts(
  projects: Project[],
  bindings: ProjectBinding[],
  spies?: {
    listProjects?: number;
    listBindings?: number;
    findProjectBySlug?: number;
    listBindingsForProject?: number;
    realPath?: number;
    failListBindingsForProject?: boolean;
  },
): ProjectCommandPorts {
  return {
    installationId: INSTALLATION,
    vaultPath: "/vault",
    clock: { now: () => new Date(NOW) },
    ids: { next: () => "id-1" },
    bindings: {
      physicalIdentity: () => null,
      realPath: (path) => {
        if (spies) spies.realPath = (spies.realPath ?? 0) + 1;
        return ok(path);
      },
      absentRealPath: (path) => ok(path),
      gitCommonDirectory: (path) => {
        const match = bindings.find(
          (b) => b.bindingKind === "git_repository" && path.startsWith(b.directory.replace(/\/\.git$/, "")),
        );
        return match ? match.directory : null;
      },
      resolveDirectory: (path) => ok({ directory: path, bindingKind: "directory" as const }),
    },
    projects: {
      createProject: () => {
        throw new Error("unused");
      },
      createProjectWithBinding: () => {
        throw new Error("unused");
      },
      findProjectBySlug: (slug) => {
        if (spies) spies.findProjectBySlug = (spies.findProjectBySlug ?? 0) + 1;
        return ok(projects.find((p) => p.slug === slug.toLowerCase()) ?? null);
      },
      listProjects: () => {
        if (spies) spies.listProjects = (spies.listProjects ?? 0) + 1;
        return ok(projects);
      },
      updateProjectDisplayName: () => {
        throw new Error("unused");
      },
      updateProjectStatus: () => {
        throw new Error("unused");
      },
      addBinding: () => {
        throw new Error("unused");
      },
      replaceBinding: () => {
        throw new Error("unused");
      },
      removeBinding: () => {
        throw new Error("unused");
      },
      listBindings: () => {
        if (spies) spies.listBindings = (spies.listBindings ?? 0) + 1;
        return ok(bindings);
      },
      listBindingsForProject: (projectId) => {
        if (spies) spies.listBindingsForProject = (spies.listBindingsForProject ?? 0) + 1;
        if (spies?.failListBindingsForProject) {
          return err({ code: "INTERNAL_ERROR", message: "injected binding read failure" } as AppError);
        }
        return ok(bindings.filter((b) => b.projectId === projectId));
      },
    },
    handoffs: { openHandoffCount: () => ok(0) },
  };
}

function makeHandoffView(overrides: Partial<HandoffView> = {}): HandoffView {
  return {
    id: "h-1",
    dispatchGroupId: null,
    supersedesHandoffId: null,
    title: "Spec",
    senderKind: "registered_project",
    senderProjectId: ALPHA_ID,
    senderProjectSlug: "alpha",
    senderWorkspaceKey: null,
    senderPathSnapshot: null,
    recipientProjectId: BETA_ID,
    recipientProjectSlug: "beta",
    revision: 1,
    rowVersion: 1,
    reviewState: "awaiting_recipient",
    nextActors: { reviewNextActor: "recipient", administrativeNextActor: null },
    read: { revision: 1, status: "unconfirmed", readAt: null },
    processing: { revision: 1, status: "not_started", startedAt: null, completedAt: null },
    comment: null,
    firstFetchedAt: null,
    reviewEngagedAt: null,
    pinned: false,
    archivedAt: null,
    deletedAt: null,
    currentArtifact: {
      id: "a-1",
      storageKey: null,
      originalName: "spec-1.md",
      mimeType: "text/markdown",
      sizeBytes: 5,
      sha256: createHash("sha256").update("hello").digest("hex"),
      materialized: true,
    },
    createdAt: NOW,
    updatedAt: NOW,
    pendingDeletionRequest: false,
    hasReviewNote: false,
    consecutiveNoChangeResolutions: 0,
    ...overrides,
  };
}

function makeSendFixture(
  options: {
    projects?: Project[];
    bindings?: ProjectBinding[];
    replayRecord?: { requestHash: string; responseJson: string } | null;
  } = {},
) {
  const projects = options.projects ?? [
    makeProject(ALPHA_ID, "alpha"),
    makeProject(BETA_ID, "beta"),
    makeProject(ARCHIVED_ID, "archived", "archived"),
  ];
  const bindings = options.bindings ?? [
    makeBinding("b-alpha", ALPHA_ID, "/workspaces/alpha"),
    makeBinding("b-beta", BETA_ID, "/workspaces/beta"),
    makeBinding("b-archived", ARCHIVED_ID, "/workspaces/archived"),
  ];
  const spies = {
    supersedesLookups: 0,
    prepareCalls: 0,
    createFanoutCalls: 0,
  };
  let seq = 0;
  const ports: SendPorts = {
    projectPorts: makeProjectPorts(projects, bindings),
    handoffs: {
      findSupersedesTarget: () => {
        spies.supersedesLookups += 1;
        return ok(null);
      },
      idempotencyLookup: () => ok(options.replayRecord ?? null),
      senderOfHandoff: () => ok({ kind: "registered_project", projectId: ALPHA_ID, workspaceKey: null }),
      createFanout: (commit) => {
        spies.createFanoutCalls += 1;
        return ok({ recorded: commit.handoffs.length });
      },
      completeActivations: () => ok({ completed: 0 }),
    },
    artifactStore: {
      stage: () => {
        throw new Error("unused");
      },
      activate: () => {
        throw new Error("unused");
      },
      remove: () => ok(undefined),
      pathOf: (storageKey) => ok(`/vault/${storageKey}`),
      openReadable: () => {
        throw new Error("unused");
      },
      exists: () => ok(false),
      checksum: () => ok("0".repeat(64)),
    },
    content: {
      prepareArtifactBody: () => {
        spies.prepareCalls += 1;
        return ok({
          kind: "inline" as const,
          text: "hello",
          logicalName: "brief-1.md",
          mimeType: "text/markdown",
          sizeBytes: 5,
          sha256: createHash("sha256").update("hello").digest("hex"),
          storageKey: null,
          importedFromPath: null,
        });
      },
    },
    ids: { next: () => `id-${++seq}` },
    clock: { now: () => new Date(NOW) },
    config: { vaultPath: "/vault", maxBytes: 1024 * 1024, allowUnregisteredSenders: false },
    bindingDirectories: bindings.map((b) => b.directory),
    inspectSource: (path) => ok({ resolvedSourcePath: path, originalName: "doc.md" }),
    digestSource: () => ok(createHash("sha256").update("hello").digest("hex")),
  };
  const baseInput: SendInput = {
    to: ["beta"],
    title: "Brief",
    body: "hello",
    allowExternalSource: false,
    allowUnregistered: false,
    path: "/workspaces/alpha",
    userHome: "/home/tester",
  };
  return { ports, spies, baseInput };
}

describe("HND-027 self-handoff prohibition in sendHandoffs", () => {
  it("refuses single and case-insensitive self-handoff via cwd and --as with site-specific recovery and details", () => {
    for (const overrides of [
      { to: ["alpha"], path: "/workspaces/alpha" },
      { to: ["ALPHA"], path: "/workspaces/alpha" },
      { to: ["alpha"], path: "/unregistered", as: "alpha" },
      { to: ["ALPHA"], path: "/unregistered", as: "Alpha" },
    ] satisfies Array<Partial<SendInput>>) {
      const { ports, spies, baseInput } = makeSendFixture();
      const result = sendHandoffs(ports, { ...baseInput, ...overrides });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("HANDOFF_INVALID_INPUT");
      expect(result.error.details).toEqual({ senderProjectId: ALPHA_ID, recipientSlug: "alpha" });
      expect(result.error.recovery).toEqual({ suggestedCommand: SELF_RECOVERY });
      expect(spies.supersedesLookups).toBe(0);
      expect(spies.prepareCalls).toBe(0);
      expect(spies.createFanoutCalls).toBe(0);
    }
  });

  it("refuses multi-recipient fan-out all-or-nothing when any recipient equals sender, before supersedes/staging/writes", () => {
    const { ports, spies, baseInput } = makeSendFixture();
    const result = sendHandoffs(ports, {
      ...baseInput,
      to: ["beta", "ALPHA"],
      supersedes: "missing-supersedes-id",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HANDOFF_INVALID_INPUT");
    expect(result.error.details).toEqual({ senderProjectId: ALPHA_ID, recipientSlug: "alpha" });
    expect(result.error.recovery).toEqual({ suggestedCommand: SELF_RECOVERY });
    expect(spies.supersedesLookups).toBe(0);
    expect(spies.prepareCalls).toBe(0);
    expect(spies.createFanoutCalls).toBe(0);
  });

  it("evaluates replay, archived sender, and recipient eligibility BEFORE self-handoff refusal", () => {
    // 1. Pre-M11 recorded self-handoff idempotency replay still succeeds.
    const bodySha = createHash("sha256").update("hello").digest("hex");
    const requestHash = sendRequestHash({
      to: ["alpha"],
      title: "Brief",
      contentSha256: bodySha,
      kind: "body",
      sender: `registered_project:${ALPHA_ID}`,
    });
    const replayOutcome = {
      handoffs: [
        {
          handoffId: "h-pre-m11",
          recipientSlug: "alpha",
          artifactId: "a-pre-m11",
          storageKey: null,
          revision: 1,
          rowVersion: 1,
          reviewState: "awaiting_recipient",
        },
      ],
      dispatchGroupId: null,
      replayed: false,
    };
    const replayFixture = makeSendFixture({
      replayRecord: { requestHash, responseJson: JSON.stringify(replayOutcome) },
    });
    const replayed = sendHandoffs(replayFixture.ports, {
      ...replayFixture.baseInput,
      to: ["alpha"],
      idempotencyKey: "k-pre-m11",
    });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.replayed).toBe(true);
      expect(replayed.value.handoffs[0]?.handoffId).toBe("h-pre-m11");
    }

    // 2. Archived sender sending to itself still reports PROJECT_ARCHIVED.
    const archivedFixture = makeSendFixture();
    const archivedRes = sendHandoffs(archivedFixture.ports, {
      ...archivedFixture.baseInput,
      to: ["archived"],
      path: "/workspaces/archived",
    });
    expect(archivedRes.ok).toBe(false);
    if (!archivedRes.ok) expect(archivedRes.error.code).toBe("PROJECT_ARCHIVED");

    // 3. Ineligible recipient in fan-out reports UNREGISTERED_RECIPIENT before self-handoff.
    const ineligibleFixture = makeSendFixture();
    const ineligibleRes = sendHandoffs(ineligibleFixture.ports, {
      ...ineligibleFixture.baseInput,
      to: ["alpha", "ghost"],
    });
    expect(ineligibleRes.ok).toBe(false);
    if (!ineligibleRes.ok) expect(ineligibleRes.error.code).toBe("UNREGISTERED_RECIPIENT");
  });

  it("still permits --as-user and unregistered-Workspace sends", () => {
    const userFixture = makeSendFixture();
    const userRes = sendHandoffs(userFixture.ports, {
      ...userFixture.baseInput,
      to: ["alpha"],
      asUser: true,
    });
    expect(userRes.ok).toBe(true);
    expect(userFixture.spies.createFanoutCalls).toBe(1);

    const wsFixture = makeSendFixture();
    const wsRes = sendHandoffs(wsFixture.ports, {
      ...wsFixture.baseInput,
      to: ["alpha"],
      path: "/unregistered/ws",
      allowUnregistered: true,
    });
    expect(wsRes.ok).toBe(true);
    expect(wsFixture.spies.createFanoutCalls).toBe(1);
  });
});

describe("unified resolveHandoffParticipantRole across all 5 core modules", () => {
  function makeAllPorts(
    handoff: HandoffView,
    projects: Project[],
    bindings: ProjectBinding[],
    spies?: {
      firstFetchCalls?: number;
      listProjects?: number;
      listBindings?: number;
      findProjectBySlug?: number;
      listBindingsForProject?: number;
      realPath?: number;
      failListBindingsForProject?: boolean;
    },
  ) {
    const projectPorts = makeProjectPorts(projects, bindings, spies);
    const readPorts: HandoffReadPorts = {
      projectPorts,
      handoffs: {
        listPage: () => ok({ items: [], lastSortKey: null }),
        findHandoffView: () => ok(handoff),
        loadHandoff: () => ok({ view: handoff, contentIntegrity: "ok" }),
        recordFirstFetch: () => {
          if (spies) spies.firstFetchCalls = (spies.firstFetchCalls ?? 0) + 1;
          return ok(undefined);
        },
      },
      config: { vaultPath: "/vault", verifyChecksumOnFetch: false },
      artifact: {
        verifyArtifactBody: () => ok(undefined),
        localPathOfArtifact: () => ok("/vault/artifacts/h-1/a-1/spec-1.md"),
        openArtifactBody: () => ok({ sizeBytes: 5, read: () => ok(new Uint8Array(0)), close: () => undefined }),
      },
      ids: { next: () => "ev-1" },
      clock: { now: () => new Date(NOW) },
    };
    const revisionPorts: RevisionPorts = {
      ...readPorts,
      revisions: {
        idempotencyLookup: () => ok(null),
        applyContentRevision: () => ok({ revision: handoff.revision + 1, rowVersion: handoff.rowVersion + 1 }),
        applyNoChangeResolution: () => ok({ rowVersion: handoff.rowVersion + 1 }),
        completeActivations: () => ok({ completed: 0 }),
        completeUnlinks: () => ok({ completed: 0 }),
      },
      artifactStore: {
        activate: () => {
          throw new Error("unused");
        },
        remove: () => ok(undefined),
      },
      content: {
        prepareArtifactBody: () =>
          ok({
            kind: "inline" as const,
            text: "revised",
            logicalName: "spec-2.md",
            mimeType: "text/markdown",
            sizeBytes: 7,
            sha256: createHash("sha256").update("revised").digest("hex"),
            storageKey: null,
            importedFromPath: null,
          }),
      },
      config: { ...readPorts.config, maxBytes: 1024 * 1024 },
      bindingDirectories: bindings.map((b) => b.directory),
      digestSource: () => ok(createHash("sha256").update("revised").digest("hex")),
    };
    const terminalPorts: TerminalPorts = {
      ...readPorts,
      terminals: {
        applyTerminalTransition: (input) => ok({ rowVersion: input.expectedRowVersion + 1 }),
      },
    };
    const retentionPorts: RetentionPorts = {
      ...readPorts,
      artifact: { ...readPorts.artifact, remove: () => ok(undefined) },
      retention: {
        idempotencyLookup: () => ok(null),
        findPendingRequest: () => ok(null),
        applyRetentionMutation: (input) => ok({ rowVersion: input.expectedRowVersion + 1 }),
        completeUnlink: () => ok({ completed: 0 }),
      },
    };
    const reviewPorts: ReviewPorts = {
      ...readPorts,
      reviews: {
        findNote: () => ok(null),
        findComment: () => ok(null),
        applyReportMutation: (input) => ok({ rowVersion: input.expectedRowVersion + 1 }),
      },
    };
    return { readPorts, revisionPorts, terminalPorts, retentionPorts, reviewPorts };
  }

  it("calls resolveWorkspaceActor once (not multiple times) during participant role resolution", () => {
    const spies = { realPath: 0, listBindings: 0, listProjects: 0, listBindingsForProject: 0 };
    const projects = [makeProject(ALPHA_ID, "alpha"), makeProject(BETA_ID, "beta")];
    const bindings = [
      makeBinding("b-alpha", ALPHA_ID, "/workspaces/alpha"),
      makeBinding("b-beta", BETA_ID, "/workspaces/beta"),
    ];
    const handoff = makeHandoffView();
    const { readPorts } = makeAllPorts(handoff, projects, bindings, spies);

    const role = resolveHandoffParticipantRole(
      readPorts,
      { path: "/workspaces/beta", userHome: "/home/tester", as: undefined, asUser: false },
      handoff,
    );
    expect(role).toEqual(ok("recipient"));
    expect(spies.realPath).toBe(1);
    expect(spies.listBindings).toBe(1);
    expect(spies.listProjects).toBe(1);
    expect(spies.listBindingsForProject).toBe(0);
  });

  it("resolves pre-M11 legacy self-handoff rows deterministically as recipient across all 5 modules", () => {
    const spies = { firstFetchCalls: 0 };
    const projects = [makeProject(ALPHA_ID, "alpha")];
    const bindings = [makeBinding("b-alpha", ALPHA_ID, "/workspaces/alpha")];
    const legacySelf = makeHandoffView({
      senderKind: "registered_project",
      senderProjectId: ALPHA_ID,
      senderProjectSlug: "alpha",
      recipientProjectId: ALPHA_ID,
      recipientProjectSlug: "alpha",
    });
    const { readPorts, revisionPorts, terminalPorts, retentionPorts, reviewPorts } = makeAllPorts(
      legacySelf,
      projects,
      bindings,
      spies,
    );
    const actor: ReadActorInput = { path: "/workspaces/alpha", userHome: "/home/tester", as: undefined, asUser: false };

    // Direct helper and reportingRole agree on "recipient".
    expect(resolveHandoffParticipantRole(readPorts, actor, legacySelf)).toEqual(ok("recipient"));
    expect(reportingRole(readPorts, actor, legacySelf)).toEqual(ok("recipient"));

    // 1. Read + fetch: recipient fetch settles firstFetchedAt.
    expect(getHandoff(readPorts, actor, "h-1").ok).toBe(true);
    expect(fetchHandoff(readPorts, actor, "h-1").ok).toBe(true);
    expect(spies.firstFetchCalls).toBe(1);

    // 2. Revision: recipient is refused with FORBIDDEN_ACTOR (consistent with recipient precedence).
    const revised = reviseHandoff(revisionPorts, {
      ...actor,
      handoffId: "h-1",
      body: "revised",
      expectedRowVersion: 1,
    });
    expect(revised.ok).toBe(false);
    if (!revised.ok) expect(revised.error.code).toBe("FORBIDDEN_ACTOR");

    // 3. Terminal: recipient can accept/decline and is refused withdraw as FORBIDDEN_ACTOR.
    expect(
      acceptHandoff(terminalPorts, { ...actor, handoffId: "h-1", expectedRevision: 1, expectedRowVersion: 1 }).ok,
    ).toBe(true);
    expect(
      declineHandoff(terminalPorts, { ...actor, handoffId: "h-1", reason: "nope", expectedRowVersion: 1 }).ok,
    ).toBe(true);
    const withdrawn = withdrawHandoff(terminalPorts, { ...actor, handoffId: "h-1", expectedRowVersion: 1 });
    expect(withdrawn.ok).toBe(false);
    if (!withdrawn.ok) expect(withdrawn.error.code).toBe("FORBIDDEN_ACTOR");

    // 4. Retention: recipient can request deletion.
    expect(requestDeletion(retentionPorts, { ...actor, handoffId: "h-1", expectedRowVersion: 1 }).ok).toBe(true);

    // 5. Reporting & Review: recipient can author comment / review note.
    expect(
      setRecipientComment(reviewPorts, {
        ...actor,
        handoffId: "h-1",
        text: "Looks good",
        expectedRevision: 1,
        expectedRowVersion: 1,
      }).ok,
    ).toBe(true);
    expect(
      setReviewNote(reviewPorts, {
        ...actor,
        handoffId: "h-1",
        text: "Please fix",
        targetRevision: 1,
        expectedRowVersion: 1,
      }).ok,
    ).toBe(true);
  });

  it.each([
    {
      label: "directory binding via cwd",
      bindings: [
        makeBinding("b-alpha", ALPHA_ID, "/workspaces/ws-dir", "directory"),
        makeBinding("b-beta", BETA_ID, "/workspaces/beta"),
      ],
      wsPath: "/workspaces/ws-dir",
      actor: { path: "/workspaces/ws-dir", userHome: "/home/tester", as: undefined, asUser: false } as ReadActorInput,
    },
    {
      label: "git_repository binding via workspace root (workspaceRootOf)",
      bindings: [
        makeBinding("b-alpha", ALPHA_ID, "/workspaces/repo/.git", "git_repository"),
        makeBinding("b-beta", BETA_ID, "/workspaces/beta"),
      ],
      wsPath: "/workspaces/repo",
      actor: { path: "/workspaces/repo", userHome: "/home/tester", as: undefined, asUser: false } as ReadActorInput,
    },
    {
      label: "multi-bound Project via --as slug (secondary binding matched via listBindingsForProject)",
      bindings: [
        makeBinding("b-alpha-1", ALPHA_ID, "/workspaces/a-first", "directory"),
        makeBinding("b-alpha-2", ALPHA_ID, "/workspaces/z-second", "directory"),
        makeBinding("b-beta", BETA_ID, "/workspaces/beta"),
      ],
      wsPath: "/workspaces/z-second",
      actor: { path: "/elsewhere", userHome: "/home/tester", as: "alpha", asUser: false } as ReadActorInput,
    },
  ])(
    "preserves PRJ-020 inherited-workspace sender authority across all 5 modules ($label)",
    ({ bindings, wsPath, actor }) => {
      const spies = { firstFetchCalls: 0 };
      const projects = [makeProject(ALPHA_ID, "alpha"), makeProject(BETA_ID, "beta")];
      const inheritedHandoff = makeHandoffView({
        senderKind: "unregistered_workspace",
        senderProjectId: null,
        senderProjectSlug: null,
        senderWorkspaceKey: workspaceKey(INSTALLATION, wsPath),
        senderPathSnapshot: wsPath,
        recipientProjectId: BETA_ID,
        recipientProjectSlug: "beta",
      });
      const { readPorts, revisionPorts, terminalPorts, retentionPorts, reviewPorts } = makeAllPorts(
        inheritedHandoff,
        projects,
        bindings,
        spies,
      );

      expect(resolveHandoffParticipantRole(readPorts, actor, inheritedHandoff)).toEqual(ok("sender"));
      expect(reportingRole(readPorts, actor, inheritedHandoff)).toEqual(ok("sender"));

      // 1. Read & fetch: sender can read and fetch silently (0 firstFetchCalls).
      expect(getHandoff(readPorts, actor, "h-1").ok).toBe(true);
      expect(fetchHandoff(readPorts, actor, "h-1").ok).toBe(true);
      expect(spies.firstFetchCalls).toBe(0);

      // 2. Revision: inherited sender can revise.
      expect(
        reviseHandoff(revisionPorts, { ...actor, handoffId: "h-1", body: "revised", expectedRowVersion: 1 }).ok,
      ).toBe(true);

      // 3. Terminal: inherited sender can withdraw, refused accept as FORBIDDEN_ACTOR.
      expect(withdrawHandoff(terminalPorts, { ...actor, handoffId: "h-1", expectedRowVersion: 1 }).ok).toBe(true);
      const accepted = acceptHandoff(terminalPorts, {
        ...actor,
        handoffId: "h-1",
        expectedRevision: 1,
        expectedRowVersion: 1,
      });
      expect(accepted.ok).toBe(false);
      if (!accepted.ok) expect(accepted.error.code).toBe("FORBIDDEN_ACTOR");

      // 4. Retention: inherited sender can request deletion.
      expect(requestDeletion(retentionPorts, { ...actor, handoffId: "h-1", expectedRowVersion: 1 }).ok).toBe(true);

      // 5. Reporting & Review: inherited sender is refused with FORBIDDEN_ACTOR (not HANDOFF_NOT_FOUND).
      const commented = setRecipientComment(reviewPorts, {
        ...actor,
        handoffId: "h-1",
        text: "Not allowed",
        expectedRevision: 1,
        expectedRowVersion: 1,
      });
      expect(commented.ok).toBe(false);
      if (!commented.ok) expect(commented.error.code).toBe("FORBIDDEN_ACTOR");
    },
  );

  it("propagates listBindingsForProject failure and preserves recipient over inherited-workspace sender", () => {
    const projects = [makeProject(ALPHA_ID, "alpha")];
    const bindings = [makeBinding("b-alpha", ALPHA_ID, "/workspaces/ws-other")];
    const wsHandoff = makeHandoffView({
      senderKind: "unregistered_workspace",
      senderProjectId: null,
      senderProjectSlug: null,
      senderWorkspaceKey: workspaceKey(INSTALLATION, "/workspaces/ws-origin"),
      senderPathSnapshot: "/workspaces/ws-origin",
      recipientProjectId: BETA_ID,
      recipientProjectSlug: "beta",
    });
    const spies = { failListBindingsForProject: true };
    const { readPorts } = makeAllPorts(wsHandoff, projects, bindings, spies);
    const failed = resolveHandoffParticipantRole(
      readPorts,
      { path: "/workspaces/ws-other", userHome: "/home/tester", as: undefined, asUser: false },
      wsHandoff,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("INTERNAL_ERROR");

    // If a pre-M11 workspace later bound to the recipient Project itself, recipient wins over inherited sender.
    const selfInherited = makeHandoffView({
      senderKind: "unregistered_workspace",
      senderProjectId: null,
      senderProjectSlug: null,
      senderWorkspaceKey: workspaceKey(INSTALLATION, "/workspaces/ws-other"),
      senderPathSnapshot: "/workspaces/ws-other",
      recipientProjectId: ALPHA_ID,
      recipientProjectSlug: "alpha",
    });
    const { readPorts: readPorts2 } = makeAllPorts(selfInherited, projects, bindings);
    expect(
      resolveHandoffParticipantRole(
        readPorts2,
        { path: "/workspaces/ws-other", userHome: "/home/tester", as: undefined, asUser: false },
        selfInherited,
      ),
    ).toEqual(ok("recipient"));
  });
});
