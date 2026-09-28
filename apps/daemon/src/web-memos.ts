/** Inserted into the existing web-app closure; uses its API, DOM and safe Markdown helpers. */
export const WEB_MEMOS_JS = String.raw`
  var MEMO_STORAGE_KEY = "sorage-memo-recovery-v1";
  var memoRecovery = { version: 1, active: null, notices: [] };
  var memoStorageRaw = null;
  var memoStorageError = "";
  var memoMessage = "";
  var memoFlight = null;
  var memoPreparing = false;
  var memoRefreshing = false;
  var memoInstallation = null;
  var memoDrafts = Object.create(null);
  var memoRenderTicket = 0;
  var memoVisible = null;

  function memoUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
  function memoBytes(text) { return new TextEncoder().encode(text).length; }
  function memoText(text, limit) {
    if (typeof text !== "string" || memoBytes(text) > limit || text.indexOf("\0") !== -1) return false;
    for (var scalar of text) { var code = scalar.codePointAt(0); if (code >= 0xd800 && code <= 0xdfff) return false; }
    return true;
  }
  function memoTitle(text) { return memoText(text, 800) && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text) && Array.from(text.trim()).length > 0 && Array.from(text.trim()).length <= 200; }
  function memoVersion(value) { return Number.isSafeInteger(value) && value > 0; }
  function memoTime(value) { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !isNaN(Date.parse(value)); }
  function memoObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function memoKeys(value, keys) { return memoObject(value) && Object.keys(value).every(function (key) { return keys.indexOf(key) !== -1; }); }
  function memoMetadata(value) {
    return memoObject(value) && typeof value.origin === "string" && value.origin.length <= 200 && memoUuid(value.installationId) && memoUuid(value.key) && memoUuid(value.projectId) && (value.memoId === null || memoUuid(value.memoId)) && ["add", "update", "done", "dismiss", "reopen"].indexOf(value.operation) !== -1 && memoTitle(value.title) && memoTime(value.firstAttemptAt);
  }
  function memoStoredState(value) {
    if (!memoKeys(value, ["version", "active", "notices"]) || value.version !== 1 || !Array.isArray(value.notices) || value.notices.length > 32) return false;
    if (value.active !== null && (!memoMetadata(value.active) || !memoKeys(value.active, ["origin", "installationId", "key", "projectId", "memoId", "operation", "title", "firstAttemptAt", "input"]))) return false;
    var seen = new Set();
    if (value.active) seen.add(value.active.installationId + ":" + value.active.key);
    return value.notices.every(function (notice) {
      var key = notice.installationId + ":" + notice.key;
      if (seen.has(key)) return false;
      seen.add(key);
      return memoMetadata(notice) && memoKeys(notice, ["origin", "installationId", "key", "projectId", "memoId", "operation", "title", "firstAttemptAt", "expectedRowVersion", "abandonedAt", "outcome", "retryDisposition"]) && (notice.expectedRowVersion === null || memoVersion(notice.expectedRowVersion)) && memoTime(notice.abandonedAt) && notice.outcome === "unknown" && notice.retryDisposition === "abandoned";
    });
  }
  function memoLoadRecovery() {
    try {
      var raw = sessionStorage.getItem(MEMO_STORAGE_KEY);
      if (raw !== null && memoBytes(raw) > 524288) throw new Error("Oversized recovery record");
      var parsed = raw === null ? { version: 1, active: null, notices: [] } : JSON.parse(raw);
      if (!memoStoredState(parsed)) throw new Error("Invalid recovery record");
      memoRecovery = parsed;
      memoStorageRaw = raw;
    } catch (error) { memoStorageError = "Local Memo recovery storage is unreadable or malformed. Writes are blocked; preserve this tab's data and investigate storage before reloading."; }
  }
  function memoPersist(next) {
    try {
      if (memoStorageError || sessionStorage.getItem(MEMO_STORAGE_KEY) !== memoStorageRaw) throw new Error("Recovery storage changed");
      var raw = JSON.stringify(next);
      if (!memoStoredState(next) || memoBytes(raw) > 524288) throw new Error("Recovery record exceeds its bounds");
      sessionStorage.setItem(MEMO_STORAGE_KEY, raw);
      if (sessionStorage.getItem(MEMO_STORAGE_KEY) !== raw) throw new Error("Recovery storage did not retain the write");
      memoRecovery = next;
      memoStorageRaw = raw;
      return true;
    } catch (error) {
      memoStorageError = "Local Memo recovery storage could not be saved or verified. No new request will be sent and writes remain blocked. Preserve this tab's data before repairing storage.";
      memoRenderRecovery();
      return false;
    }
  }
  function memoLocked() { return Boolean(memoStorageError || memoRecovery.active || memoPreparing || memoRefreshing || memoFlight); }
  function memoMatches(pending) { var current = memoRecovery.active; return current !== null && current.key === pending.key && current.installationId === pending.installationId && current.origin === pending.origin; }
  function memoRequest(path, init) {
    var controller = new AbortController();
    var timer;
    var timeout = new Promise(function (_, reject) { timer = setTimeout(function () { controller.abort(); reject(new Error("Request timed out")); }, 15000); });
    return Promise.race([api(path, Object.assign({}, init || {}, { signal: controller.signal })), timeout]).finally(function () { clearTimeout(timer); });
  }
  function memoIdentify() {
    return memoRequest("/api/v1/health").then(function (result) {
      if (result.status !== 200 || !result.body || result.body.ok !== true || !memoUuid(result.body.data.installationId)) throw new Error("Cannot verify this Installation");
      memoInstallation = result.body.data.installationId;
      return memoInstallation;
    });
  }
  function memoInputValid(operation, input, projectId, memoId) {
    if (!memoObject(input) || !memoUuid(projectId)) return false;
    if (operation === "add") return memoId === null && memoKeys(input, ["projectId", "title", "body"]) && input.projectId === projectId && memoTitle(input.title) && input.title === input.title.trim() && memoText(input.body, 65536);
    if (!memoUuid(memoId) || !memoVersion(input.expectedRowVersion)) return false;
    if (operation === "update") return memoKeys(input, ["title", "body", "expectedRowVersion"]) && memoTitle(input.title) && input.title === input.title.trim() && memoText(input.body, 65536);
    return ["done", "dismiss", "reopen"].indexOf(operation) !== -1 && memoKeys(input, ["expectedRowVersion"]);
  }
  function memoActor(value) { return memoKeys(value, ["kind", "id"]) && value.kind === "user" && value.id === null; }
  function memoReceipt(result, pending, recovery) {
    var envelope = result.body;
    if (result.status !== 200 || !memoKeys(envelope, ["ok", "data", "meta"]) || envelope.ok !== true || !envelope.meta || !memoUuid(envelope.meta.requestId)) return false;
    var data = envelope.data;
    if (!memoKeys(data, ["memo", "changed", "replayed"]) || typeof data.changed !== "boolean" || typeof data.replayed !== "boolean" || (recovery && data.replayed !== true)) return false;
    var memo = data.memo;
    if (!memoKeys(memo, ["id", "projectId", "title", "body", "state", "rowVersion", "createdAt", "updatedAt", "createdBy", "updatedBy", "closedAt", "closedBy"]) || !memoUuid(memo.id) || memo.projectId !== pending.projectId || !memoTitle(memo.title) || memo.title !== memo.title.trim() || !memoText(memo.body, 65536) || !memoVersion(memo.rowVersion) || !memoTime(memo.createdAt) || !memoTime(memo.updatedAt) || !memoActor(memo.createdBy) || !memoActor(memo.updatedBy)) return false;
    if (memo.state === "open") { if (memo.closedAt !== null || memo.closedBy !== null) return false; }
    else if (["done", "dismissed"].indexOf(memo.state) === -1 || memo.closedAt !== memo.updatedAt || !memoActor(memo.closedBy) || memo.rowVersion < 2) return false;
    var input = pending.input;
    if (pending.operation === "add") return data.changed && memo.rowVersion === 1 && memo.state === "open" && memo.title === input.title && memo.body === input.body;
    if (memo.id !== pending.memoId || memo.rowVersion !== input.expectedRowVersion + (data.changed ? 1 : 0)) return false;
    if (pending.operation === "update") return memo.state === "open" && memo.title === input.title && memo.body === input.body;
    return memo.state === ({ done: "done", dismiss: "dismissed", reopen: "open" })[pending.operation];
  }
  function memoFirstRefusal(result) {
    var statuses = { MEMO_INVALID_INPUT: 422, MEMO_TOO_LARGE: 413, MEMO_NOT_FOUND: 404, MEMO_NOT_OPEN: 409, ROW_VERSION_CONFLICT: 409, PROJECT_ARCHIVED: 409, PROJECT_NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409, SERVICE_PAUSED: 423, UNAUTHENTICATED: 401, TOKEN_INVALID: 401 };
    var body = result.body;
    return memoKeys(body, ["ok", "error", "meta"]) && body.ok === false && memoObject(body.error) && typeof body.error.message === "string" && body.meta && memoUuid(body.meta.requestId) && statuses[body.error.code] === result.status;
  }
  function memoRefreshCurrent(pending, id, success) {
    memoRefreshing = true;
    memoRenderRecovery();
    return memoRequest("/api/v1/memos/" + id).then(function (result) {
      if (result.status !== 200 || !result.body.ok) throw new Error("Current Memo could not be reloaded");
      memoRefreshing = false;
      if (success && (pending.operation === "add" || pending.operation === "update")) {
        var draftKey = pending.memoId || "new:" + pending.projectId;
        var draft = memoDrafts[draftKey];
        if (draft && draft.title.trim() === pending.input.title && draft.body === pending.input.body) delete memoDrafts[draftKey];
        else if (draft && pending.operation === "add" && !memoDrafts[id]) {
          memoDrafts[id] = draft;
          delete memoDrafts[draftKey];
        }
      }
      if (memoVisible && memoVisible.kind === "detail" && memoVisible.id === id) memoDetail(id);
      else if (success && pending.operation === "add" && memoVisible && memoVisible.kind === "list" && memoVisible.projectId === pending.projectId) location.hash = "/memo/" + id;
      memoRenderRecovery();
    }).catch(function () {
      memoMessage += " Current state could not be reloaded. Read the Memo again before another write.";
      memoRenderRecovery();
    });
  }
  function memoDispatch(pending, recovery) {
    if (!memoMatches(pending) || memoFlight || memoStorageError) return Promise.resolve();
    var flight = { key: pending.key, installationId: pending.installationId };
    memoFlight = flight;
    memoRenderRecovery();
    return memoIdentify().then(function (installation) {
      if (!memoMatches(pending) || memoFlight !== flight) return null;
      if (pending.origin !== location.origin || installation !== pending.installationId || !memoInputValid(pending.operation, pending.input, pending.projectId, pending.memoId)) throw new Error("Original request material or Installation does not match. Investigate read-only or explicitly abandon recovery.");
      var path = "/api/v1/memos" + (pending.memoId ? "/" + pending.memoId : "") + (["done", "dismiss", "reopen"].indexOf(pending.operation) !== -1 ? "/" + pending.operation : "");
      return memoRequest(path, { method: pending.operation === "update" ? "PATCH" : "POST", headers: { "content-type": "application/json", "idempotency-key": pending.key, "idempotency-mode": recovery ? "replay-only" : "execute" }, body: JSON.stringify(pending.input) });
    }).then(function (result) {
      if (!result || !memoMatches(pending) || memoFlight !== flight) return;
      if (memoReceipt(result, pending, recovery)) {
        if (!memoPersist({ version: 1, active: null, notices: memoRecovery.notices })) return;
        memoMessage = result.body.data.replayed ? "Original request confirmed by a historical receipt; refreshing current state." : "Memo saved; refreshing current state.";
        return memoRefreshCurrent(pending, result.body.data.memo.id, true);
      }
      if (!recovery && memoFirstRefusal(result)) {
        if (!memoPersist({ version: 1, active: null, notices: memoRecovery.notices })) return;
        memoMessage = result.body.error.code + ": request refused without mutation. Your draft is preserved. Review current state before a new action.";
        if (pending.memoId) return memoRefreshCurrent(pending, pending.memoId, false);
      } else {
        memoMessage = "Outcome unknown. " + (result.body && result.body.error ? result.body.error.code : "Unrecognized response") + ". Inspect the original request with replay-only, or explicitly abandon recovery. No replacement was sent.";
      }
    }).catch(function (error) {
      if (memoMatches(pending) && memoFlight === flight) memoMessage = "Outcome unknown. " + error.message + " No replacement was sent.";
    }).finally(function () { if (memoFlight === flight) memoFlight = null; memoRenderRecovery(); });
  }
  function memoSubmit(operation, projectId, memoId, title, input) {
    if (memoLocked()) { memoMessage = "Another Memo request or a local recovery problem blocks writes in this tab."; memoRenderRecovery(); return Promise.resolve(); }
    if (!memoInputValid(operation, input, projectId, memoId)) { memoMessage = "Invalid Memo input: title needs 1–200 characters / at most 800 UTF-8 bytes; body permits 65,536 bytes and no NUL or invalid Unicode."; memoRenderRecovery(); return Promise.resolve(); }
    memoPreparing = true;
    memoRenderRecovery();
    return memoIdentify().then(function (installation) {
      var pending = { origin: location.origin, installationId: installation, operation: operation, key: crypto.randomUUID(), projectId: projectId, memoId: memoId, title: title.trim(), firstAttemptAt: new Date().toISOString(), input: input };
      if (memoRecovery.active || !memoPersist({ version: 1, active: pending, notices: memoRecovery.notices })) return;
      memoPreparing = false;
      return memoDispatch(pending, false);
    }).catch(function () { memoMessage = "Disconnected: cannot verify the Installation. Draft preserved; no Memo request sent."; }).finally(function () { memoPreparing = false; memoRenderRecovery(); });
  }
  function memoAbandon() {
    var pending = memoRecovery.active;
    if (!pending || memoStorageError) return;
    if (memoRecovery.notices.length >= 32) { memoMessage = "32 unknown-outcome notices are retained. Inspect/copy and explicitly remove an older notice before abandoning this request."; memoRenderRecovery(); return; }
    if (!window.confirm("Abandon retry and continue? The original may already have committed or may finish later. This does not cancel or delete server work. Repeating the same intent with a new request can duplicate effects. Its outcome will remain unknown.")) return;
    var notice = { origin: pending.origin, installationId: pending.installationId, key: pending.key, projectId: pending.projectId, memoId: pending.memoId, operation: pending.operation, title: pending.title, firstAttemptAt: pending.firstAttemptAt, expectedRowVersion: pending.input && memoVersion(pending.input.expectedRowVersion) ? pending.input.expectedRowVersion : null, abandonedAt: new Date().toISOString(), outcome: "unknown", retryDisposition: "abandoned" };
    if (!memoMatches(pending) || !memoPersist({ version: 1, active: null, notices: memoRecovery.notices.concat([notice]) })) return;
    // Detach only this local attempt; its server operation may still complete.
    memoFlight = null;
    memoMessage = "Recovery abandoned; the original outcome is unknown. No server request was cancelled or sent. A new action can duplicate the original intent.";
    if (pending.memoId) memoRefreshCurrent(pending, pending.memoId, false);
    memoRenderRecovery();
  }
  function memoRenderRecovery() {
    document.querySelectorAll("[data-memo-write]").forEach(function (button) { button.disabled = memoLocked() || button.getAttribute("data-memo-forbidden") === "true"; });
    var region = document.getElementById("memo-recovery");
    if (!region) return;
    region.replaceChildren();
    if (memoStorageError) region.appendChild(el("p", { role: "alert", text: memoStorageError }));
    if (memoMessage) region.appendChild(el("p", { role: "status", text: memoMessage }));
    var pending = memoRecovery.active;
    if (pending) {
      region.appendChild(el("h3", { text: "Memo outcome unknown — writes paused in this tab" }));
      region.appendChild(el("p", { text: pending.operation + " · " + pending.title + " · Project " + pending.projectId + (pending.memoId ? " · Memo " + pending.memoId : "") }));
      region.appendChild(el("p", { class: "mono", text: "Original key: " + pending.key + " · First attempt: " + pending.firstAttemptAt }));
      var inspect = el("button", { type: "button", text: "Inspect original request (replay-only)" });
      inspect.disabled = Boolean(memoFlight || memoStorageError);
      inspect.addEventListener("click", function () { if (!memoFlight) memoDispatch(pending, true); });
      var abandon = el("button", { type: "button", text: "Abandon retry and continue" });
      abandon.disabled = Boolean(memoStorageError);
      abandon.addEventListener("click", memoAbandon);
      region.appendChild(el("div", { class: "actions-row" }, [inspect, abandon]));
    }
    if (memoRecovery.notices.length) {
      region.appendChild(el("h3", { text: "Abandoned recovery — outcome unknown" }));
      memoRecovery.notices.forEach(function (notice) {
        var details = el("details", {}, [el("summary", { text: notice.title + " · " + notice.operation + " · outcome unknown" })]);
        details.appendChild(el("p", { text: "This browser-only notice does not assert failure, success, or cancellation. The original may still commit. It cannot be retried from this notice." }));
        var copy = el("textarea", { readonly: "", rows: "8", "aria-label": "Copy unknown-outcome notice " + notice.key });
        copy.value = JSON.stringify(notice, null, 2);
        details.appendChild(copy);
        var remove = el("button", { type: "button", text: "Remove browser-only notice" });
        remove.disabled = Boolean(memoStorageError);
        remove.addEventListener("click", function () {
          if (!window.confirm("Remove this browser-only notice? Copy it first if you need to retain the unknown outcome. This changes no server state and does not establish what happened.")) return;
          memoPersist({ version: 1, active: memoRecovery.active, notices: memoRecovery.notices.filter(function (item) { return item.key !== notice.key || item.installationId !== notice.installationId; }) });
          memoRenderRecovery();
        });
        details.appendChild(remove);
        region.appendChild(details);
      });
    }
  }
  function memoWriteButton(text, forbidden, action) {
    var button = el("button", { type: "button", text: text, "data-memo-write": "", "data-memo-forbidden": forbidden ? "true" : "false" });
    button.disabled = memoLocked() || forbidden;
    button.addEventListener("click", action);
    return button;
  }
  function memoEditor(container, projectId, memo) {
    var key = memo ? memo.id : "new:" + projectId;
    var draft = memoDrafts[key];
    var active = memoRecovery.active;
    if (!draft && active && (active.memoId || "new:" + active.projectId) === key && active.input && typeof active.input.title === "string" && typeof active.input.body === "string") draft = { title: active.input.title, body: active.input.body };
    if (!draft) draft = { title: memo ? memo.title : "", body: memo ? memo.body : "" };
    memoDrafts[key] = draft;
    var form = el("form", { "aria-label": memo ? "Edit Memo" : "Create Memo" });
    var title = el("input", { type: "text", "aria-label": "Memo title" });
    title.value = draft.title;
    var body = el("textarea", { rows: "9", "aria-label": "Memo body" });
    body.value = draft.body;
    var originalBody = draft.body;
    var displayedBody = body.value;
    var limits = el("p", { role: "status", class: "muted" });
    var preview = el("div", { class: "card", "aria-label": "Memo preview" });
    var composing = false;
    function update() {
      draft.title = title.value;
      draft.body = body.value === displayedBody ? originalBody : body.value;
      var valid = memoTitle(draft.title) && memoText(draft.body, 65536);
      limits.textContent = Array.from(draft.title.trim()).length + "/200 title characters, " + memoBytes(draft.title) + "/800 title bytes; " + memoBytes(draft.body) + "/65536 body bytes." + (valid ? "" : " Invalid input: provide a single-line title within the limits; body cannot contain NUL or invalid Unicode.");
      preview.replaceChildren(el("h4", { text: "Read-only preview" }), renderMarkdownSafe(draft.body));
    }
    title.addEventListener("input", update);
    body.addEventListener("input", update);
    form.addEventListener("compositionstart", function () { composing = true; });
    form.addEventListener("compositionend", function () { composing = false; update(); });
    form.addEventListener("keydown", function (event) { if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault(); });
    var save = memoWriteButton(memo ? "Save Memo" : "Create Memo", false, function () { form.requestSubmit(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (composing) return;
      update();
      var input = { title: draft.title.trim(), body: draft.body };
      if (memo) input.expectedRowVersion = memo.rowVersion;
      else input.projectId = projectId;
      memoSubmit(memo ? "update" : "add", projectId, memo ? memo.id : null, draft.title, input);
    });
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Title " }, [title])]));
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Body (Markdown) " }, [body])]));
    form.appendChild(limits);
    form.appendChild(save);
    form.appendChild(preview);
    container.appendChild(form);
    update();
  }
  function memoPageStart(heading) {
    var ticket = ++memoRenderTicket;
    view().replaceChildren(el("h2", { text: heading }));
    view().appendChild(el("p", { class: "muted", text: "Memos store reminders; their text does not run work. Pending request bodies are temporarily retained in this tab's session storage. Reload can recover them; tab closure, browser data removal, or browser restart may lose this local recovery material. Stored Memos remain on the server." }));
    memoRenderRecovery();
    return ticket;
  }
  function memoList() {
    var ticket = memoPageStart("Memos");
    var query = new URLSearchParams(location.hash.split("?")[1] || "");
    var selected = query.get("projectId") || (query.get("allProjects") === "true" ? "*" : "");
    memoVisible = { kind: "list", projectId: selected };
    var status = loading("Loading Projects and Memos…");
    view().appendChild(status);
    memoRequest("/api/v1/projects").then(function (result) {
      if (ticket !== memoRenderTicket || !status.isConnected) return;
      if (result.status !== 200 || !result.body.ok) throw new Error("Projects unavailable or authentication expired");
      status.remove();
      var project = el("select", { "aria-label": "Memo Project" }, [el("option", { value: "", text: "Choose a Project" }), el("option", { value: "*", text: "All Projects (explicit)" })]);
      result.body.data.forEach(function (entry) { project.appendChild(el("option", { value: entry.project.id, text: entry.project.displayName + (entry.project.status === "archived" ? " (archived)" : "") })); });
      project.value = selected;
      var state = el("select", { "aria-label": "Memo state" }, ["open", "done", "dismissed", "all"].map(function (value) { return el("option", { value: value, text: value[0].toUpperCase() + value.slice(1) }); }));
      state.value = query.get("state") || "open";
      var search = el("input", { type: "search", "aria-label": "Search Memos", placeholder: "Literal title or body text" });
      search.value = query.get("query") || "";
      var filters = el("form", { class: "filters" }, [el("label", { text: "Project " }, [project]), el("label", { text: "State " }, [state]), el("label", { text: "Search " }, [search]), el("button", { type: "submit", text: "Apply Memo filters" })]);
      filters.addEventListener("submit", function (event) { event.preventDefault(); var next = new URLSearchParams(); if (project.value === "*") next.set("allProjects", "true"); else if (project.value) next.set("projectId", project.value); next.set("state", state.value); if (search.value) next.set("query", search.value); var hash = "/memos?" + next; if (location.hash === "#" + hash) memoList(); else location.hash = hash; });
      view().appendChild(filters);
      if (!selected) { view().appendChild(emptyState("Choose a Project or explicitly select All Projects to read Memos.")); return; }
      var selectedProject = result.body.data.find(function (entry) { return entry.project.id === selected; });
      if (selected !== "*" && !selectedProject) { view().appendChild(emptyState("Project not found. Choose a registered Project.")); return; }
      var rows = el("div", {});
      view().appendChild(rows);
      var params = new URLSearchParams();
      params.set(selected === "*" ? "allProjects" : "projectId", selected === "*" ? "true" : selected);
      ["state", "query", "cursor"].forEach(function (key) { if (query.has(key)) params.set(key, query.get(key)); });
      rows.appendChild(loading("Loading Memos…"));
      memoRequest("/api/v1/memos?" + params).then(function (page) {
        if (ticket !== memoRenderTicket || !rows.isConnected) return;
        rows.replaceChildren();
        if (page.status !== 200 || !page.body.ok) { rows.appendChild(emptyState("Memos unavailable: " + (page.body.error ? page.body.error.code : "invalid response"))); return; }
        if (!page.body.data.items.length) rows.appendChild(emptyState("No Memos match these filters."));
        page.body.data.items.forEach(function (memo) {
          var card = el("article", { class: "card memo-row" }, [el("h3", {}, [el("a", { href: "#/memo/" + memo.id, text: memo.title })]), el("p", { text: memo.projectDisplayName + " · " + memo.projectSlug + (memo.projectStatus === "archived" ? " (archived)" : "") }), badge(memo.state), timeNode(memo.updatedAt), el("p", { text: memo.bodyPreview + (memo.bodyPreviewTruncated ? "…" : "") })]);
          rows.appendChild(card);
        });
        if (page.body.data.nextCursor) { var next = new URLSearchParams(params); next.set("cursor", page.body.data.nextCursor); rows.appendChild(el("a", { href: "#/memos?" + next, text: "Next Memo page" })); }
        if (query.has("cursor")) { var first = new URLSearchParams(params); first.delete("cursor"); rows.appendChild(el("a", { href: "#/memos?" + first, text: "Restart Memo list" })); }
      }).catch(function () { if (rows.isConnected) rows.replaceChildren(emptyState("Disconnected: Memos could not load. Reload to retry.")); });
      if (selectedProject) {
        if (selectedProject.project.status === "archived") view().appendChild(emptyState("This Project is archived: existing Memos remain readable and open notes can be edited or closed; new Memos and state-changing reopens are unavailable."));
        else { view().appendChild(el("h3", { text: "New Memo" })); memoEditor(view(), selected, null); }
      }
      memoRenderRecovery();
    }).catch(function () { if (status.isConnected) status.textContent = "Disconnected or permission denied: Projects could not load. Reauthenticate with sorage web if needed."; });
  }
  function memoDetail(id) {
    var ticket = memoPageStart("Memo detail");
    memoVisible = { kind: "detail", id: id };
    var pending = loading("Loading Memo…");
    view().appendChild(pending);
    Promise.all([memoRequest("/api/v1/memos/" + encodeURIComponent(id)), memoRequest("/api/v1/projects")]).then(function (results) {
      if (ticket !== memoRenderTicket || !pending.isConnected) return;
      var result = results[0];
      if (result.status !== 200 || !result.body.ok || !results[1].body.ok) { pending.textContent = "Memo unavailable: " + (result.body.error ? result.body.error.code : "permission error"); return; }
      pending.remove();
      memoRefreshing = false;
      var memo = result.body.data;
      var project = results[1].body.data.find(function (entry) { return entry.project.id === memo.projectId; });
      var archived = project && project.project.status === "archived";
      view().appendChild(el("a", { href: "#/memos?projectId=" + memo.projectId, text: "Back to Project Memos" }));
      view().appendChild(el("h3", { text: memo.title }));
      view().appendChild(el("p", { text: (project ? project.project.displayName : memo.projectId) + (archived ? " (archived)" : "") }));
      view().appendChild(badge(memo.state));
      var meta = el("dl", { class: "meta" });
      [["Memo ID", memo.id], ["Project ID", memo.projectId], ["Row version", memo.rowVersion], ["Created", memo.createdAt], ["Updated", memo.updatedAt], ["Created by", "User"], ["Updated by", "User"], ["Closed", memo.closedAt || "Not closed"], ["Closed by", memo.closedBy ? "User" : "Not closed"]].forEach(function (pair) { meta.appendChild(el("dt", { text: pair[0] })); meta.appendChild(el("dd", { text: String(pair[1]) })); });
      view().appendChild(meta);
      view().appendChild(el("section", { "aria-label": "Full Memo body" }, [renderMarkdownSafe(memo.body)]));
      if (archived) view().appendChild(emptyState("Archived Project: new Memos and state-changing reopens are unavailable. Existing open notes can be edited or closed."));
      if (memo.state === "open") memoEditor(view(), memo.projectId, memo);
      else view().appendChild(emptyState("Closed content is read-only. Reopen explicitly to edit."));
      var actions = el("div", { class: "actions-row" });
      (memo.state === "open" ? [["Mark done", "done"], ["Dismiss", "dismiss"]] : [["Reopen", "reopen"]]).forEach(function (action) { actions.appendChild(memoWriteButton(action[0], Boolean(action[1] === "reopen" && archived), function () { memoSubmit(action[1], memo.projectId, memo.id, memo.title, { expectedRowVersion: memo.rowVersion }); })); });
      var refresh = el("button", { type: "button", text: "Re-read current Memo (keep draft)" });
      refresh.addEventListener("click", function () { memoDetail(id); });
      actions.appendChild(refresh);
      view().appendChild(actions);
      memoRenderRecovery();
    }).catch(function () { if (pending.isConnected) pending.textContent = "Disconnected: Memo could not load. Reload or reauthenticate with sorage web."; });
  }
  memoLoadRecovery();
`;
