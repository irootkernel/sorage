/**
 * The TASK-048 Web shell served by the daemon as CSP-safe static assets: one HTML
 * document, one external script, one external stylesheet. The script implements the
 * session bootstrap of SEC-019, hash routing with URL-addressable filters that
 * survive a reload, the dashboard, the Handoff lists, the detail view with its safe
 * preview, and the settings view of TASK-045. There is no Artifact editor anywhere.
 */
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
<p id="session-note">This is the Sorage control plane. Run <code>sorage web</code> to open it with a one-time session secret.</p>
<nav>
<a href="#/dashboard" data-nav>Dashboard</a>
<a href="#/inbox" data-nav>Inbox</a>
<a href="#/outbox" data-nav>Outbox</a>
<a href="#/settings" data-nav>Settings</a>
</nav>
</header>
<main id="view"></main>
<script src="/assets/app.js"></script>
</body>
</html>
`;

export const WEB_CSS = `:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; }
header { display: flex; gap: 1rem; align-items: baseline; padding: 0.75rem 1rem; border-bottom: 1px solid #8883; }
header h1 { font-size: 1.1rem; margin: 0; }
nav a { margin-right: 0.75rem; }
main { padding: 1rem; max-width: 48rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #8882; font-size: 0.9rem; }
.filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0 1rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dl.meta dt { color: #888; }
dl.meta dd { margin: 0; word-break: break-all; }
pre.preview { border: 1px solid #8883; padding: 0.75rem; overflow-x: auto; white-space: pre-wrap; }
.tombstone { border: 1px solid #b33; padding: 0.75rem; }
.card { border: 1px solid #8883; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
.counts { display: flex; gap: 1rem; flex-wrap: wrap; }
.counts div { border: 1px solid #8883; border-radius: 6px; padding: 0.5rem 1rem; min-width: 8rem; }
.counts strong { display: block; font-size: 1.4rem; }
button { padding: 0.3rem 0.8rem; }
`;

export const WEB_APP_JS = `(function () {
  "use strict";
  var store = { token: null };
  try { store.token = sessionStorage.getItem("sorage-session"); } catch (error) { store.token = null; }

  function api(path, init) {
    return fetch(path, Object.assign({ headers: { authorization: "Bearer " + store.token } }, init || {}))
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

  // -- Views -------------------------------------------------------------------
  function dashboard() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Dashboard" }));
    var counts = el("div", { class: "counts" });
    view().appendChild(counts);
    var states = {};
    var retention = { pinned: 0, archived: 0, deletionRequested: 0 };
    api("/api/v1/handoffs?asUser=true&includeArchived=true&includeDeleted=true&limit=200").then(function (result) {
      if (result.status !== 200) { note("The dashboard could not load: " + result.body.error.code); return; }
      result.body.data.handoffs.forEach(function (handoff) {
        states[handoff.reviewState] = (states[handoff.reviewState] || 0) + 1;
        if (handoff.pinned === true) retention.pinned += 1;
        if (handoff.archivedAt !== null) retention.archived += 1;
        if (handoff.pendingDeletionRequest !== null && handoff.pendingDeletionRequest !== undefined) retention.deletionRequested += 1;
      });
      Object.keys(states).sort().forEach(function (state) {
        counts.appendChild(el("div", {}, [el("strong", { text: String(states[state]) }), el("span", { text: state })]));
      });
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.pinned) }), el("span", { text: "pinned" })]));
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.archived) }), el("span", { text: "archived" })]));
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.deletionRequested) }), el("span", { text: "deletion requested" })]));
      var recent = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Updated" }), el("th", { text: "Title" }), el("th", { text: "State" })])])]);
      var body = el("tbody", {});
      result.body.data.handoffs.slice(0, 10).forEach(function (handoff) {
        body.appendChild(el("tr", {}, [
          el("td", { text: (handoff.updatedAt || handoff.createdAt || "").replace("T", " ").slice(0, 19) }),
          el("td", {}, [el("a", { href: "#/handoff/" + handoff.id, text: handoff.title })]),
          el("td", { text: handoff.reviewState }),
        ]));
      });
      recent.appendChild(body);
      view().appendChild(el("h3", { text: "Recent updates" }));
      view().appendChild(recent);
    });
  }

  function listing(kind) {
    var query = location.hash.split("?")[1] || "";
    var params = new URLSearchParams(query);
    var url = "/api/v1/handoffs?box=" + kind + (store.as ? "&as=" + encodeURIComponent(store.as) : "&asUser=true");
    ["state", "includeArchived", "includeDeleted"].forEach(function (key) {
      if (params.has(key)) url += "&" + key + "=" + params.get(key);
    });
    view().replaceChildren();
    view().appendChild(el("h2", { text: kind === "inbox" ? "Inbox" : "Outbox" }));
    var filters = el("div", { class: "filters" });
    var stateInput = el("input", { placeholder: "state filter" });
    stateInput.value = params.get("state") || "";
    var archived = el("input", { type: "checkbox" });
    archived.checked = params.get("includeArchived") === "true";
    filters.appendChild(stateInput);
    filters.appendChild(archived);
    filters.appendChild(el("label", { text: " include archived" }));
    filters.appendChild(el("button", { text: "Apply", onclick: function () {
      var next = new URLSearchParams();
      if (stateInput.value !== "") next.set("state", stateInput.value);
      if (archived.checked) next.set("includeArchived", "true");
      location.hash = "#/" + kind + (next.toString() !== "" ? "?" + next.toString() : "");
    } }));
    view().appendChild(filters);
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Handoff" }), el("th", { text: "State" }), el("th", { text: "Revision" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    view().appendChild(table);
    api(url).then(function (result) {
      if (result.status !== 200) { note("The listing could not load: " + result.body.error.code); return; }
      result.body.data.handoffs.forEach(function (handoff) {
        body.appendChild(el("tr", {}, [
          el("td", {}, [el("a", { href: "#/handoff/" + handoff.id, text: handoff.title })]),
          el("td", { text: handoff.reviewState }),
          el("td", { text: String(handoff.revision) }),
        ]));
      });
    });
  }

  function detail(id) {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Handoff" }));
    api("/api/v1/handoffs/" + id + "?asUser=true").then(function (result) {
      if (result.status !== 200) { view().appendChild(el("p", { text: "Not found: " + result.body.error.code })); return; }
      var handoff = result.body.data;
      var meta = el("dl", { class: "meta" });
      function row(term, value) { meta.appendChild(el("dt", { text: term })); meta.appendChild(el("dd", { text: value })); }
      row("id", handoff.id);
      row("sender", handoff.senderDisplayName || handoff.senderKind || "");
      row("recipient", handoff.recipientSlug || handoff.recipientProjectId || "");
      row("review state", handoff.reviewState);
      row("revision", String(handoff.revision));
      row("row version", String(handoff.rowVersion));
      row("next actor", handoff.nextActor || nextActorOf(handoff));
      row("created", handoff.createdAt || "");
      view().appendChild(meta);
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
        ["originalName", "mimeType", "sizeBytes", "sha256", "revision"].forEach(function (key) {
          am.appendChild(el("dt", { text: key }));
          am.appendChild(el("dd", { text: String(artifact[key] === null || artifact[key] === undefined ? "" : artifact[key]) }));
        });
        card.appendChild(am);
        card.appendChild(el("a", { href: "/api/v1/handoffs/" + id + "/artifact/content?asUser=true", text: "Download" }));
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
      if (handoff.reviewNote !== null && handoff.reviewNote !== undefined) {
        var noteCard = el("div", { class: "card" });
        noteCard.appendChild(el("h3", { text: "Review note" }));
        noteCard.appendChild(el("p", { text: handoff.reviewNote.body || "" }));
        view().appendChild(noteCard);
      }
      var timelineCard = el("div", { class: "card" });
      timelineCard.appendChild(el("h3", { text: "Timeline" }));
      var list = el("ul", {});
      (handoff.timeline || []).forEach(function (entry) {
        list.appendChild(el("li", { text: (entry.at || "") + " — " + entry.type + " (" + (entry.actorKind || "") + ")" }));
      });
      timelineCard.appendChild(list);
      view().appendChild(timelineCard);
    });
  }

  function nextActorOf(handoff) {
    if (handoff.reviewState === "awaiting_recipient") return "recipient";
    if (handoff.reviewState === "changes_requested") return "sender";
    return "none (terminal)";
  }

  function diagnostics() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Diagnostics" }));
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Check" }), el("th", { text: "Severity" }), el("th", { text: "Message" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    view().appendChild(table);
    api("/api/v1/diagnostics").then(function (result) {
      if (result.status !== 200) { note("Diagnostics could not load."); return; }
      result.body.data.checks.forEach(function (check) {
        body.appendChild(el("tr", {}, [el("td", { text: check.id }), el("td", { text: check.severity }), el("td", { text: check.message })]));
      });
    });
  }

  function settings() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Settings" }));
    var path = el("p", {});
    var yaml = el("pre", { class: "preview", text: "Loading…" });
    var form = el("form", {});
    var pageSize = el("input", { type: "number", min: "1" });
    var marker = el("select", {}, [el("option", { value: "false", text: "off" }), el("option", { value: "true", text: "on" })]);
    form.appendChild(el("label", { text: "Default page size " }));
    form.appendChild(pageSize);
    form.appendChild(el("label", { text: " Inbox marker " }));
    form.appendChild(marker);
    var saveNote = el("p", {});
    form.appendChild(el("button", { type: "submit", text: "Save" }));
    form.appendChild(saveNote);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      api("/api/v1/config").then(function (current) {
        if (current.status !== 200) { saveNote.textContent = "Load failed: " + current.body.error.code; return; }
        api("/api/v1/config", {
          method: "PUT",
          headers: { authorization: "Bearer " + store.token, "if-match": current.body.data.etag, "content-type": "application/json" },
          body: JSON.stringify({ key: "ui.defaultPageSize", value: pageSize.value }),
        }).then(function (saved) {
          saveNote.textContent = saved.body.ok ? "Saved." : "Save failed: " + saved.body.error.code;
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
    });
  }

  function route() {
    if (store.token === null) {
      view().replaceChildren(el("p", { text: "Run sorage web to open this page with a one-time session secret." }));
      return;
    }
    note("");
    var hash = location.hash.replace(/^#/, "") || "/dashboard";
    var path = hash.split("?")[0];
    if (path === "/" || path === "/dashboard") dashboard();
    else if (path === "/inbox") listing("inbox");
    else if (path === "/outbox") listing("outbox");
    else if (path.indexOf("/handoff/") === 0) detail(path.slice("/handoff/".length));
    else if (path === "/diagnostics") diagnostics();
    else if (path === "/settings") settings();
    else dashboard();
    document.querySelectorAll("[data-nav]").forEach(function (link) {
      link.style.fontWeight = link.getAttribute("href") === "#" + path ? "bold" : "normal";
    });
  }

  var fragment = location.hash.match(/[#&]s=([^&]+)/);
  if (fragment !== null) {
    history.replaceState(null, "", location.pathname);
    fetch("/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: fragment[1] }) })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        if (body !== null) {
          store.token = body.data.token;
          try { sessionStorage.setItem("sorage-session", store.token); } catch (error) { /* optional */ }
        }
        route();
      });
  } else {
    route();
  }
  window.addEventListener("hashchange", route);
})();
`;
