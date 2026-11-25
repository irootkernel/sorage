import type { MemoPending, MemoRecovery, MemoRisk } from "../types";

interface MemoClientState {
  recovery: MemoRecovery;
  storageRaw: string | null;
  storageError: string;
  message: string;
  flight: Pick<MemoPending, "key" | "installationId"> | null;
  preparing: boolean;
  refreshing: boolean;
  installation: string | null;
  drafts: Record<string, { title: string; body: string }>;
  renderTicket: number;
  visible: { kind: "detail"; id: string } | { kind: "list"; projectId: string } | null;
  bodyCap: number | null;
  bodyCapCurrent: boolean;
  risk: MemoRisk;
  configTicket: number;
  persistFailure: { kind: "unsent" | "transition"; material: MemoPending | null } | null;
  editorTimer: ReturnType<typeof setTimeout> | null;
}

export const memoState: MemoClientState = {
  recovery: { version: 1, active: null, notices: [] },
  storageRaw: null,
  storageError: "",
  message: "",
  flight: null,
  preparing: false,
  refreshing: false,
  installation: null,
  drafts: Object.create(null),
  renderTicket: 0,
  visible: null,
  bodyCap: null,
  bodyCapCurrent: false,
  risk: { current: false, enabled: false, warnBytes: 0 },
  configTicket: 0,
  persistFailure: null,
  editorTimer: null,
};

let memoDetailRenderer: ((id: string) => void) | undefined;

export function setMemoDetailRenderer(render: (id: string) => void) {
  memoDetailRenderer = render;
}

export function renderCurrentMemoDetail(id: string) {
  memoDetailRenderer?.(id);
}
