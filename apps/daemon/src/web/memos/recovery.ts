import { api } from "../api";
import { el } from "../dom";
import type {
  ApiResult,
  Memo,
  MemoInput,
  MemoNotice,
  MemoOperation,
  MemoPending,
  MemoReceipt,
  MemoRecovery,
  MemoSample,
} from "../types";
import { memoState, renderCurrentMemoDetail } from "./state";
import {
  memoActor,
  memoBodyText,
  memoBytes,
  memoInputValid,
  memoKeys,
  memoMetadata,
  memoObject,
  memoTime,
  memoTitle,
  memoUuid,
  memoVersion,
} from "./validation";

const MEMO_STORAGE_KEY = "sorage-memo-recovery-v1";

export function memoStoredState(value: unknown): value is MemoRecovery {
  if (
    !memoKeys(value, ["version", "active", "notices"]) ||
    value.version !== 1 ||
    !Array.isArray(value.notices) ||
    value.notices.length > 32
  )
    return false;
  if (
    value.active !== null &&
    (!memoMetadata(value.active) ||
      !memoKeys(value.active, [
        "origin",
        "installationId",
        "key",
        "projectId",
        "memoId",
        "operation",
        "title",
        "firstAttemptAt",
        "input",
      ]))
  )
    return false;
  const seen = new Set<string>();
  if (memoMetadata(value.active)) seen.add(`${value.active.installationId}:${value.active.key}`);
  return value.notices.every((notice: unknown) => {
    if (!memoMetadata(notice)) return false;
    const key = `${notice.installationId}:${notice.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      memoMetadata(notice) &&
      memoKeys(notice, [
        "origin",
        "installationId",
        "key",
        "projectId",
        "memoId",
        "operation",
        "title",
        "firstAttemptAt",
        "expectedRowVersion",
        "abandonedAt",
        "outcome",
        "retryDisposition",
      ]) &&
      (notice.expectedRowVersion === null || memoVersion(notice.expectedRowVersion)) &&
      memoTime(notice.abandonedAt) &&
      notice.outcome === "unknown" &&
      notice.retryDisposition === "abandoned"
    );
  });
}

function memoLoadRecovery() {
  try {
    const raw = sessionStorage.getItem(MEMO_STORAGE_KEY);
    const parsed = raw === null ? { version: 1, active: null, notices: [] } : JSON.parse(raw);
    if (!memoStoredState(parsed)) throw new Error("Invalid recovery record");
    memoState.recovery = parsed;
    memoState.storageRaw = raw;
  } catch (_error) {
    memoState.storageError =
      "Local Memo recovery storage is unreadable or malformed. Writes are blocked; preserve this tab's data and investigate storage before reloading.";
  }
}

function memoPersist(next: MemoRecovery) {
  try {
    if (memoState.storageError || sessionStorage.getItem(MEMO_STORAGE_KEY) !== memoState.storageRaw)
      throw new Error("Recovery storage changed");
    const raw = JSON.stringify(next);
    if (!memoStoredState(next)) throw new Error("Recovery record exceeds its bounds");
    sessionStorage.setItem(MEMO_STORAGE_KEY, raw);
    if (sessionStorage.getItem(MEMO_STORAGE_KEY) !== raw) throw new Error("Recovery storage did not retain the write");
    memoState.recovery = next;
    memoState.storageRaw = raw;
    return true;
  } catch (_error) {
    memoState.storageError =
      "Local Memo recovery storage could not be saved or verified. No new request will be sent and writes remain blocked. Preserve this tab's data before repairing storage.";
    // Only the initial persistence of a brand-new pending precedes any
    // dispatch. Every later failure keeps the original material and gate
    // with neutral guidance: the record's shape cannot prove whether the
    // server returned a receipt, refused, or was never contacted.
    memoState.persistFailure =
      next.active !== null && memoState.recovery.active === null
        ? { kind: "unsent", material: next.active }
        : { kind: "transition", material: memoState.recovery.active };
    memoRenderRecovery();
    return false;
  }
}

export function memoLocked() {
  return Boolean(
    memoState.storageError ||
      memoState.recovery.active ||
      memoState.preparing ||
      memoState.refreshing ||
      memoState.flight,
  );
}

function memoMatches(pending: MemoPending) {
  const current = memoState.recovery.active;
  return (
    current !== null &&
    current.key === pending.key &&
    current.installationId === pending.installationId &&
    current.origin === pending.origin
  );
}

export function memoRequest<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, 15000);
  });
  return Promise.race([api<T>(path, Object.assign({}, init || {}, { signal: controller.signal })), timeout]).finally(
    () => {
      clearTimeout(timer);
    },
  );
}

function memoIdentify() {
  return memoRequest<{ installationId: unknown }>("/api/v1/health").then((result) => {
    if (result.status !== 200 || !result.body || result.body.ok !== true || !memoUuid(result.body.data.installationId))
      throw new Error("Cannot verify this Installation");
    memoState.installation = result.body.data.installationId;
    return memoState.installation;
  });
}

export function memoLearnCap(): Promise<MemoSample> {
  const ticket = ++memoState.configTicket;
  return memoRequest("/api/v1/config")
    .then((result) => {
      if (
        result.status !== 200 ||
        !result.body ||
        result.body.ok !== true ||
        !memoObject(result.body.data) ||
        !memoObject(result.body.data.config)
      )
        throw new Error("unavailable");
      const artifact = result.body.data.config.artifact;
      const value = memoObject(artifact) ? artifact.maxBytes : undefined;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("invalid");
      // The retention-risk sample comes from this same response; invalid
      // backup fields leave the risk unknown without touching the cap.
      const gitBackup = result.body.data.config.gitBackup;
      const enabled = memoObject(gitBackup) ? gitBackup.enabled : undefined;
      const warnBytes = memoObject(gitBackup) ? gitBackup.largeArtifactWarningBytes : undefined;
      const risk =
        enabled !== true && enabled !== false
          ? null
          : typeof warnBytes === "number" && Number.isSafeInteger(warnBytes) && warnBytes > 0
            ? { current: true, enabled: enabled, warnBytes: warnBytes }
            : null;
      // Only the most recently initiated refresh moves the shared display
      // state; a late older refresh never re-marks a newer failure current.
      if (ticket === memoState.configTicket) {
        memoState.bodyCap = value;
        memoState.bodyCapCurrent = true;
        memoState.risk = risk === null ? { current: false, enabled: false, warnBytes: 0 } : risk;
      }
      return { cap: value, risk: risk };
    })
    .catch(() => {
      if (ticket === memoState.configTicket) {
        memoState.bodyCapCurrent = false;
        memoState.risk = { current: false, enabled: false, warnBytes: 0 };
      }
      return { cap: null, risk: null };
    });
}

function memoEncodeInput(input: MemoInput) {
  const json = JSON.stringify(input);
  if (memoBytes(json) <= 524288) return { headers: { "content-type": "application/json" }, body: json };
  const meta: Record<string, unknown> = {};
  Object.entries(input).forEach(([name, value]) => {
    if (name !== "body") meta[name] = value;
  });
  const metaJson = JSON.stringify(meta);
  const body = input.body ?? "";
  let boundary: string;
  do {
    boundary = `----sorage-memo-${crypto.randomUUID()}`;
  } while (metaJson.indexOf(boundary) !== -1 || body.indexOf(boundary) !== -1);
  // Explicit Blob segments with hand-written framing: no FormData filename
  // injection and no string CRLF normalization \u2014 the body bytes stay exact.
  const opening =
    "--" +
    boundary +
    '\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n' +
    metaJson +
    "\r\n--" +
    boundary +
    '\r\nContent-Disposition: form-data; name="body"\r\nContent-Type: text/plain\r\n\r\n';
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: new Blob([opening, new TextEncoder().encode(body), `\r\n--${boundary}--\r\n`]),
  };
}

export function memoReceipt(
  result: ApiResult<unknown>,
  pending: MemoPending,
  recovery: boolean,
): result is ApiResult<MemoReceipt> & { body: { ok: true; data: MemoReceipt } } {
  const envelope = result.body;
  if (
    result.status !== 200 ||
    !memoKeys(envelope, ["ok", "data", "meta"]) ||
    envelope.ok !== true ||
    !memoObject(envelope.meta) ||
    !memoUuid(envelope.meta.requestId)
  )
    return false;
  const data = envelope.data;
  if (
    !memoKeys(data, ["memo", "changed", "replayed"]) ||
    typeof data.changed !== "boolean" ||
    typeof data.replayed !== "boolean" ||
    (recovery && data.replayed !== true)
  )
    return false;
  const memo = data.memo;
  if (
    !memoKeys(memo, [
      "id",
      "projectId",
      "title",
      "body",
      "state",
      "rowVersion",
      "createdAt",
      "updatedAt",
      "createdBy",
      "updatedBy",
      "closedAt",
      "closedBy",
    ]) ||
    !memoUuid(memo.id) ||
    memo.projectId !== pending.projectId ||
    !memoTitle(memo.title) ||
    memo.title !== memo.title.trim() ||
    !memoBodyText(memo.body, null) ||
    !memoVersion(memo.rowVersion) ||
    !memoTime(memo.createdAt) ||
    !memoTime(memo.updatedAt) ||
    !memoActor(memo.createdBy) ||
    !memoActor(memo.updatedBy)
  )
    return false;
  if (memo.state === "open") {
    if (memo.closedAt !== null || memo.closedBy !== null) return false;
  } else if (
    (memo.state !== "done" && memo.state !== "dismissed") ||
    memo.closedAt !== memo.updatedAt ||
    !memoActor(memo.closedBy) ||
    memo.rowVersion < 2
  )
    return false;
  const input = pending.input;
  if (pending.operation === "add")
    return (
      data.changed &&
      memo.rowVersion === 1 &&
      memo.state === "open" &&
      memo.title === input.title?.trim() &&
      memo.body === input.body
    );
  if (
    memo.id !== pending.memoId ||
    memo.rowVersion !== (input.expectedRowVersion ?? Number.NaN) + (data.changed ? 1 : 0)
  )
    return false;
  if (pending.operation === "update") {
    // Correlate only the fields the original request actually carried; a
    // bodyless update settles on title/version/id without touching body.
    if (memo.state !== "open") return false;
    if (input.title !== undefined && memo.title !== input.title?.trim()) return false;
    if (input.body !== undefined && memo.body !== input.body) return false;
    return true;
  }
  return memo.state === { done: "done", dismiss: "dismissed", reopen: "open" }[pending.operation];
}

function memoFirstRefusal(result: ApiResult<unknown>) {
  const statuses: Record<string, number> = {
    MEMO_INVALID_INPUT: 422,
    MEMO_TOO_LARGE: 413,
    MEMO_NOT_FOUND: 404,
    MEMO_NOT_OPEN: 409,
    ROW_VERSION_CONFLICT: 409,
    PROJECT_ARCHIVED: 409,
    PROJECT_NOT_FOUND: 404,
    IDEMPOTENCY_CONFLICT: 409,
    SERVICE_PAUSED: 423,
    UNAUTHENTICATED: 401,
    TOKEN_INVALID: 401,
  };
  const body = result.body;
  return (
    memoKeys(body, ["ok", "error", "meta"]) &&
    body.ok === false &&
    memoObject(body.error) &&
    typeof body.error.message === "string" &&
    memoObject(body.meta) &&
    memoUuid(body.meta.requestId) &&
    typeof body.error.code === "string" &&
    statuses[body.error.code] === result.status
  );
}

function memoRefreshCurrent(pending: MemoPending, id: string, success: boolean, settledMemo?: Memo) {
  memoState.refreshing = true;
  memoRenderRecovery();
  return memoRequest(`/api/v1/memos/${encodeURIComponent(id)}`)
    .then((result) => {
      if (result.status !== 200 || !result.body.ok) throw new Error("Current Memo could not be reloaded");
      memoState.refreshing = false;
      if (success && (pending.operation === "add" || pending.operation === "update")) {
        const draftKey = pending.memoId || `new:${pending.projectId}`;
        const draft = memoState.drafts[draftKey];
        const titleMatches =
          draft &&
          (pending.input.title !== undefined
            ? draft.title.trim() === pending.input.title
            : draft.title === settledMemo?.title);
        const bodyMatches =
          draft &&
          (pending.input.body !== undefined ? draft.body === pending.input.body : draft.body === settledMemo?.body);
        if (draft && titleMatches && bodyMatches) delete memoState.drafts[draftKey];
        else if (draft && pending.operation === "add" && !memoState.drafts[id]) {
          memoState.drafts[id] = draft;
          delete memoState.drafts[draftKey];
        }
      }
      if (memoState.visible && memoState.visible.kind === "detail" && memoState.visible.id === id)
        renderCurrentMemoDetail(id);
      else if (
        success &&
        pending.operation === "add" &&
        memoState.visible &&
        memoState.visible.kind === "list" &&
        memoState.visible.projectId === pending.projectId
      )
        location.hash = `/memo/${encodeURIComponent(id)}`;
      memoRenderRecovery();
    })
    .catch(() => {
      memoState.message += " Current state could not be reloaded. Read the Memo again before another write.";
      memoRenderRecovery();
    });
}

export function memoDispatch(pending: MemoPending, recovery: boolean) {
  if (!memoMatches(pending) || memoState.flight || memoState.storageError) return Promise.resolve();
  const flight = { key: pending.key, installationId: pending.installationId };
  let learned: MemoSample | null = null;
  memoState.flight = flight;
  memoRenderRecovery();
  return memoIdentify()
    .then((installation) => {
      if (!memoMatches(pending) || memoState.flight !== flight) return null;
      return memoLearnCap().then((sample) => {
        learned = sample;
        if (!memoMatches(pending) || memoState.flight !== flight) return null;
        if (
          pending.origin !== location.origin ||
          installation !== pending.installationId ||
          !memoInputValid(pending.operation, pending.input, pending.projectId, pending.memoId, null)
        )
          throw new Error(
            "Original request material or Installation does not match. Investigate read-only or explicitly abandon recovery.",
          );
        const cap = sample.cap;
        if (
          cap !== null &&
          pending.input &&
          typeof pending.input.body === "string" &&
          memoBytes(pending.input.body) > cap
        ) {
          // The server owns the accepting cap; a locally known refusal is never sent.
          if (!recovery) {
            if (!memoPersist({ version: 1, active: null, notices: memoState.recovery.notices })) return null;
            memoState.message = `The current Memo body limit is ${cap} UTF-8 bytes; nothing was sent and your draft is preserved.`;
            return null;
          }
          memoState.message =
            "The current Memo body limit is " +
            cap +
            " UTF-8 bytes and refuses the original body; nothing was sent. The original outcome remains unknown: inspect it with the original key in replay-only mode from the CLI or an authenticated HTTP client, or explicitly abandon recovery.";
          return null;
        }
        const path =
          "/api/v1/memos" +
          (pending.memoId ? `/${encodeURIComponent(pending.memoId)}` : "") +
          (["done", "dismiss", "reopen"].indexOf(pending.operation) !== -1 ? `/${pending.operation}` : "");
        const encoded = memoEncodeInput(pending.input);
        return memoRequest(path, {
          method: pending.operation === "update" ? "PATCH" : "POST",
          headers: Object.assign(encoded.headers, {
            "idempotency-key": pending.key,
            "idempotency-mode": recovery ? "replay-only" : "execute",
          }),
          body: encoded.body,
        });
      });
    })
    .then((result) => {
      if (!result || !memoMatches(pending) || memoState.flight !== flight) return;
      if (memoReceipt(result, pending, recovery)) {
        if (!memoPersist({ version: 1, active: null, notices: memoState.recovery.notices })) return;
        memoState.message = result.body.data.replayed
          ? "Original request confirmed by a historical receipt; refreshing current state."
          : "Memo saved; refreshing current state.";
        try {
          // Best-effort retention warning judged only on this dispatch's own
          // successful config sample; the settlement above is already final.
          if (
            learned?.risk?.current &&
            learned.risk.enabled &&
            !recovery &&
            result.body.data.changed === true &&
            result.body.data.replayed === false &&
            pending.input &&
            typeof pending.input.body === "string" &&
            memoBytes(pending.input.body) > learned.risk.warnBytes
          ) {
            memoState.message +=
              " A new body was accepted. With Git backup enabled, Git history retains every committed revision of this body forever.";
          }
        } catch (_error) {
          // The warning can never affect the settled outcome or the gate.
        }
        return memoRefreshCurrent(pending, result.body.data.memo.id, true, result.body.data.memo);
      }
      if (!recovery && memoFirstRefusal(result)) {
        if (!memoPersist({ version: 1, active: null, notices: memoState.recovery.notices })) return;
        memoState.message =
          (result.body.ok ? "" : result.body.error.code) +
          ": request refused without mutation. Your draft is preserved. Review current state before a new action.";
        if (pending.memoId) return memoRefreshCurrent(pending, pending.memoId, false);
      } else {
        memoState.message =
          "Outcome unknown. " +
          (result.body && !result.body.ok && result.body.error ? result.body.error.code : "Unrecognized response") +
          ". Inspect the original request with replay-only, or explicitly abandon recovery. No replacement was sent.";
      }
    })
    .catch((error) => {
      if (memoMatches(pending) && memoState.flight === flight)
        memoState.message = `Outcome unknown. ${(error as Error).message} No replacement was sent.`;
    })
    .finally(() => {
      if (memoState.flight === flight) memoState.flight = null;
      memoRenderRecovery();
    });
}

function invalidInputMessage(cap: number | null) {
  return (
    "Invalid Memo input: title needs 1\u2013200 characters / at most 800 UTF-8 bytes; body must be valid Unicode text without NUL" +
    (cap === null ? "; the server enforces the current body size limit." : ` and at most ${cap} UTF-8 bytes.`)
  );
}

export function memoSubmit(
  operation: MemoOperation,
  projectId: string,
  memoId: string | null,
  title: string,
  input: MemoInput,
) {
  if (memoLocked()) {
    memoState.message = "Another Memo request or a local recovery problem blocks writes in this tab.";
    memoRenderRecovery();
    return Promise.resolve();
  }
  if (!memoInputValid(operation, input, projectId, memoId, null)) {
    memoState.message = invalidInputMessage(null);
    memoRenderRecovery();
    return Promise.resolve();
  }
  memoState.preparing = true;
  memoRenderRecovery();
  return memoIdentify()
    .then((installation) =>
      memoLearnCap().then((sample) => {
        const cap = sample.cap;
        if (cap !== null && !memoInputValid(operation, input, projectId, memoId, cap)) {
          memoState.message = invalidInputMessage(cap);
          return;
        }
        const pending = {
          origin: location.origin,
          installationId: installation,
          operation: operation,
          key: crypto.randomUUID(),
          projectId: projectId,
          memoId: memoId,
          title: title.trim(),
          firstAttemptAt: new Date().toISOString(),
          input: input,
        };
        if (
          memoState.recovery.active ||
          !memoPersist({ version: 1, active: pending, notices: memoState.recovery.notices })
        )
          return;
        memoState.preparing = false;
        return memoDispatch(pending, false);
      }),
    )
    .catch(() => {
      memoState.message = "Disconnected: cannot verify the Installation. Draft preserved; no Memo request sent.";
    })
    .finally(() => {
      memoState.preparing = false;
      memoRenderRecovery();
    });
}

export function memoAbandon() {
  const pending = memoState.recovery.active;
  if (!pending || memoState.storageError) return;
  if (memoState.recovery.notices.length >= 32) {
    memoState.message =
      "32 unknown-outcome notices are retained. Inspect/copy and explicitly remove an older notice before abandoning this request.";
    memoRenderRecovery();
    return;
  }
  if (
    !window.confirm(
      "Abandon retry and continue? The original may already have committed or may finish later. This does not cancel or delete server work. Repeating the same intent with a new request can duplicate effects. Its outcome will remain unknown.",
    )
  )
    return;
  const notice: MemoNotice = {
    origin: pending.origin,
    installationId: pending.installationId,
    key: pending.key,
    projectId: pending.projectId,
    memoId: pending.memoId,
    operation: pending.operation,
    title: pending.title,
    firstAttemptAt: pending.firstAttemptAt,
    expectedRowVersion:
      pending.input && memoVersion(pending.input.expectedRowVersion) ? pending.input.expectedRowVersion : null,
    abandonedAt: new Date().toISOString(),
    outcome: "unknown",
    retryDisposition: "abandoned",
  };
  if (
    !memoMatches(pending) ||
    !memoPersist({ version: 1, active: null, notices: memoState.recovery.notices.concat([notice]) })
  )
    return;
  // Detach only this local attempt; its server operation may still complete.
  memoState.flight = null;
  memoState.message =
    "Recovery abandoned; the original outcome is unknown. No server request was cancelled or sent. A new action can duplicate the original intent.";
  if (pending.memoId) memoRefreshCurrent(pending, pending.memoId, false);
  memoRenderRecovery();
}

export function memoRenderRecovery() {
  document.querySelectorAll<HTMLButtonElement>("[data-memo-write]").forEach((button) => {
    button.disabled = memoLocked() || button.getAttribute("data-memo-forbidden") === "true";
  });
  const region = document.getElementById("memo-recovery");
  if (!region) return;
  region.replaceChildren();
  if (memoState.storageError) region.appendChild(el("p", { role: "alert", text: memoState.storageError }));
  if (memoState.persistFailure) {
    const guidance = {
      unsent:
        "The request material below was never sent and exists only in this tab because recovery storage cannot retain it. Copy it now. With its original idempotency key it can be inspected in replay-only mode from the CLI or an authenticated HTTP client; nothing was dispatched from this tab.",
      transition:
        "A recovery-record update failed, so this tab keeps its recovery gate for the request below and writes stay blocked. The local failure says nothing about what the server did or did not do with the original request. Copy the material now; it can be inspected with its original idempotency key in replay-only mode from the CLI or an authenticated HTTP client, or recovery can be explicitly abandoned here.",
    };
    region.appendChild(el("p", { text: guidance[memoState.persistFailure.kind] }));
    if (memoState.persistFailure.material) {
      const material = el("textarea", { readonly: "", rows: "10", "aria-label": "Copy Memo recovery material" });
      material.value = JSON.stringify(memoState.persistFailure.material, null, 2);
      region.appendChild(material);
    }
  }
  if (memoState.message) region.appendChild(el("p", { role: "status", text: memoState.message }));
  const pending = memoState.recovery.active;
  if (pending) {
    region.appendChild(el("h3", { text: "Memo outcome unknown \u2014 writes paused in this tab" }));
    region.appendChild(
      el("p", {
        text:
          pending.operation +
          " \u00B7 " +
          pending.title +
          " \u00B7 Project " +
          pending.projectId +
          (pending.memoId ? ` \u00B7 Memo ${pending.memoId}` : ""),
      }),
    );
    region.appendChild(
      el("p", {
        class: "mono",
        text: `Original key: ${pending.key} \u00B7 First attempt: ${pending.firstAttemptAt}`,
      }),
    );
    const inspect = el("button", { type: "button", text: "Inspect original request (replay-only)" });
    inspect.disabled = Boolean(memoState.flight || memoState.storageError);
    inspect.addEventListener("click", () => {
      if (!memoState.flight) memoDispatch(pending, true);
    });
    const abandon = el("button", { type: "button", text: "Abandon retry and continue" });
    abandon.disabled = Boolean(memoState.storageError);
    abandon.addEventListener("click", memoAbandon);
    region.appendChild(el("div", { class: "actions-row" }, [inspect, abandon]));
  }
  if (memoState.recovery.notices.length) {
    region.appendChild(el("h3", { text: "Abandoned recovery \u2014 outcome unknown" }));
    memoState.recovery.notices.forEach((notice) => {
      const details = el("details", {}, [
        el("summary", { text: `${notice.title} \u00B7 ${notice.operation} \u00B7 outcome unknown` }),
      ]);
      details.appendChild(
        el("p", {
          text: "This browser-only notice does not assert failure, success, or cancellation. The original may still commit. It cannot be retried from this notice.",
        }),
      );
      const copy = el("textarea", {
        readonly: "",
        rows: "8",
        "aria-label": `Copy unknown-outcome notice ${notice.key}`,
      });
      copy.value = JSON.stringify(notice, null, 2);
      details.appendChild(copy);
      const remove = el("button", { type: "button", text: "Remove browser-only notice" });
      remove.disabled = Boolean(memoState.storageError);
      remove.addEventListener("click", () => {
        if (
          !window.confirm(
            "Remove this browser-only notice? Copy it first if you need to retain the unknown outcome. This changes no server state and does not establish what happened.",
          )
        )
          return;
        memoPersist({
          version: 1,
          active: memoState.recovery.active,
          notices: memoState.recovery.notices.filter(
            (item) => item.key !== notice.key || item.installationId !== notice.installationId,
          ),
        });
        memoRenderRecovery();
      });
      details.appendChild(remove);
      region.appendChild(details);
    });
  }
}

export function memoWriteButton(text: string, forbidden: boolean, action: () => void) {
  const button = el("button", {
    type: "button",
    text: text,
    "data-memo-write": "",
    "data-memo-forbidden": forbidden ? "true" : "false",
  });
  button.disabled = memoLocked() || forbidden;
  button.addEventListener("click", action);
  return button;
}

memoLoadRecovery();
