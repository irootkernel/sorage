/**
 * The TASK-048 Web shell served by the daemon as CSP-safe static assets: one HTML
 * document, one external script, one external stylesheet. The script implements the
 * session bootstrap of SEC-019, hash routing with URL-addressable filters that
 * survive a reload, the dashboard, the Handoff lists, the detail view with its safe
 * preview, and the settings view of TASK-045. There is no Artifact editor anywhere.
 * TASK-079 restyles the same screens over a light-and-dark token system without
 * changing any endpoint, DTO, or query parameter the shell talks to.
 */
import { WEB_MEMOS_JS } from "./web-memos";

export const WEB_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sorage</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header>
<h1>Sorage</h1>
<nav>
<a href="#/dashboard" data-nav>Dashboard</a>
<a href="#/projects" data-nav>Projects</a>
<a href="#/memos" data-nav>Memos</a>
<a href="#/compose" data-nav>Compose</a>
<a href="#/inbox" data-nav>Inbox</a>
<a href="#/outbox" data-nav>Outbox</a>
<a href="#/deletion-requests" data-nav>Deletion Requests</a>
<a href="#/backup" data-nav>Backup</a>
<a href="#/settings" data-nav>Settings</a>
<a href="#/diagnostics" data-nav>Diagnostics</a>
</nav>
<p id="session-note" role="status">This is the Sorage control plane. Run <code>sorage web</code> to open it with a one-time session secret.</p>
</header>
<aside id="memo-recovery" aria-label="Memo request recovery"></aside>
<main id="view"></main>
<script src="/assets/app.js"></script>
</body>
</html>
`;

export const WEB_CSS = `:root {
  color-scheme: light dark;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #eceef2;
  --text: #191c22;
  --text-muted: #5b626e;
  --border: #d9dde4;
  --border-strong: #b9c0cb;
  --accent: #2b62ce;
  --accent-strong: #2456b8;
  --accent-soft: #e5eefc;
  --accent-contrast: #ffffff;
  --danger: #b3373a;
  --danger-border: #e2b3b4;
  --danger-surface: #faeeee;
  --warning: #8a5b00;
  --warning-surface: #fbf3de;
  --success: #1f7a4d;
  --state-awaiting: #24549c;
  --state-awaiting-bg: #e4edfb;
  --state-changes: #7c5405;
  --state-changes-bg: #faeecd;
  --state-accepted: #197047;
  --state-accepted-bg: #ddf0e6;
  --state-declined: #a12f33;
  --state-declined-bg: #f9e3e3;
  --state-withdrawn: #5b626e;
  --state-withdrawn-bg: #e8eaee;
  --radius: 8px;
  --radius-sm: 6px;
  --shadow: 0 1px 2px rgba(20, 24, 32, 0.05), 0 4px 12px rgba(20, 24, 32, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131519;
    --surface: #1c1f26;
    --surface-2: #262a33;
    --text: #e8eaef;
    --text-muted: #9aa2af;
    --border: #303541;
    --border-strong: #454c5a;
    --accent: #6d9dff;
    --accent-strong: #8ab2ff;
    --accent-soft: #1f2b44;
    --accent-contrast: #10141d;
    --danger: #e27b7e;
    --danger-border: #5d3234;
    --danger-surface: #2e2123;
    --warning: #d9a94e;
    --warning-surface: #2b2418;
    --success: #57b98a;
    --state-awaiting: #8ab2ff;
    --state-awaiting-bg: #1e2a42;
    --state-changes: #d9b25e;
    --state-changes-bg: #322a17;
    --state-accepted: #63c092;
    --state-accepted-bg: #173024;
    --state-declined: #e58588;
    --state-declined-bg: #382122;
    --state-withdrawn: #9aa2af;
    --state-withdrawn-bg: #262a33;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); line-height: 1.5; }
a { color: var(--accent); }
a:hover { color: var(--accent-strong); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
header { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.75rem; padding: 0.7rem 1.25rem; background: var(--surface); border-bottom: 1px solid var(--border); }
header h1 { font-size: 1.05rem; margin: 0; letter-spacing: 0.01em; }
nav { display: flex; flex-wrap: wrap; gap: 0.2rem; }
nav a { padding: 0.3rem 0.7rem; border-radius: 999px; text-decoration: none; color: var(--text-muted); font-size: 0.88rem; }
nav a:hover { background: var(--surface-2); color: var(--text); }
nav a.active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
#session-note { flex-basis: 100%; margin: 0.15rem 0 0; font-size: 0.8rem; color: var(--text-muted); min-height: 1.2em; }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h2 { font-size: 1.3rem; margin: 0 0 1rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 0.6rem; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.25rem; margin-bottom: 1rem; box-shadow: var(--shadow); }
.counts { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: 0.75rem; margin: 0 0 1.5rem; }
.stat { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--stat-accent, var(--border-strong)); border-radius: var(--radius-sm); padding: 0.55rem 0.8rem; box-shadow: var(--shadow); }
.stat strong { display: block; font-size: 1.5rem; line-height: 1.25; }
.stat span { color: var(--text-muted); font-size: 0.78rem; }
.stat[data-state="awaiting_recipient"] { --stat-accent: var(--state-awaiting); }
.stat[data-state="changes_requested"] { --stat-accent: var(--state-changes); }
.stat[data-state="accepted"] { --stat-accent: var(--state-accepted); }
.stat[data-state="declined"] { --stat-accent: var(--state-declined); }
.stat[data-state="withdrawn"] { --stat-accent: var(--state-withdrawn); }
.stat[data-state="backup-ok"] { --stat-accent: var(--success); }
.stat[data-state="backup-warn"] { --stat-accent: var(--danger); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
th { text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.72rem; color: var(--text-muted); font-weight: 600; }
tbody tr:hover { background: var(--surface-2); }
.badge { display: inline-block; padding: 0.12rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; background: var(--state-withdrawn-bg); color: var(--state-withdrawn); }
.badge-awaiting { background: var(--state-awaiting-bg); color: var(--state-awaiting); }
.badge-changes { background: var(--state-changes-bg); color: var(--state-changes); }
.badge-accepted { background: var(--state-accepted-bg); color: var(--state-accepted); }
.badge-declined { background: var(--state-declined-bg); color: var(--state-declined); }
.badge-withdrawn { background: var(--state-withdrawn-bg); color: var(--state-withdrawn); }
.badge-neutral { background: var(--state-withdrawn-bg); color: var(--state-withdrawn); }
.mono { font-family: var(--font-mono); font-size: 0.85em; }
.time { font-variant-numeric: tabular-nums; color: var(--text-muted); white-space: nowrap; }
.muted { color: var(--text-muted); font-size: 0.85rem; }
.filters { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; margin: 0 0 1rem; }
.filter-error { color: var(--danger); font-size: 0.85rem; }
input, select, textarea { font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; }
input[type="checkbox"] { width: 1rem; height: 1rem; padding: 0; accent-color: var(--accent); }
input::placeholder, textarea::placeholder { color: var(--text-muted); opacity: 1; }
label { font-size: 0.85rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.4rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; margin: 0.5rem 0 0; }
dl.meta dt { color: var(--text-muted); font-size: 0.8rem; padding-top: 0.1rem; }
dl.meta dd { margin: 0; word-break: break-all; font-size: 0.9rem; }
pre.preview { border: 1px solid var(--border); background: var(--surface-2); border-radius: var(--radius-sm); padding: 0.75rem 1rem; overflow-x: auto; white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.85rem; }
button, .btn { font: inherit; font-weight: 600; font-size: 0.88rem; padding: 0.4rem 0.85rem; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; text-decoration: none; display: inline-block; }
button:hover, .btn:hover { background: var(--surface-2); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
button.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
button.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
button.danger:hover { background: var(--danger-surface); }
.empty { border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-muted); text-align: center; padding: 1.25rem; margin: 0 0 1rem; }
.loading { display: flex; align-items: center; gap: 0.5rem; color: var(--text-muted); margin: 0 0 1rem; }
.loading::before { content: ""; width: 0.9rem; height: 0.9rem; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading::before { animation: none; } }
.tombstone { background: var(--danger-surface); border: 1px solid var(--danger-border); border-left: 4px solid var(--danger); border-radius: var(--radius); padding: 1rem 1.25rem; margin: 0 0 1rem; }
.tombstone p { margin: 0.4rem 0 0; }
.warning { background: var(--warning-surface); color: var(--warning); border-left: 4px solid var(--warning); border-radius: var(--radius-sm); padding: 0.6rem 0.9rem; }
.card.note { border-left: 4px solid var(--warning); }
.card.note p { margin: 0.35rem 0 0; }
.timeline ul { list-style: none; margin: 0.5rem 0 0; padding: 0; }
.timeline li { position: relative; padding: 0 0 0.65rem 1.15rem; font-size: 0.9rem; }
.timeline li::before { content: ""; position: absolute; left: 0; top: 0.42rem; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--accent); }
.timeline li::after { content: ""; position: absolute; left: 0.23rem; top: 1.1rem; bottom: -0.1rem; width: 1px; background: var(--border); }
.timeline li:last-child::after { display: none; }
.timeline p { margin: 0.6rem 0 0; }
.action-group { padding: 0.75rem 0; border-top: 1px solid var(--border); }
.action-group:first-of-type { border-top: 0; padding-top: 0.15rem; }
.action-group h4 { margin: 0 0 0.55rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.actions-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.cell-fields { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0 0; }
.danger-zone { border: 1px solid var(--danger-border); background: var(--danger-surface); border-radius: var(--radius-sm); padding: 0.75rem 0.9rem; margin-top: 0.75rem; }
.danger-zone h4 { color: var(--danger); }
.field { margin: 0 0 0.75rem; }
#memo-recovery:empty { display: none; }
#memo-recovery { margin: 1rem auto; padding: 1rem; max-width: 1100px; border: 1px solid var(--border); border-radius: 0.6rem; overflow-wrap: anywhere; }
#memo-recovery textarea, form[aria-label$="Memo"] textarea, form[aria-label$="Memo"] input { width: 100%; max-width: 100%; box-sizing: border-box; }
form[aria-label$="Memo"] label { display: block; }
form[aria-label$="Memo"] textarea, form[aria-label$="Memo"] input { display: block; margin-top: 0.35rem; }
.memo-row { overflow-wrap: anywhere; }
`;

export const WEB_APP_JS = `(function () {
  "use strict";
  var store = { token: null };
  try { store.token = sessionStorage.getItem("sorage-session"); } catch (error) { store.token = null; }

  function api(path, init) {
    var options = Object.assign({}, init || {});
    options.headers = Object.assign({ authorization: "Bearer " + store.token }, (init || {}).headers || {});
    return fetch(path, options)
      .then(function (response) { return response.json().then(function (body) { return { status: response.status, body: body }; }); });
  }

  function el(tag, attributes, children) {
    var node = document.createElement(tag);
    Object.keys(attributes || {}).forEach(function (key) {
      if (key === "text") node.textContent = attributes[key];
      else node.setAttribute(key, attributes[key]);
    });
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function view() { return document.getElementById("view"); }

  function note(text) {
    document.getElementById("session-note").textContent = text;
  }

  var REVIEW_STATES = ["awaiting_recipient", "changes_requested", "accepted", "declined", "withdrawn"];
  var BADGE_TONES = {
    awaiting_recipient: "awaiting",
    changes_requested: "changes",
    accepted: "accepted",
    declined: "declined",
    withdrawn: "withdrawn",
    ok: "accepted",
    warning: "changes",
    blocking: "declined",
    active: "awaiting",
    archived: "withdrawn",
  };

  function badge(value) {
    var text = value === null || value === undefined ? "" : String(value);
    return el("span", { class: "badge badge-" + (BADGE_TONES[text] || "neutral"), text: text });
  }

  function pad2(value) {
    return (value < 10 ? "0" : "") + value;
  }

  // Section 21 renders mutation times in the system zone; the title keeps the
  // raw UTC instant for copy-paste.
  function timeNode(value) {
    var raw = value === null || value === undefined ? "" : String(value);
    if (raw === "") return el("span", { text: "" });
    var parsed = new Date(raw);
    var text = isNaN(parsed.getTime())
      ? raw.replace("T", " ").slice(0, 19)
      : parsed.getFullYear() + "-" + pad2(parsed.getMonth() + 1) + "-" + pad2(parsed.getDate()) + " " + pad2(parsed.getHours()) + ":" + pad2(parsed.getMinutes());
    return el("span", { class: "time", text: text, title: raw.replace("T", " ").slice(0, 19) });
  }

  function loading(text) {
    return el("p", { class: "loading", text: text });
  }

  function emptyState(text) {
    return el("div", { class: "empty", role: "status", text: text });
  }

  // -- Safe preview: text renders escaped, everything else offers download only ---
  function isPreviewable(mimeType, name) {
    if (mimeType === "image/svg+xml") return false; // SVG never renders inline (WEB-006)
    if (mimeType === "text/markdown" || mimeType === "text/plain") return true;
    if (/^text\\//.test(mimeType)) return true;
    return false;
  }

  function renderMarkdownSafe(text) {
    // Escape first, then re-enable the tiny markdown subset as elements; no raw
    // HTML from the document ever reaches the DOM (WEB-006).
    var lines = String(text).split("\\n");
    var container = el("div", {});
    var list = null;
    lines.forEach(function (line) {
      var safe = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      var heading = /^(#{1,3})\\s+(.*)$/.exec(safe);
      var bullet = /^[-*]\\s+(.*)$/.exec(safe);
      if (heading !== null) {
        list = null;
        container.appendChild(el("h" + (heading[1].length + 2), { text: heading[2] }));
      } else if (bullet !== null) {
        if (list === null) { list = el("ul", {}); container.appendChild(list); }
        list.appendChild(el("li", { text: bullet[1] }));
      } else {
        list = null;
        container.appendChild(el("p", { text: safe }));
      }
    });
    return container;
  }

  ${WEB_MEMOS_JS}

  // -- Views -------------------------------------------------------------------
  function dashboard() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Dashboard" }));
    var pending = loading("Loading the dashboard…");
    view().appendChild(pending);
    var counts = el("div", { class: "counts" });
    var states = {};
    var retention = { pinned: 0, archived: 0, deletionRequested: 0, deleted: 0 };
    api("/api/v1/handoffs?asUser=true&includeArchived=true&includeDeleted=true&limit=200").then(function (result) {
      // A late response must not paint into whatever view navigated in meanwhile.
      if (!pending.isConnected) return;
      pending.remove();
      if (result.status !== 200) { note("The dashboard could not load: " + result.body.error.code); return; }
      result.body.data.handoffs.forEach(function (handoff) {
        states[handoff.reviewState] = (states[handoff.reviewState] || 0) + 1;
        if (handoff.pinned === true) retention.pinned += 1;
        if (handoff.archivedAt !== null) retention.archived += 1;
        if (handoff.pendingDeletionRequest === true) retention.deletionRequested += 1;
        if (handoff.deletedAt !== null && handoff.deletedAt !== undefined) retention.deleted += 1;
      });
      // WEB-002: every review state and retention class shows as a fixed card,
      // including at a zero count, so the dashboard is a census rather than a
      // list of whatever happens to be non-empty.
      REVIEW_STATES.forEach(function (state) {
        counts.appendChild(el("div", { class: "stat", "data-state": state }, [el("strong", { text: String(states[state] || 0) }), el("span", { text: state })]));
      });
      counts.appendChild(el("div", { class: "stat" }, [el("strong", { text: String(retention.pinned) }), el("span", { text: "pinned" })]));
      counts.appendChild(el("div", { class: "stat" }, [el("strong", { text: String(retention.archived) }), el("span", { text: "archived" })]));
      counts.appendChild(el("div", { class: "stat" }, [el("strong", { text: String(retention.deletionRequested) }), el("span", { text: "deletion requested" })]));
      counts.appendChild(el("div", { class: "stat" }, [el("strong", { text: String(retention.deleted) }), el("span", { text: "deleted" })]));
      // WEB-002: Backup Health, shown once Git backup exists, populated from
      // the same backup_runs data the backup page lists.
      var health = el("div", { class: "stat backup-health", "data-state": "backup-ok" });
      counts.appendChild(health);
      api("/api/v1/backup/status").then(function (statusResult) {
        if (statusResult.status !== 200) {
          health.setAttribute("data-state", "backup-warn");
          health.appendChild(el("strong", { text: "Backup: unknown" }));
          health.appendChild(el("span", { text: "the status endpoint is unavailable" }));
          return;
        }
        var status = statusResult.body.data;
        var protection = status.schedule.enabled
          ? (status.lastPush !== null ? "scheduled, remote push" : "scheduled, local commits")
          : (status.lastPush !== null ? "manual, remote push" : "local commits only");
        var healthy = status.lastFailure === null && (status.lastSuccess !== null || status.lastAttempt === null);
        health.setAttribute("data-state", healthy ? "backup-ok" : "backup-warn");
        health.appendChild(el("strong", { text: healthy ? "Backup: healthy" : "Backup: needs attention" }));
        health.appendChild(el("span", { text: protection + (status.lastAttempt !== null ? ", last run " + status.lastAttempt.outcome : ", never run") }));
      });
      view().appendChild(counts);
      view().appendChild(el("h3", { text: "Recent updates" }));
      if (result.body.data.handoffs.length === 0) {
        view().appendChild(emptyState("No Handoffs yet; compose one from the Compose tab."));
        return;
      }
      var recent = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Updated" }), el("th", { text: "Title" }), el("th", { text: "State" })])])]);
      var body = el("tbody", {});
      result.body.data.handoffs.slice(0, 10).forEach(function (handoff) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [timeNode(handoff.updatedAt || handoff.createdAt || "")]),
          el("td", {}, [el("a", { href: "#/handoff/" + handoff.id, text: handoff.title })]),
          el("td", {}, [badge(handoff.reviewState)]),
        ]));
      });
      recent.appendChild(body);
      view().appendChild(recent);
    });
  }

  function listing(kind) {
    var query = location.hash.split("?")[1] || "";
    var params = new URLSearchParams(query);
    var url = "/api/v1/handoffs?box=" + kind + (store.as ? "&as=" + encodeURIComponent(store.as) : "&asUser=true");
    ["state", "sender", "recipient", "updatedSince", "updatedUntil", "includeArchived", "includeDeleted"].forEach(function (key) {
      if (params.has(key)) url += "&" + key + "=" + params.get(key);
    });
    view().replaceChildren();
    view().appendChild(el("h2", { text: kind === "inbox" ? "Inbox" : "Outbox" }));
    // WEB-003: the same filter set the CLI offers, URL-addressable so a reload
    // or a shared link reproduces the same listing.
    var filters = el("div", { class: "filters" });
    var stateInput = el("select", { "aria-label": "State filter" }, [el("option", { value: "", text: "any state" })]
      .concat(REVIEW_STATES.map(function (state) { return el("option", { value: state, text: state }); })));
    var stateParam = params.get("state") || "";
    stateInput.value = stateParam;
    // A URL value outside the five review states still filters the listing, so
    // it needs a visible option instead of a blank select (WEB-003).
    if (stateParam !== "" && stateInput.value !== stateParam) {
      stateInput.appendChild(el("option", { value: stateParam, text: stateParam }));
      stateInput.value = stateParam;
    }
    var senderInput = el("input", { placeholder: "sender slug", "aria-label": "Sender slug" });
    senderInput.value = params.get("sender") || "";
    var recipientInput = el("input", { placeholder: "recipient slug", "aria-label": "Recipient slug" });
    recipientInput.value = params.get("recipient") || "";
    var sinceInput = el("input", { placeholder: "updated since (ISO-8601)", "aria-label": "Updated since" });
    sinceInput.value = params.get("updatedSince") || "";
    var untilInput = el("input", { placeholder: "updated until (ISO-8601)", "aria-label": "Updated until" });
    untilInput.value = params.get("updatedUntil") || "";
    var archived = el("input", { type: "checkbox" });
    archived.checked = params.get("includeArchived") === "true";
    var deleted = el("input", { type: "checkbox" });
    deleted.checked = params.get("includeDeleted") === "true";
    var invalid = el("span", { class: "filter-error", role: "alert", text: "" });
    var apply = el("button", { class: "primary", text: "Apply" });
    apply.addEventListener("click", function () {
      var sinceBound = sinceInput.value.trim();
      var untilBound = untilInput.value.trim();
      var isoLike = /^\\d{4}-\\d{2}-\\d{2}([T ].*)?$/;
      if ((sinceBound !== "" && !isoLike.test(sinceBound)) || (untilBound !== "" && !isoLike.test(untilBound))) {
        invalid.textContent = "Date bounds need ISO-8601 form, for example 2026-08-01T00:00:00Z.";
        return;
      }
      invalid.textContent = "";
      var next = new URLSearchParams();
      if (stateInput.value !== "") next.set("state", stateInput.value);
      if (senderInput.value !== "") next.set("sender", senderInput.value);
      if (recipientInput.value !== "") next.set("recipient", recipientInput.value);
      if (sinceBound !== "") next.set("updatedSince", sinceBound);
      if (untilBound !== "") next.set("updatedUntil", untilBound);
      if (archived.checked) next.set("includeArchived", "true");
      if (deleted.checked) next.set("includeDeleted", "true");
      location.hash = "#/" + kind + (next.toString() !== "" ? "?" + next.toString() : "");
    });
    filters.appendChild(stateInput);
    filters.appendChild(senderInput);
    filters.appendChild(recipientInput);
    filters.appendChild(sinceInput);
    filters.appendChild(untilInput);
    filters.appendChild(el("label", { text: "Include archived " }, [archived]));
    filters.appendChild(el("label", { text: "Include deleted " }, [deleted]));
    filters.appendChild(apply);
    filters.appendChild(invalid);
    view().appendChild(filters);
    var pending = loading("Loading the " + (kind === "inbox" ? "inbox" : "outbox") + "…");
    view().appendChild(pending);
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Handoff" }), el("th", { text: "State" }), el("th", { text: "Revision" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    api(url).then(function (result) {
      if (!pending.isConnected) return;
      pending.remove();
      if (result.status !== 200) { note("The listing could not load: " + result.body.error.code); return; }
      if (result.body.data.handoffs.length === 0) {
        view().appendChild(emptyState("No Handoffs match the current filters."));
        return;
      }
      result.body.data.handoffs.forEach(function (handoff) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [el("a", { href: "#/handoff/" + handoff.id, text: handoff.title })]),
          el("td", {}, [badge(handoff.reviewState)]),
          el("td", {}, [el("span", { class: "mono", text: String(handoff.revision) })]),
        ]));
      });
      view().appendChild(table);
    });
  }

  function deletionRequests() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Deletion Requests" }));
    var pending = loading("Loading the deletion requests…");
    view().appendChild(pending);
    view().appendChild(el("p", { class: "muted", text: "Approve or reject a request from the Handoff detail view; approval of a pinned Handoff asks for the distinct confirmation there." }));
    api("/api/v1/handoffs?asUser=true&includeArchived=true&includeDeleted=true&limit=200").then(function (result) {
      if (!pending.isConnected) return;
      pending.remove();
      if (result.status !== 200) { note("The deletion requests could not load: " + result.body.error.code); return; }
      var requested = result.body.data.handoffs.filter(function (handoff) { return handoff.pendingDeletionRequest === true; });
      if (requested.length === 0) {
        view().appendChild(emptyState("No pending deletion requests."));
        return;
      }
      var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Handoff" }), el("th", { text: "State" }), el("th", { text: "Pinned" })])])]);
      var body = el("tbody", {});
      table.appendChild(body);
      requested.forEach(function (handoff) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [el("a", { href: "#/handoff/" + handoff.id, text: handoff.title })]),
          el("td", {}, [badge(handoff.reviewState)]),
          el("td", { text: handoff.pinned === true ? "pinned" : "" }),
        ]));
      });
      view().appendChild(table);
    });
  }

  function detail(id) {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Handoff" }));
    var pending = loading("Loading the Handoff…");
    view().appendChild(pending);
    api("/api/v1/handoffs/" + id + "?asUser=true").then(function (result) {
      if (!pending.isConnected) return;
      pending.remove();
      if (result.status !== 200) { view().appendChild(el("p", { text: "Not found: " + result.body.error.code })); return; }
      var handoff = result.body.data;
      var metaCard = el("div", { class: "card" });
      metaCard.appendChild(el("h3", { text: handoff.title === null || handoff.title === undefined ? "Handoff" : handoff.title }));
      var meta = el("dl", { class: "meta" });
      function row(term, value) {
        var cell = typeof value === "string" ? el("dd", { text: value }) : el("dd", {}, [value]);
        meta.appendChild(el("dt", { text: term }));
        meta.appendChild(cell);
      }
      row("id", el("span", { class: "mono", text: handoff.id }));
      row("sender", handoff.senderDisplayName || handoff.senderKind || "");
      row("recipient", handoff.recipientProjectSlug || handoff.recipientProjectId || "");
      row("review state", badge(handoff.reviewState));
      row("revision", el("span", { class: "mono", text: String(handoff.revision) }));
      row("row version", el("span", { class: "mono", text: String(handoff.rowVersion) }));
      row("next actor", nextActorText(handoff));
      row("first fetched", handoff.firstFetchedAt === null || handoff.firstFetchedAt === undefined ? "never fetched (the sender may still withdraw)" : handoff.firstFetchedAt);
      row("created", handoff.createdAt || "");
      metaCard.appendChild(meta);
      view().appendChild(metaCard);
      renderTimeline(id);
      if (handoff.deletedAt !== null && handoff.deletedAt !== undefined) {
        var tomb = el("div", { class: "tombstone" });
        tomb.appendChild(el("strong", { text: "Deleted " + handoff.deletedAt }));
        tomb.appendChild(el("p", { text: "This Handoff is a tombstone. Prior Git commits may retain earlier content." }));
        view().appendChild(tomb);
        return;
      }
      if (handoff.currentArtifact !== null && handoff.currentArtifact !== undefined) {
        var artifact = handoff.currentArtifact;
        var card = el("div", { class: "card" });
        card.appendChild(el("h3", { text: "Artifact" }));
        var am = el("dl", { class: "meta" });
        // storageKey ships instead of the artifact DTO's absent revision; the
        // Handoff revision already shows in the metadata card above (WEB-004).
        ["originalName", "mimeType", "sizeBytes", "sha256", "storageKey"].forEach(function (key) {
          am.appendChild(el("dt", { text: key }));
          var value = String(artifact[key] === null || artifact[key] === undefined ? "" : artifact[key]);
          am.appendChild(key === "sha256" || key === "storageKey" ? el("dd", {}, [el("span", { class: "mono", text: value })]) : el("dd", { text: value }));
        });
        card.appendChild(am);
        var revealStatus = el("span", { class: "muted", text: "" });
        var reveal = el("button", { text: "Reveal in Finder" });
        reveal.addEventListener("click", function () {
          api("/api/v1/handoffs/" + id + "/artifact/reveal?asUser=true", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(function (outcome) {
            revealStatus.textContent = outcome.body.ok ? " " + outcome.body.data.localPath : " " + outcome.body.error.code;
          });
        });
        var actions = el("div", { class: "actions-row" });
        var downloadStatus = el("span", { class: "muted", text: "" });
        var download = el("button", { text: "Download" });
        download.addEventListener("click", function () {
          download.disabled = true;
          downloadStatus.textContent = "";
          fetch("/api/v1/handoffs/" + id + "/artifact/content?asUser=true", { headers: { authorization: "Bearer " + store.token } })
            .then(function (response) {
              if (!response.ok) {
                downloadStatus.textContent = "Download failed (HTTP " + response.status + ").";
                return null;
              }
              return response.blob();
            })
            .then(function (blob) {
              if (blob === null) return;
              var url = URL.createObjectURL(blob);
              var link = el("a", { href: url, download: artifact.originalName || "artifact" });
              document.body.appendChild(link);
              link.click();
              link.remove();
              setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
            })
            .catch(function () { downloadStatus.textContent = "Download failed. Try again."; })
            .finally(function () { download.disabled = false; });
        });
        actions.appendChild(download);
        actions.appendChild(downloadStatus);
        actions.appendChild(reveal);
        actions.appendChild(revealStatus);
        card.appendChild(actions);
        view().appendChild(card);
        if (isPreviewable(artifact.mimeType || "", artifact.originalName || "")) {
          fetch("/api/v1/handoffs/" + id + "/artifact/content?asUser=true", { headers: { authorization: "Bearer " + store.token } })
            .then(function (response) { return response.text(); })
            .then(function (text) {
              var preview = el("div", { class: "card" });
              preview.appendChild(el("h3", { text: "Preview" }));
              preview.appendChild(renderMarkdownSafe(text));
              view().appendChild(preview);
            });
        } else {
          var notice = el("div", { class: "card" });
          notice.appendChild(el("p", { text: artifact.mimeType === "image/svg+xml" ? "This Artifact is SVG and is never rendered inline; use the download." : "This Artifact type is not previewable; use the download." }));
          view().appendChild(notice);
        }
      }
      renderReviewNote(id);
      view().appendChild(actionsCard(handoff));
      view().appendChild(reviseCard(id));
    });
  }

  function nextActorText(handoff) {
    var actors = handoff.nextActors;
    if (actors === null || actors === undefined) return "none";
    return actors.reviewNextActor || actors.administrativeNextActor || "none";
  }

  function renderReviewNote(id) {
    api("/api/v1/handoffs/" + id + "/review-note?asUser=true").then(function (result) {
      if (result.status !== 200 || result.body.data === null || result.body.data === undefined) return;
      var noteView = result.body.data;
      var noteCard = el("div", { class: "card note" });
      noteCard.appendChild(el("h3", { text: "Review note" }));
      noteCard.appendChild(el("p", { text: noteView.body || "" }));
      noteCard.appendChild(el("p", { class: "muted", text: "target revision " + noteView.targetRevision + " — author " + noteView.authorKind }));
      view().appendChild(noteCard);
    });
  }

  function renderTimeline(id) {
    api("/api/v1/handoffs/" + id + "/events?asUser=true").then(function (result) {
      var timelineCard = el("div", { class: "card timeline" });
      timelineCard.appendChild(el("h3", { text: "Timeline" }));
      var events = result.status === 200 && result.body.data ? result.body.data : [];
      if (events.length === 0) {
        timelineCard.appendChild(el("p", { class: "muted", text: "No events recorded." }));
      } else {
        var list = el("ul", {});
        events.forEach(function (entry) {
          var item = el("li", {});
          item.appendChild(timeNode(entry.createdAt));
          item.appendChild(el("strong", { text: " " + entry.eventType + " " }));
          item.appendChild(el("span", { class: "muted", text: "(" + (entry.actorKind || "") + ")" }));
          list.appendChild(item);
        });
        timelineCard.appendChild(list);
      }
      timelineCard.appendChild(el("p", { class: "muted", text: "Metadata events only; the timeline never implies historical Artifact content is retrievable." }));
      view().appendChild(timelineCard);
    });
  }

  function reviseCard(id) {
    var card = el("div", { class: "card" });
    card.appendChild(el("h3", { text: "Revise" }));
    var status = el("p", { class: "muted", text: "" });
    var file = el("input", { type: "file", "aria-label": "Replacement document" });
    var submit = el("button", { type: "submit", text: "Revise through upload" });
    submit.addEventListener("click", function () {
      if (!file.files || file.files.length === 0) { status.textContent = "Choose a replacement file first."; return; }
      var form = new FormData();
      form.append("file", file.files[0]);
      api("/api/v1/handoffs/" + id + "/revise?asUser=true", { method: "POST", body: form }).then(function (outcome) {
        status.textContent = outcome.body.ok ? "Revised to revision " + outcome.body.data.revision : outcome.body.error.code;
        if (outcome.body.ok) detail(id);
      });
    });
    var row = el("div", { class: "actions-row" });
    row.appendChild(file);
    row.appendChild(submit);
    card.appendChild(row);
    card.appendChild(status);
    return card;
  }

  var projectsRender = 0;
  function projects() {
    var ticket = ++projectsRender;
    var stale = function (payload) { projectsRender !== ticket ? null : payload(); };
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Projects" }));
    var status = el("p", { class: "muted", text: "" });
    var pending = loading("Loading the projects…");
    view().appendChild(pending);
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Slug" }), el("th", { text: "Name" }), el("th", { text: "Bindings" }), el("th", { text: "State" }), el("th", { text: "Actions" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    view().appendChild(status);
    view().appendChild(el("h3", { text: "Register a Project" }));
    var form = el("form", {});
    var name = el("input", { placeholder: "display name", size: "30" });
    var dir = el("input", { placeholder: "directory", size: "40" });
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Name " }, [name])]));
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Directory " }, [dir])]));
    form.appendChild(el("button", { class: "primary", type: "submit", text: "Register" }));
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      api("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.value, dir: dir.value, asUser: true }) })
        .then(function (outcome) { status.textContent = outcome.body.ok ? "Registered " + outcome.body.data.project.slug : outcome.body.error.code; projects(); });
    });
    view().appendChild(form);
    api("/api/v1/projects").then(function (result) {
      stale(function () {
        if (!pending.isConnected) return;
        pending.remove();
        if (result.status !== 200) { status.textContent = "Projects could not load."; return; }
        if (result.body.data.length === 0) {
          view().insertBefore(emptyState("No Projects registered yet; register one below."), status);
          return;
        }
        result.body.data.forEach(function (entry) {
          var project = entry.project;
          var row = el("tr", {}, [
            el("td", {}, [el("span", { class: "mono", text: project.slug })]),
            el("td", { text: project.displayName }),
            el("td", { text: String(entry.bindingCount) + (entry.unbound ? " (unbound)" : "") }),
            el("td", {}, [badge(project.status)]),
          ]);
          var cell = el("td", {});
          var rename = el("input", { placeholder: "new name", size: "18", "aria-label": "New name for " + project.slug });
          var bindDir = el("input", { placeholder: "bind directory", size: "24", "aria-label": "Binding directory for " + project.slug });
          function action(label, path, init) {
            var button = el("button", { text: label });
            button.addEventListener("click", function () {
              // Path and body are built at click time so the row's inputs are read
              // live rather than captured empty at render.
              api(typeof path === "function" ? path() : path, typeof init === "function" ? init() : init).then(function (outcome) {
                status.textContent = outcome.body.ok ? label + " done" : outcome.body.error.code;
                projects();
              });
            });
            return button;
          }
          var renameButton = el("button", { text: "Rename" });
          renameButton.addEventListener("click", function () {
            if (rename.value === "") return;
            api("/api/v1/projects/" + project.slug, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: rename.value, asUser: true }) })
              .then(function () { projects(); });
          });
          var rowActions = el("div", { class: "actions-row" });
          rowActions.appendChild(el("a", { href: "#/memos?projectId=" + project.id, text: "Memos" }));
          rowActions.appendChild(renameButton);
          rowActions.appendChild(action("Bind", "/api/v1/projects/" + project.slug + "/bindings", function () {
            return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: bindDir.value, asUser: true }) };
          }));
          rowActions.appendChild(action("Unbind", function () {
            return "/api/v1/projects/" + project.slug + "/bindings/x?dir=" + encodeURIComponent(bindDir.value) + "&confirm=true";
          }, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ asUser: true }) }));
          rowActions.appendChild(action("Archive", "/api/v1/projects/" + project.slug + "/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asUser: true }) }));
          rowActions.appendChild(action("Unarchive", "/api/v1/projects/" + project.slug + "/unarchive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asUser: true }) }));
          cell.appendChild(rowActions);
          cell.appendChild(el("p", { class: "cell-fields" }, [rename, bindDir]));
          row.appendChild(cell);
          body.appendChild(row);
        });
        view().insertBefore(table, status);
      });
    });

    // Unregistered Workspaces: senders with no Project, listed separately and never
    // offered as recipients.
    view().appendChild(el("h3", { text: "Unregistered Workspaces" }));
    var unregistered = el("ul", { class: "muted" });
    view().appendChild(unregistered);
    api("/api/v1/handoffs?asUser=true&includeArchived=true").then(function (result) {
      if (result.status !== 200) return;
      stale(function () {
      var seen = {};
      result.body.data.handoffs.forEach(function (handoff) {
        if (handoff.senderKind !== "unregistered_workspace") return;
        var key = handoff.senderWorkspaceKey || handoff.senderPathSnapshot || "unknown";
        if (seen[key] !== undefined) { seen[key] += 1; return; }
        seen[key] = 1;
      });
      Object.keys(seen).forEach(function (key) {
        unregistered.appendChild(el("li", { text: key + " — " + seen[key] + " sent Handoff(s); not a recipient" }));
      });
      if (Object.keys(seen).length === 0) unregistered.appendChild(el("li", { text: "None recorded." }));
      });
    });
  }

  function compose() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "New Handoff" }));
    var form = el("form", {});
    var title = el("input", { placeholder: "title", size: "40" });
    var recipients = el("input", { placeholder: "recipient slugs, comma-separated", size: "40" });
    var file = el("input", { type: "file" });
    var body = el("textarea", { rows: "8", cols: "40", placeholder: "Markdown body", "aria-label": "Body" });
    var result = el("p", {});
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Title " }, [title])]));
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "To " }, [recipients])]));
    form.appendChild(el("p", { class: "muted", text: "Several recipients create one independent Handoff each; every identifier and the shared dispatch group appear after submission." }));
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Document " }, [file])]));
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Body " }, [body])]));
    form.appendChild(el("p", { class: "muted", text: "Supply a file or a Markdown body, not both. The sender is the User." }));
    form.appendChild(el("button", { class: "primary", type: "submit", text: "Send" }));
    form.appendChild(result);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var hasFile = file.files.length > 0;
      var hasBody = body.value.trim() !== "";
      if (hasFile && hasBody) { result.textContent = "Choose a file or a Markdown body, not both."; return; }
      if (!hasFile && !hasBody) { result.textContent = "Choose a document or enter a Markdown body."; return; }
      var data = new FormData();
      data.append("title", title.value);
      recipients.value.split(",").map(function (slug) { return slug.trim(); }).filter(function (slug) { return slug !== ""; }).forEach(function (slug) { data.append("to", slug); });
      if (hasFile) data.append("file", file.files[0]);
      else data.append("body", body.value);
      fetch("/api/v1/handoffs/upload", { method: "POST", headers: { authorization: "Bearer " + store.token }, body: data })
        .then(function (response) { return response.json(); })
        .then(function (outcome) {
          if (!outcome.ok) { result.textContent = "Send failed: " + outcome.error.code; return; }
          result.textContent = "";
          var list = el("ul", {});
          outcome.data.handoffs.forEach(function (sent) { list.appendChild(el("li", {}, [el("span", { class: "mono", text: sent.handoffId }), el("span", { text: " → " + sent.recipientSlug + " (group " + (outcome.data.dispatchGroupId || "none") + ")" })])); });
          result.appendChild(list);
        });
    });
    view().appendChild(form);
  }

  function actionsCard(handoff) {
    var card = el("div", { class: "card" });
    card.appendChild(el("h3", { text: "Actions" }));
    var status = el("p", { class: "muted", text: "" });
    function act(label, path, body, method, tone) {
      var button = el("button", tone === undefined ? { text: label } : { class: tone, text: label });
      button.addEventListener("click", function () {
        status.textContent = "";
        var payload = typeof body === "function" ? body() : body || { asUser: true };
        api(path, { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
          .then(function (outcome) {
            if (!outcome.body.ok) {
              status.textContent = outcome.body.error.code + ": " + outcome.body.error.message;
              if (outcome.body.error.code === "ROW_VERSION_CONFLICT") detail(handoff.id);
              return;
            }
            detail(handoff.id);
          });
      });
      return button;
    }
    var noteGroup = el("div", { class: "action-group" });
    noteGroup.appendChild(el("h4", { text: "Review note" }));
    var note = el("textarea", { rows: "2", cols: "40", placeholder: "User proxy review note", "aria-label": "Review note" });
    var noteRow = el("div", { class: "actions-row" });
    noteRow.appendChild(note);
    noteRow.appendChild(act("Set note", "/api/v1/handoffs/" + handoff.id + "/review-note?asUser=true", function () { return { text: note.value, asUser: true }; }, "PUT"));
    noteRow.appendChild(act("Remove note", "/api/v1/handoffs/" + handoff.id + "/review-note?asUser=true&confirm=true", { asUser: true }, "DELETE", "danger"));
    noteGroup.appendChild(noteRow);
    card.appendChild(noteGroup);

    var decisionGroup = el("div", { class: "action-group" });
    decisionGroup.appendChild(el("h4", { text: "Review decision" }));
    var decisionRow = el("div", { class: "actions-row" });
    decisionRow.appendChild(act("Accept", "/api/v1/handoffs/" + handoff.id + "/accept?asUser=true", { expectedRevision: handoff.revision, expectedRowVersion: handoff.rowVersion, asUser: true }, "POST", "primary"));
    decisionRow.appendChild(act("Decline", "/api/v1/handoffs/" + handoff.id + "/decline?asUser=true", { reason: "Declined from the Web UI", expectedRowVersion: handoff.rowVersion, asUser: true }, "POST", "danger"));
    decisionGroup.appendChild(decisionRow);
    card.appendChild(decisionGroup);

    var organizationGroup = el("div", { class: "action-group" });
    organizationGroup.appendChild(el("h4", { text: "Organization" }));
    var organizationRow = el("div", { class: "actions-row" });
    organizationRow.appendChild(act(handoff.pinned === true ? "Unpin" : "Pin", "/api/v1/handoffs/" + handoff.id + "/" + (handoff.pinned === true ? "unpin" : "pin") + "?asUser=true", { asUser: true }));
    organizationRow.appendChild(act(handoff.archivedAt !== null && handoff.archivedAt !== undefined ? "Unarchive" : "Archive", "/api/v1/handoffs/" + handoff.id + "/" + (handoff.archivedAt !== null && handoff.archivedAt !== undefined ? "unarchive" : "archive") + "?asUser=true", { asUser: true }));
    organizationGroup.appendChild(organizationRow);
    card.appendChild(organizationGroup);

    var deletionGroup = el("div", { class: "action-group danger-zone" });
    deletionGroup.appendChild(el("h4", { text: "Deletion" }));
    var deletionRow = el("div", { class: "actions-row" });
    deletionRow.appendChild(act("Request deletion", "/api/v1/handoffs/" + handoff.id + "/deletion-request?asUser=true", { asUser: true }, "POST", "danger"));
    deletionRow.appendChild(act("Reject deletion", "/api/v1/handoffs/" + handoff.id + "/deletion-reject?asUser=true", { asUser: true }));
    var pinnedConfirm = el("input", { placeholder: "type the Handoff id to confirm pinned deletion", size: "36", "aria-label": "Pinned deletion confirmation" });
    deletionRow.appendChild(pinnedConfirm);
    deletionRow.appendChild(act("Approve deletion", "/api/v1/handoffs/" + handoff.id + "/deletion-approve?asUser=true&confirm=true", function () { return { asUser: true, confirmPinned: pinnedConfirm.value }; }, "POST", "danger"));
    deletionGroup.appendChild(deletionRow);
    deletionGroup.appendChild(el("p", { class: "muted", text: "Approving a pinned Handoff needs the distinct confirmation above; the empty form fails with PINNED_DELETE_CONFIRMATION." }));
    card.appendChild(deletionGroup);
    card.appendChild(status);
    return card;
  }

  function diagnostics() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Diagnostics" }));
    var pending = loading("Loading the diagnostics…");
    view().appendChild(pending);
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Check" }), el("th", { text: "Severity" }), el("th", { text: "Message" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    api("/api/v1/diagnostics").then(function (result) {
      if (!pending.isConnected) return;
      pending.remove();
      if (result.status !== 200) { note("Diagnostics could not load."); return; }
      if (result.body.data.checks.length === 0) {
        view().appendChild(emptyState("No diagnostics recorded."));
        return;
      }
      result.body.data.checks.forEach(function (check) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [el("span", { class: "mono", text: check.id })]),
          el("td", {}, [badge(check.severity)]),
          el("td", { text: check.message }),
        ]));
      });
      view().appendChild(table);
    });
  }

  function settings() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Settings" }));
    var path = el("p", { class: "muted", text: "" });
    var yaml = el("pre", { class: "preview", text: "Loading…" });
    var form = el("form", {});
    var pageSize = el("input", { type: "number", min: "1" });
    var marker = el("select", {}, [el("option", { value: "false", text: "off" }), el("option", { value: "true", text: "on" })]);
    form.appendChild(el("p", { class: "field" }, [el("label", { text: "Default page size " }, [pageSize])]));
    form.appendChild(el("p", { class: "field" }, [el("label", { text: " Inbox marker " }, [marker])]));
    var saveNote = el("p", { class: "muted", text: "" });
    form.appendChild(el("button", { class: "primary", type: "submit", text: "Save" }));
    form.appendChild(saveNote);
    // The form saves against the ETag it was loaded with: a save after an
    // out-of-band write conflicts instead of silently overwriting (CFG-019).
    var loadedEtag = null;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (loadedEtag === null) { saveNote.textContent = "The configuration has not loaded."; return; }
      api("/api/v1/config", {
        method: "PUT",
        headers: { "if-match": loadedEtag, "content-type": "application/json" },
        body: JSON.stringify({ key: "ui.defaultPageSize", value: pageSize.value }),
      }).then(function (saved) {
        if (!saved.body.ok) {
          saveNote.textContent = "Save failed: " + saved.body.error.code;
          return;
        }
        loadedEtag = saved.body.data.etag;
        // The inbox-marker toggle saves under the same loaded basis; its failure
        // is reported without undoing the page-size save.
        api("/api/v1/config", {
          method: "PUT",
          headers: { "if-match": loadedEtag, "content-type": "application/json" },
          body: JSON.stringify({ key: "handoff.inboxMarker", value: marker.value }),
        }).then(function (second) {
          if (second.body.ok) {
            loadedEtag = second.body.data.etag;
            saveNote.textContent = "Saved.";
          } else {
            saveNote.textContent = "Saved the page size; the marker save failed: " + second.body.error.code;
          }
        });
      });
    });
    view().appendChild(form);
    var yamlCard = el("div", { class: "card" });
    yamlCard.appendChild(el("h3", { text: "Canonical configuration (read-only)" }));
    yamlCard.appendChild(path);
    yamlCard.appendChild(yaml);
    view().appendChild(yamlCard);
    api("/api/v1/config").then(function (result) {
      if (result.status !== 200) { yaml.textContent = "Configuration could not load."; return; }
      path.textContent = result.body.data.configFile;
      yaml.textContent = result.body.data.yaml;
      pageSize.value = result.body.data.config.ui.defaultPageSize;
      marker.value = String(result.body.data.config.handoff.inboxMarker);
      loadedEtag = result.body.data.etag;
    });
  }

  // WEB-002, BKP-018, BKP-019: the backup page states plainly whether
  // protection is local-only or includes a remote, lists recent runs from
  // backup_runs with their snapshot, commit, and push outcomes separated, and
  // explains that restore is a CLI bootstrap operation rather than offering a
  // destructive button.
  function backupPage() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Backup" }));
    var pending = loading("Loading the backup status…");
    view().appendChild(pending);
    api("/api/v1/backup/status").then(function (result) {
      if (!pending.isConnected) return;
      pending.remove();
      if (result.status !== 200) { note("The backup status could not load: " + result.body.error.code); return; }
      var status = result.body.data;
      var remote = status.lastPush !== null;
      var protection = el("p", {}, [
        el("strong", { text: remote ? "Protection includes a remote." : "Protection is local-only." }),
        el("span", {
          text: remote
            ? " Commits are pushed to the configured remote after every run."
            : " Commits stay in this machine's Vault repository; enable a remote with sorage backup enable-push.",
        }),
      ]);
      view().appendChild(protection);
      if (status.schedule.enabled) {
        view().appendChild(el("p", { text: "The daily schedule runs at " + status.schedule.at + " in " + status.schedule.timezone + (status.nextDueAt !== null ? "; next due " + status.nextDueAt.replace("T", " ").slice(0, 19) : "") + "." }));
      } else {
        view().appendChild(el("p", { text: "The daily schedule is disabled; enable it with sorage backup enable --daily-at <HH:MM>." }));
      }
      if (status.lastFailure !== null) {
        view().appendChild(el("p", { class: "warning", text: "The last backup run failed with " + String(status.lastFailure.failureCode) + " at " + String(status.lastFailure.startedAt).replace("T", " ").slice(0, 19) + "." }));
      }
      var table = el("table", {}, [el("thead", {}, [el("tr", {}, [
        el("th", { text: "Started" }),
        el("th", { text: "Trigger" }),
        el("th", { text: "Outcome" }),
        el("th", { text: "Snapshot" }),
        el("th", { text: "Commit" }),
        el("th", { text: "Push" }),
      ])])]);
      var body = el("tbody", {});
      // The runs themselves come from the history the status exposes; the
      // endpoint returns the five last-* projections, so the page lists the
      // recorded outcomes it names and points at status for the full history.
      var runs = [];
      ["lastAttempt", "lastSuccess", "lastCommit", "lastPush", "lastFailure"].forEach(function (key) {
        var row = status[key];
        if (row !== null && runs.indexOf(row) === -1) runs.push(row);
      });
      runs.forEach(function (run) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [timeNode(run.startedAt)]),
          el("td", { text: String(run.triggeredBy) }),
          el("td", { text: String(run.outcome) }),
          el("td", { text: String(run.snapshotOutcome) }),
          el("td", { text: run.commitSha !== null ? String(run.commitOutcome) + " (" + String(run.commitSha).slice(0, 8) + ")" : String(run.commitOutcome) }),
          el("td", { text: String(run.pushOutcome) }),
        ]));
      });
      table.appendChild(body);
      view().appendChild(el("h3", { text: "Recent runs" }));
      view().appendChild(table);
      view().appendChild(el("p", { class: "muted", text: "Restore is a bootstrap command: stop the daemon and run sorage backup restore --from <vault-path> --dry-run --as-user first." }));
      view().appendChild(el("p", { class: "muted", text: "Deleting a Handoff removes its current file only; prior Git commits may retain earlier content, and Sorage offers no history purge." }));
    });
  }

  function route() {
    memoRenderTicket += 1;
    memoVisible = null;
    memoRenderRecovery();
    if (store.token === null) {
      view().replaceChildren(el("p", { text: "Run sorage web to open this page with a one-time session secret." }));
      return;
    }
    note("");
    var hash = location.hash.replace(/^#/, "") || "/dashboard";
    var path = hash.split("?")[0];
    if (path === "/" || path === "/dashboard") dashboard();
    else if (path === "/projects") projects();
    else if (path === "/memos") memoList();
    else if (path.indexOf("/memo/") === 0) memoDetail(path.slice("/memo/".length));
    else if (path === "/compose") compose();
    else if (path === "/inbox") listing("inbox");
    else if (path === "/outbox") listing("outbox");
    else if (path === "/deletion-requests") deletionRequests();
    else if (path.indexOf("/handoff/") === 0) detail(path.slice("/handoff/".length));
    else if (path === "/diagnostics") diagnostics();
    else if (path === "/backup") backupPage();
    else if (path === "/settings") settings();
    else dashboard();
    document.querySelectorAll("[data-nav]").forEach(function (link) {
      var active = link.getAttribute("href") === "#" + path;
      link.className = active ? "active" : "";
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function enterSessionOrRoute() {
    var fragment = location.hash.match(/[#&]s=([^&]+)/);
    if (fragment === null) { route(); return; }
    // A fresh fragment can reauthenticate this same tab after a daemon restart
    // without throwing away its Memo recovery record or unsaved drafts.
    history.replaceState(null, "", location.pathname);
    fetch("/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: fragment[1] }) })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        if (body !== null) {
          store.token = body.data.token;
          try { sessionStorage.setItem("sorage-session", store.token); } catch (error) { /* optional */ }
        }
        route();
      }).catch(function () { note("Disconnected: session exchange failed. Run sorage web again."); });
  }
  enterSessionOrRoute();
  window.addEventListener("hashchange", enterSessionOrRoute);
})();
`;
