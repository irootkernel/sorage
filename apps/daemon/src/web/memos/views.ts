import { badge, el, emptyState, loading, timeNode, view } from "../dom";
import { hashQuery } from "../hash";
import { renderMarkdownSafe } from "../markdown";
import type { Memo, MemoInput, MemoOperation, MemoPage, ProjectEntry } from "../types";
import { memoLearnCap, memoRenderRecovery, memoRequest, memoSubmit, memoWriteButton } from "./recovery";
import { memoState, setMemoDetailRenderer } from "./state";
import { memoBodyText, memoBytes, memoTitle } from "./validation";

const MEMO_PREVIEW_DEBOUNCE_MS = 150;

export function memoClearEditorTimer() {
  if (memoState.editorTimer !== null) {
    clearTimeout(memoState.editorTimer);
    memoState.editorTimer = null;
  }
}

export function memoEditor(container: HTMLElement, projectId: string, memo: Memo | null) {
  memoClearEditorTimer();
  const key = memo ? memo.id : `new:${projectId}`;
  let previousDraft = memoState.drafts[key];
  const active = memoState.recovery.active;
  if (
    !previousDraft &&
    active &&
    (active.memoId || `new:${active.projectId}`) === key &&
    active.input &&
    typeof active.input.title === "string" &&
    typeof active.input.body === "string"
  )
    previousDraft = { title: active.input.title, body: active.input.body };
  const draft = previousDraft ?? { title: memo ? memo.title : "", body: memo ? memo.body : "" };
  memoState.drafts[key] = draft;
  const form = el("form", { "aria-label": memo ? "Edit Memo" : "Create Memo" });
  const title = el("input", { type: "text", "aria-label": "Memo title" });
  title.value = draft.title;
  const body = el("textarea", { rows: "9", "aria-label": "Memo body" });
  body.value = draft.body;
  const originalBody = draft.body;
  const displayedBody = body.value;
  const limits = el("p", { role: "status", class: "muted" });
  const preview = el("div", { class: "card", "aria-label": "Memo preview" });
  let composing = false;
  function syncDraft() {
    draft.title = title.value;
    draft.body = body.value === displayedBody ? originalBody : body.value;
  }
  function renderFeedback() {
    syncDraft();
    const bytes = memoBytes(draft.body);
    const valid = memoTitle(draft.title) && memoBodyText(draft.body, null);
    // The cap suffix claims a limit only while the last refresh actually
    // learned it; a failed refresh never presents a stale value as current.
    const capSuffix =
      memoState.bodyCapCurrent && memoState.bodyCap !== null
        ? `/${memoState.bodyCap} body bytes${bytes > memoState.bodyCap ? " \u2014 over the current limit" : ""}`
        : " body bytes";
    // Retention guidance is conditional: a current enabled sample above the
    // threshold names this body and the truthful numbers; a current enabled
    // sample at or below keeps the threshold-scoped sentence; an unknown,
    // failed or stale sample shows the generic sentence without numbers; a
    // current disabled configuration claims nothing.
    let riskSentence = "";
    if (memoState.risk.current && memoState.risk.enabled && bytes > memoState.risk.warnBytes)
      riskSentence =
        " With Git backup enabled, Git history retains every committed revision of this body (" +
        bytes +
        " UTF-8 bytes, above gitBackup.largeArtifactWarningBytes " +
        memoState.risk.warnBytes +
        ") forever.";
    else if (memoState.risk.current && memoState.risk.enabled)
      riskSentence =
        " With Git backup enabled, Git history retains every committed revision of a body above gitBackup.largeArtifactWarningBytes (" +
        memoState.risk.warnBytes +
        ") forever.";
    else if (!memoState.risk.current)
      riskSentence =
        " With Git backup enabled, Git history retains every committed revision of a body above gitBackup.largeArtifactWarningBytes forever.";
    limits.textContent =
      Array.from(draft.title.trim()).length +
      "/200 title characters, " +
      memoBytes(draft.title) +
      "/800 title bytes; " +
      bytes +
      capSuffix +
      "." +
      (valid
        ? ""
        : " Invalid input: provide a single-line title within the limits; body cannot contain NUL or invalid Unicode.") +
      riskSentence;
    preview.replaceChildren(el("h4", { text: "Read-only preview" }), renderMarkdownSafe(draft.body));
  }
  function update() {
    memoClearEditorTimer();
    renderFeedback();
  }
  function scheduleUpdate() {
    syncDraft();
    memoClearEditorTimer();
    memoState.editorTimer = setTimeout(() => {
      memoState.editorTimer = null;
      if (!limits.isConnected) return;
      renderFeedback();
    }, MEMO_PREVIEW_DEBOUNCE_MS);
  }
  title.addEventListener("input", scheduleUpdate);
  body.addEventListener("input", scheduleUpdate);
  form.addEventListener("compositionstart", () => {
    composing = true;
  });
  form.addEventListener("compositionend", () => {
    composing = false;
    update();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  const save = memoWriteButton(memo ? "Save Memo" : "Create Memo", false, () => {
    form.requestSubmit();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (composing) return;
    update();
    const input: MemoInput = { title: draft.title.trim() };
    if (memo) input.expectedRowVersion = memo.rowVersion;
    else {
      input.projectId = projectId;
      input.body = draft.body;
    }
    // Omit the body only when the draft still equals the loaded server
    // body \u2014 the authoritative comparison, not the remounted textarea seam
    // \u2014 so a retained edited draft always saves its body, while a title-only
    // edit stays legal when the accepting cap is below the stored size.
    if (memo && draft.body !== memo.body) input.body = draft.body;
    memoSubmit(memo ? "update" : "add", projectId, memo ? memo.id : null, draft.title, input);
  });
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Title " }, [title])]));
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Body (Markdown) " }, [body])]));
  form.appendChild(limits);
  form.appendChild(save);
  form.appendChild(preview);
  container.appendChild(form);
  update();
  memoLearnCap().then(() => {
    if (limits.isConnected) update();
  });
}

function memoPageStart(heading: string) {
  memoClearEditorTimer();
  const ticket = ++memoState.renderTicket;
  view().replaceChildren(el("h2", { text: heading }));
  view().appendChild(
    el("p", {
      class: "muted",
      text: "Memos store reminders; their text does not run work. Pending request bodies are temporarily retained in this tab's session storage. Reload can recover them; tab closure, browser data removal, or browser restart may lose this local recovery material. Stored Memos remain on the server.",
    }),
  );
  memoRenderRecovery();
  return ticket;
}

export function memoList() {
  const ticket = memoPageStart("Memos");
  const query = new URLSearchParams(hashQuery());
  const selected = query.get("projectId") || (query.get("allProjects") === "true" ? "*" : "");
  memoState.visible = { kind: "list", projectId: selected };
  const status = loading("Loading Projects and Memos\u2026");
  view().appendChild(status);
  memoRequest<ProjectEntry[]>("/api/v1/projects")
    .then((result) => {
      if (ticket !== memoState.renderTicket || !status.isConnected) return;
      if (result.status !== 200 || !result.body.ok) throw new Error("Projects unavailable or authentication expired");
      status.remove();
      const project = el("select", { "aria-label": "Memo Project" }, [
        el("option", { value: "", text: "Choose a Project" }),
        el("option", { value: "*", text: "All Projects (explicit)" }),
      ]);
      result.body.data.forEach((entry) => {
        project.appendChild(
          el("option", {
            value: entry.project.id,
            text: entry.project.displayName + (entry.project.status === "archived" ? " (archived)" : ""),
          }),
        );
      });
      project.value = selected;
      const state = el(
        "select",
        { "aria-label": "Memo state" },
        ["open", "done", "dismissed", "all"].map((value) =>
          el("option", { value: value, text: value.charAt(0).toUpperCase() + value.slice(1) }),
        ),
      );
      state.value = query.get("state") || "open";
      const search = el("input", {
        type: "search",
        "aria-label": "Search Memos",
        placeholder: "Literal title or body text",
      });
      search.value = query.get("query") || "";
      const filters = el("form", { class: "filters" }, [
        el("label", { text: "Project " }, [project]),
        el("label", { text: "State " }, [state]),
        el("label", { text: "Search " }, [search]),
        el("button", { type: "submit", text: "Apply Memo filters" }),
      ]);
      filters.addEventListener("submit", (event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        if (project.value === "*") next.set("allProjects", "true");
        else if (project.value) next.set("projectId", project.value);
        next.set("state", state.value);
        if (search.value) next.set("query", search.value);
        const hash = `/memos?${next}`;
        if (location.hash === `#${hash}`) memoList();
        else location.hash = hash;
      });
      view().appendChild(filters);
      if (!selected) {
        view().appendChild(emptyState("Choose a Project or explicitly select All Projects to read Memos."));
        return;
      }
      const selectedProject = result.body.data.find((entry) => entry.project.id === selected);
      if (selected !== "*" && !selectedProject) {
        view().appendChild(emptyState("Project not found. Choose a registered Project."));
        return;
      }
      const rows = el("div", {});
      view().appendChild(rows);
      const params = new URLSearchParams();
      params.set(selected === "*" ? "allProjects" : "projectId", selected === "*" ? "true" : selected);
      ["state", "query", "cursor"].forEach((key) => {
        const value = query.get(key);
        if (value !== null) params.set(key, value);
      });
      rows.appendChild(loading("Loading Memos\u2026"));
      memoRequest<MemoPage>(`/api/v1/memos?${params}`)
        .then((page) => {
          if (ticket !== memoState.renderTicket || !rows.isConnected) return;
          rows.replaceChildren();
          if (page.status !== 200 || !page.body.ok) {
            rows.appendChild(
              emptyState(
                `Memos unavailable: ${!page.body.ok && page.body.error ? page.body.error.code : "invalid response"}`,
              ),
            );
            return;
          }
          if (!page.body.data.items.length) rows.appendChild(emptyState("No Memos match these filters."));
          page.body.data.items.forEach((memo) => {
            const card = el("article", { class: "card memo-row" }, [
              el("h3", {}, [el("a", { href: `#/memo/${encodeURIComponent(memo.id)}`, text: memo.title })]),
              el("p", {
                text:
                  memo.projectDisplayName +
                  " \u00B7 " +
                  memo.projectSlug +
                  (memo.projectStatus === "archived" ? " (archived)" : ""),
              }),
              badge(memo.state),
              timeNode(memo.updatedAt),
              el("p", { text: memo.bodyPreview + (memo.bodyPreviewTruncated ? "\u2026" : "") }),
            ]);
            rows.appendChild(card);
          });
          if (page.body.data.nextCursor) {
            const next = new URLSearchParams(params);
            next.set("cursor", page.body.data.nextCursor);
            rows.appendChild(el("a", { href: `#/memos?${next}`, text: "Next Memo page" }));
          }
          if (query.has("cursor")) {
            const first = new URLSearchParams(params);
            first.delete("cursor");
            rows.appendChild(el("a", { href: `#/memos?${first}`, text: "Restart Memo list" }));
          }
        })
        .catch(() => {
          if (rows.isConnected)
            rows.replaceChildren(emptyState("Disconnected: Memos could not load. Reload to retry."));
        });
      if (selectedProject) {
        if (selectedProject.project.status === "archived")
          view().appendChild(
            emptyState(
              "This Project is archived: existing Memos remain readable and open notes can be edited or closed; new Memos and state-changing reopens are unavailable.",
            ),
          );
        else {
          view().appendChild(el("h3", { text: "New Memo" }));
          memoEditor(view(), selected, null);
        }
      }
      memoRenderRecovery();
    })
    .catch(() => {
      if (status.isConnected)
        status.textContent =
          "Disconnected or permission denied: Projects could not load. Reauthenticate with sorage web if needed.";
    });
}

export function memoDetail(id: string) {
  const ticket = memoPageStart("Memo detail");
  memoState.visible = { kind: "detail", id: id };
  const pending = loading("Loading Memo\u2026");
  view().appendChild(pending);
  Promise.all([
    memoRequest<Memo>(`/api/v1/memos/${encodeURIComponent(id)}`),
    memoRequest<ProjectEntry[]>("/api/v1/projects"),
  ])
    .then((results) => {
      if (ticket !== memoState.renderTicket || !pending.isConnected) return;
      const result = results[0];
      if (result.status !== 200 || !result.body.ok || !results[1].body.ok) {
        pending.textContent = `Memo unavailable: ${!result.body.ok && result.body.error ? result.body.error.code : "permission error"}`;
        return;
      }
      pending.remove();
      memoState.refreshing = false;
      const memo = result.body.data;
      const project = results[1].body.data.find((entry) => entry.project.id === memo.projectId);
      const archived = project && project.project.status === "archived";
      view().appendChild(
        el("a", { href: `#/memos?projectId=${encodeURIComponent(memo.projectId)}`, text: "Back to Project Memos" }),
      );
      view().appendChild(el("h3", { text: memo.title }));
      view().appendChild(
        el("p", { text: (project ? project.project.displayName : memo.projectId) + (archived ? " (archived)" : "") }),
      );
      view().appendChild(badge(memo.state));
      const meta = el("dl", { class: "meta" });
      [
        ["Memo ID", memo.id],
        ["Project ID", memo.projectId],
        ["Row version", memo.rowVersion],
        ["Created", memo.createdAt],
        ["Updated", memo.updatedAt],
        ["Created by", "User"],
        ["Updated by", "User"],
        ["Closed", memo.closedAt || "Not closed"],
        ["Closed by", memo.closedBy ? "User" : "Not closed"],
      ].forEach((pair) => {
        meta.appendChild(el("dt", { text: String(pair[0]) }));
        meta.appendChild(el("dd", { text: String(pair[1]) }));
      });
      view().appendChild(meta);
      view().appendChild(el("section", { "aria-label": "Full Memo body" }, [renderMarkdownSafe(memo.body)]));
      if (archived)
        view().appendChild(
          emptyState(
            "Archived Project: new Memos and state-changing reopens are unavailable. Existing open notes can be edited or closed.",
          ),
        );
      if (memo.state === "open") memoEditor(view(), memo.projectId, memo);
      else view().appendChild(emptyState("Closed content is read-only. Reopen explicitly to edit."));
      const actions = el("div", { class: "actions-row" });
      (
        (memo.state === "open"
          ? [
              ["Mark done", "done"],
              ["Dismiss", "dismiss"],
            ]
          : [["Reopen", "reopen"]]) as [string, MemoOperation][]
      ).forEach((action) => {
        actions.appendChild(
          memoWriteButton(action[0], Boolean(action[1] === "reopen" && archived), () => {
            memoSubmit(action[1], memo.projectId, memo.id, memo.title, { expectedRowVersion: memo.rowVersion });
          }),
        );
      });
      const refresh = el("button", { type: "button", text: "Re-read current Memo (keep draft)" });
      refresh.addEventListener("click", () => {
        memoDetail(id);
      });
      actions.appendChild(refresh);
      view().appendChild(actions);
      memoRenderRecovery();
    })
    .catch(() => {
      if (pending.isConnected)
        pending.textContent = "Disconnected: Memo could not load. Reload or reauthenticate with sorage web.";
    });
}

export function resetMemoViewState() {
  memoClearEditorTimer();
  memoState.renderTicket += 1;
  memoState.visible = null;
}

setMemoDetailRenderer(memoDetail);
