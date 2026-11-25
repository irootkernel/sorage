export type DomAttributes = Record<string, string>;

export type ApiEnvelope<T> =
  | { ok: true; data: T; meta?: { requestId: string } }
  | { ok: false; error: { code: string; message: string }; meta?: { requestId: string } };

export interface ApiResult<T> {
  status: number;
  body: ApiEnvelope<T>;
}

export interface Artifact {
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string | null;
  storageKey: string | null;
}

export interface HandoffComment {
  active: boolean;
  authorKind: string;
  authorProjectId: string | null;
  body: string;
  purpose: string;
  targetRevision: number;
}

export interface Handoff {
  id: string;
  title: string;
  senderDisplayName: string | null;
  senderKind: string;
  senderPathSnapshot: string | null;
  senderWorkspaceKey: string | null;
  recipientProjectSlug: string | null;
  recipientProjectId: string;
  reviewState: string;
  revision: number;
  rowVersion: number;
  nextActors: { reviewNextActor: string | null; administrativeNextActor: string | null } | null;
  read: { revision: number; status: string; readAt: string | null };
  processing: {
    revision: number;
    status: "not_started" | "in_progress" | "completed" | "unrecorded";
    startedAt: string | null;
    completedAt: string | null;
  };
  comment: HandoffComment | null;
  firstFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  currentArtifact: Artifact | null;
  hasReviewNote: boolean;
  pendingDeletionRequest: boolean;
  pinned: boolean;
}

export interface HandoffEvent {
  createdAt: string;
  eventType: string;
  actorKind: string | null;
}

export interface HandoffPage {
  handoffs: Handoff[];
  nextCursor: string | null;
}

export interface ProjectEntry {
  project: { id: string; slug: string; displayName: string; status: string };
  bindingCount: number;
  unbound: boolean;
}

export interface DispatchResult {
  handoffs: { handoffId: string; recipientSlug: string }[];
  dispatchGroupId: string | null;
}

export interface Diagnostic {
  id: string;
  message: string;
  severity: string;
}

export interface ConfigSnapshot {
  configFile: string;
  yaml: string;
  etag: string;
  config: {
    ui: { defaultPageSize: number };
    handoff: { inboxMarker: boolean };
  };
}

export interface BackupRun {
  id: string | null;
  startedAt: string;
  triggeredBy: string;
  outcome: string;
  snapshotOutcome: string;
  commitSha: string | null;
  commitOutcome: string;
  pushOutcome: string;
  failureCode: string | null;
}

export interface BackupStatus {
  nextDueAt: string | null;
  schedule: { enabled: boolean; at: string; timezone: string };
  lastAttempt: BackupRun | null;
  lastSuccess: BackupRun | null;
  lastCommit: BackupRun | null;
  lastPush: BackupRun | null;
  lastFailure: BackupRun | null;
}

export type MemoOperation = "add" | "update" | "done" | "dismiss" | "reopen";
export type MemoState = "open" | "done" | "dismissed";

export interface Memo {
  id: string;
  projectId: string;
  title: string;
  body: string;
  state: MemoState;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedBy: { kind: "user"; id: null } | null;
}

export interface MemoPage {
  nextCursor: string | null;
  items: Array<
    Pick<Memo, "id" | "projectId" | "title" | "state" | "updatedAt"> & {
      projectDisplayName: string;
      projectSlug: string;
      projectStatus: string;
      bodyPreview: string;
      bodyPreviewTruncated: boolean;
    }
  >;
}

export interface MemoInput {
  projectId?: string;
  title?: string;
  body?: string;
  expectedRowVersion?: number;
}

export interface MemoMetadata {
  origin: string;
  installationId: string;
  key: string;
  projectId: string;
  memoId: string | null;
  operation: MemoOperation;
  title: string;
  firstAttemptAt: string;
}

export interface MemoPending extends MemoMetadata {
  input: MemoInput;
}

export interface MemoNotice extends MemoMetadata {
  expectedRowVersion: number | null;
  abandonedAt: string;
  outcome: "unknown";
  retryDisposition: "abandoned";
}

export interface MemoRecovery {
  version: 1;
  active: MemoPending | null;
  notices: MemoNotice[];
}

export interface MemoRisk {
  current: boolean;
  enabled: boolean;
  warnBytes: number;
}

export interface MemoSample {
  cap: number | null;
  risk: MemoRisk | null;
}

export interface MemoReceipt {
  memo: Memo;
  changed: boolean;
  replayed: boolean;
}

export type HandoffPageResult = ApiResult<HandoffPage> | { stale: true };
