import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type AppError, appError, err, ok, type Result } from "../../src/errors";
import { type SendOutcome, sendRequestHash } from "../../src/handoff-commands";
import type { Project, ProjectBinding } from "../../src/projects";
import {
  recoverSend,
  type SendRecoveryHandoff,
  type SendRecoveryInput,
  type SendRecoveryPorts,
  type SendRecoveryReadPort,
  type SendRecoveryReceipt,
} from "../../src/send-recovery";
import { workspaceKey } from "../../src/workspace-identity";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-17T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(fanout = false) {
  const input: SendRecoveryInput = {
    to: fanout ? ["recipient", "other"] : ["recipient"],
    title: "Original",
    body: "Original bytes",
    idempotencyKey: "retained-legacy-key",
    allowExternalSource: false,
    allowUnregistered: false,
    path: "/sender",
    userHome: "/home",
  };
  const projects: Project[] = ["sender", "recipient", "other"].map((slug, i) => ({
    id: id(i + 1),
    slug,
    displayName: slug,
    description: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }));
  const bindings: ProjectBinding[] = projects.map((p, i) => ({
    id: id(i + 4),
    projectId: p.id,
    installationId: id(9),
    directory: `/${p.slug}`,
    bindingKind: "directory",
    createdAt: now,
    updatedAt: now,
  }));
  const outcome: SendOutcome = {
    handoffs: input.to.map((slug, i) => ({
      handoffId: id(10 + i),
      recipientSlug: slug,
      artifactId: id(20 + i),
      storageKey: `artifacts/${id(10 + i)}/${id(20 + i)}/original-1.md`,
      revision: 1,
      rowVersion: 1,
      reviewState: "awaiting_recipient",
    })),
    dispatchGroupId: fanout ? id(30) : null,
    replayed: false,
  };
  const rows: SendRecoveryHandoff[] = outcome.handoffs.map((entry, i) => ({
    id: entry.handoffId,
    dispatchGroupId: outcome.dispatchGroupId,
    supersedesHandoffId: null,
    title: input.title,
    senderKind: "registered_project",
    senderProjectId: id(1),
    senderWorkspaceKey: null,
    senderPathSnapshot: null,
    recipientProjectId: id(i + 2),
  }));
  const hash = (sender: string | undefined = `registered_project:${id(1)}`) =>
    sendRequestHash({
      to: input.to,
      title: input.title.trim(),
      contentSha256: sha(input.body ?? "Original bytes"),
      kind: input.file === undefined ? "body" : "file",
      supersedes: input.supersedes,
      sender,
    });
  let receipt: SendRecoveryReceipt | null = {
    requestHash: hash(),
    responseJson: JSON.stringify(outcome),
    expiresAt: "2026-10-18T00:00:00.000Z",
  };
  let inside = false;
  const read: SendRecoveryReadPort = {
    projectPorts: {
      installationId: id(9),
      projects: {
        findProjectBySlug: (slug) => ok(projects.find((p) => p.slug === slug.toLowerCase()) ?? null),
        listProjects: () => ok(projects),
        listBindings: () => ok(bindings),
        listBindingsForProject: (projectId) => ok(bindings.filter((b) => b.projectId === projectId)),
      },
      bindings: { realPath: (path) => ok(path), physicalIdentity: () => null, gitCommonDirectory: () => null },
    },
    findSendReceipt: vi.fn((key) => {
      expect(inside).toBe(true);
      expect(key).toBe(input.idempotencyKey);
      return ok(receipt);
    }),
    findHandoff: vi.fn((key) => ok(rows.find((row) => row.id === key) ?? null)),
  };
  const ports: SendRecoveryPorts = {
    clock: {
      now: vi.fn(() => {
        expect(inside).toBe(true);
        return new Date(now);
      }),
    },
    inspect<T>(callback: (reader: SendRecoveryReadPort) => Result<T, AppError>) {
      expect(inside).toBe(false);
      inside = true;
      try {
        return callback(read);
      } finally {
        inside = false;
      }
    },
    inspectSource: vi.fn(() => ok({ resolvedSourcePath: "/sender/original.md", originalName: "original.md" })),
    digestSource: vi.fn(() => ok(sha("Original bytes"))),
  };
  const state = () => JSON.stringify({ receipt, projects, bindings, rows });
  const recover = () => {
    const before = state();
    const result = recoverSend(ports, input);
    expect(state()).toBe(before);
    return result;
  };
  return {
    input,
    projects,
    bindings,
    rows,
    outcome,
    hash,
    ports,
    read,
    recover,
    receipt: () => receipt as SendRecoveryReceipt,
    setReceipt: (value: SendRecoveryReceipt | null) => {
      receipt = value;
    },
    store: () => {
      if (receipt) receipt.responseJson = JSON.stringify(outcome);
    },
  };
}
function code(result: Result<unknown, AppError>): string {
  return result.ok ? "OK" : result.error.code;
}

// This fake exposes no artifact, activation, write, cleanup, event, marker, log or migration capabilities.
describe("non-executing send recovery", () => {
  it("returns the historical outcome without current Artifact or Handoff state and samples Clock in the snapshot", () => {
    const f = fixture(true);
    expect(f.recover()).toEqual(ok({ ...f.outcome, replayed: true }));
    expect(f.read.findHandoff).toHaveBeenCalledTimes(2);
    expect(f.ports.clock.now).toHaveBeenCalledTimes(1);
    expect(f.ports.digestSource).not.toHaveBeenCalled();
    expect(f.ports.inspectSource).not.toHaveBeenCalled();
  });
  it("normalizes title and recipient order/duplicates with the existing business hash", () => {
    const f = fixture(true);
    f.input.title = " Original ";
    f.input.to = ["other", "recipient", "other"];
    expect(code(f.recover())).toBe("OK");
  });
  it("preserves original recipient spelling in historical receipts", () => {
    const f = fixture();
    f.input.to = ["Recipient"];
    f.outcome.handoffs[0] = {
      ...(f.outcome.handoffs[0] as SendOutcome["handoffs"][number]),
      recipientSlug: "Recipient",
    };
    f.store();
    f.receipt().requestHash = f.hash();
    expect(f.recover()).toEqual(ok({ ...f.outcome, replayed: true }));
  });
  it("replays after recipient archival/unbinding and sender archival without rechecking recipient eligibility", () => {
    const f = fixture();
    for (const p of f.projects) p.status = "archived";
    f.bindings.splice(1);
    expect(code(f.recover())).toBe("OK");
  });
  it.each(["title", "body", "to", "supersedes"] as const)(
    "conflicts on changed %s even for an archived sender",
    (field) => {
      const f = fixture();
      (f.projects[0] as Project).status = "archived";
      if (field === "to") f.input.to = ["other"];
      else f.input[field] = field === "supersedes" ? id(60) : "Changed";
      expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
    },
  );
  it.each(["absent", "expired", "equality"])("leaves %s receipt outcome unknown without cleanup", (kind) => {
    const f = fixture();
    if (kind === "absent") f.setReceipt(null);
    else f.receipt().expiresAt = kind === "equality" ? now : "2026-10-16T23:59:59.999Z";
    expect(code(f.recover())).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    expect(f.read.findHandoff).not.toHaveBeenCalled();
  });
  it("retains a receipt eligible one millisecond after the lookup Clock", () => {
    const f = fixture();
    f.receipt().expiresAt = "2026-10-17T00:00:00.001Z";
    expect(code(f.recover())).toBe("OK");
  });
  it("does not cache a miss or prevent a later original from committing", () => {
    const f = fixture();
    const original = f.receipt();
    f.setReceipt(null);
    expect(code(f.recover())).toBe("HANDOFF_REPLAY_UNAVAILABLE");
    f.setReceipt(original);
    expect(code(f.recover())).toBe("OK");
  });
  it.each([true, false])("validates ownership even with a %s sender-aware hash", (aware) => {
    const f = fixture();
    if (!aware)
      f.receipt().requestHash = sendRequestHash({
        to: f.input.to,
        title: f.input.title,
        contentSha256: sha(f.input.body as string),
        kind: "body",
      });
    f.input.as = "other";
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("preserves legacy senderless receipts for the verified original sender", () => {
    const f = fixture();
    f.receipt().requestHash = sendRequestHash({
      to: f.input.to,
      title: f.input.title,
      contentSha256: sha(f.input.body as string),
      kind: "body",
    });
    expect(code(f.recover())).toBe("OK");
  });
  it.each([false, true])("preserves Workspace-to-Project inheritance with legacy=%s", (legacy) => {
    const f = fixture();
    const row = f.rows[0] as SendRecoveryHandoff;
    row.senderKind = "unregistered_workspace";
    row.senderProjectId = null;
    row.senderPathSnapshot = "/sender";
    row.senderWorkspaceKey = workspaceKey(id(9), "/sender");
    f.receipt().requestHash = legacy
      ? sendRequestHash({
          to: f.input.to,
          title: f.input.title,
          contentSha256: sha(f.input.body as string),
          kind: "body",
        })
      : f.hash(`unregistered_workspace:${row.senderWorkspaceKey}`);
    expect(code(f.recover())).toBe("OK");
    f.input.as = "sender";
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("preserves exact historical Workspace replay under the descendant downgrade guard", () => {
    const f = fixture();
    const row = f.rows[0] as SendRecoveryHandoff;
    f.input.path = "/ancestor";
    (f.bindings[0] as ProjectBinding).directory = "/ancestor/child";
    row.senderKind = "unregistered_workspace";
    row.senderProjectId = null;
    row.senderPathSnapshot = "/ancestor";
    row.senderWorkspaceKey = workspaceKey(id(9), "/ancestor");
    f.receipt().requestHash = f.hash(`unregistered_workspace:${row.senderWorkspaceKey}`);
    expect(code(f.recover())).toBe("OK");
    f.input.path = "/elsewhere";
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("resolves unchanged unregistered and User senders", () => {
    const f = fixture();
    f.bindings.splice(0);
    const row = f.rows[0] as SendRecoveryHandoff;
    row.senderKind = "unregistered_workspace";
    row.senderProjectId = null;
    row.senderPathSnapshot = "/sender";
    row.senderWorkspaceKey = workspaceKey(id(9), "/sender");
    f.receipt().requestHash = f.hash(`unregistered_workspace:${row.senderWorkspaceKey}`);
    expect(code(f.recover())).toBe("OK");
    row.senderKind = "user";
    row.senderPathSnapshot = null;
    row.senderWorkspaceKey = null;
    f.receipt().requestHash = f.hash("user:user");
    f.input.asUser = true;
    expect(code(f.recover())).toBe("OK");
  });
  it("requires the original Installation for a historical Workspace sender", () => {
    const f = fixture();
    const row = f.rows[0] as SendRecoveryHandoff;
    row.senderKind = "unregistered_workspace";
    row.senderProjectId = null;
    row.senderPathSnapshot = "/sender";
    row.senderWorkspaceKey = workspaceKey(id(9), "/sender");
    f.receipt().requestHash = f.hash(`unregistered_workspace:${row.senderWorkspaceKey}`);
    f.read.projectPorts.installationId = id(99);
    expect(code(f.recover())).toBe("STORAGE_INTEGRITY_ERROR");
  });
  it.each(["sender", "recipient", "dispatch", "missing", "title", "supersedes"])(
    "checks every fan-out member's immutable %s",
    (field) => {
      const f = fixture(true);
      const row = f.rows[1] as SendRecoveryHandoff;
      if (field === "sender") row.senderProjectId = id(3);
      if (field === "recipient") row.recipientProjectId = id(2);
      if (field === "dispatch") row.dispatchGroupId = id(99);
      if (field === "missing") f.rows.pop();
      if (field === "title") row.title = "Forged";
      if (field === "supersedes") row.supersedesHandoffId = id(99);
      expect(code(f.recover())).toBe("STORAGE_INTEGRITY_ERROR");
    },
  );
  it("refuses a forged original sender even when the stored hash matches the caller", () => {
    const f = fixture();
    (f.rows[0] as SendRecoveryHandoff).senderProjectId = id(3);
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
  });
  it.each(["hash", "expiry", "json"])("reports malformed receipt %s as integrity failure", (field) => {
    const f = fixture();
    if (field === "hash") f.receipt().requestHash = "bad";
    if (field === "expiry") f.receipt().expiresAt = "bad";
    if (field === "json") f.receipt().responseJson = "{";
    expect(code(f.recover())).toBe("STORAGE_INTEGRITY_ERROR");
  });
  it("digests the realpath-resolved file without an import/spool", () => {
    const f = fixture();
    delete f.input.body;
    f.input.file = "/sender/link.md";
    f.receipt().requestHash = f.hash();
    expect(code(f.recover())).toBe("OK");
    expect(f.ports.digestSource).toHaveBeenCalledWith("/sender/original.md");
  });
  it("checks changed file bytes using the original hash", () => {
    const f = fixture();
    delete f.input.body;
    f.input.file = "/sender/file.md";
    f.receipt().requestHash = f.hash();
    f.ports.digestSource = () => ok(sha("changed"));
    expect(code(f.recover())).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("preserves external-source guards with no implicit override", () => {
    const f = fixture();
    delete f.input.body;
    f.input.file = "/outside/file.md";
    f.receipt().requestHash = f.hash();
    f.ports.inspectSource = () => ok({ resolvedSourcePath: f.input.file as string, originalName: "file.md" });
    expect(code(f.recover())).toBe("SOURCE_OUTSIDE_WORKSPACE");
    f.input.allowExternalSource = true;
    expect(code(f.recover())).toBe("OK");
  });
  it.each(["inspectSource", "digestSource"] as const)(
    "preserves INTERNAL_ERROR/1 from %s without opening storage",
    (field) => {
      const f = fixture();
      delete f.input.body;
      f.input.file = "/missing";
      const error = appError("INTERNAL_ERROR", "source cannot be read");
      f.ports[field] = () => err(error);
      expect(f.recover()).toEqual(err(error));
      expect(f.read.findSendReceipt).not.toHaveBeenCalled();
    },
  );
  it.each([
    "STORAGE_SCHEMA_UNSUPPORTED",
    "STORAGE_INTEGRITY_ERROR",
    "STORAGE_INSPECTION_UNAVAILABLE",
    "SERVICE_PAUSED",
    "VAULT_INTEGRITY_ERROR",
    "VAULT_SCHEMA_UNSUPPORTED",
    "NOT_INITIALIZED",
    "CONFIG_INVALID",
  ] as const)("preserves typed inspection refusal %s", (kind) => {
    const f = fixture();
    const error = appError(kind, "inspection refused");
    f.ports.inspect = () => err(error);
    expect(f.recover()).toEqual(err(error));
    expect(f.read.findSendReceipt).not.toHaveBeenCalled();
  });
  it("propagates receipt and immutable-row read failures instead of treating them as misses", () => {
    const f = fixture();
    const error = appError("STORAGE_INSPECTION_UNAVAILABLE", "read failed");
    f.read.findHandoff = () => err(error);
    expect(f.recover()).toEqual(err(error));
    f.read.findSendReceipt = () => err(error);
    expect(f.recover()).toEqual(err(error));
  });
  it("preserves Project override and binding guards", () => {
    const f = fixture();
    f.input.as = "unknown";
    expect(code(f.recover())).toBe("PROJECT_NOT_FOUND");
    f.input.as = "sender";
    f.bindings.splice(0, 1);
    expect(code(f.recover())).toBe("PROJECT_UNBOUND");
  });
  it.each(["key", "empty-key", "title", "recipients", "no-source", "two-sources", "empty-body"])(
    "rejects invalid original input: %s",
    (kind) => {
      const f = fixture();
      if (kind === "key") f.input.idempotencyKey = "";
      if (kind === "empty-key") f.input.idempotencyKey = " ";
      if (kind === "title") f.input.title = " ";
      if (kind === "recipients") f.input.to = [];
      if (kind === "no-source") delete f.input.body;
      if (kind === "two-sources") f.input.file = "/file";
      if (kind === "empty-body") f.input.body = " ";
      expect(code(f.recover())).toBe("CONFIG_INVALID");
      expect(f.read.findSendReceipt).not.toHaveBeenCalled();
    },
  );
});
