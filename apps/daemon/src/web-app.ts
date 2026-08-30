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
<a href="#/projects" data-nav>Projects</a>
<a href="#/compose" data-nav>Compose</a>
<a href="#/inbox" data-nav>Inbox</a>
<a href="#/outbox" data-nav>Outbox</a>
<a href="#/deletion-requests" data-nav>Deletion Requests</a>
<a href="#/backup" data-nav>Backup</a>
<a href="#/settings" data-nav>Settings</a>
<a href="#/diagnostics" data-nav>Diagnostics</a>
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
        if (handoff.deletedAt !== null && handoff.deletedAt !== undefined) retention.deleted += 1;
      });
      // WEB-002: every review state and retention class shows as a fixed card,
      // including at a zero count, so the dashboard is a census rather than a
      // list of whatever happens to be non-empty.
      var STATE_CARDS = ["awaiting_recipient", "changes_requested", "accepted", "declined", "withdrawn"];
      STATE_CARDS.forEach(function (state) {
        counts.appendChild(el("div", {}, [el("strong", { text: String(states[state] || 0) }), el("span", { text: state })]));
      });
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.pinned) }), el("span", { text: "pinned" })]));
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.archived) }), el("span", { text: "archived" })]));
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.deletionRequested) }), el("span", { text: "deletion requested" })]));
      counts.appendChild(el("div", {}, [el("strong", { text: String(retention.deleted) }), el("span", { text: "deleted" })]));
      // WEB-002: Backup Health, shown once Git backup exists, populated from
      // the same backup_runs data the backup page lists.
      var health = el("div", { class: "backup-health" });
      counts.appendChild(health);
      api("/api/v1/backup/status").then(function (result) {
        if (result.status !== 200) {
          health.appendChild(el("strong", { text: "Backup: unknown" }));
          health.appendChild(el("span", { text: "the status endpoint is unavailable" }));
          return;
        }
        var status = result.body.data;
        var protection = status.schedule.enabled
          ? (status.lastPush !== null ? "scheduled, remote push" : "scheduled, local commits")
          : (status.lastPush !== null ? "manual, remote push" : "local commits only");
        var healthy = status.lastFailure === null && (status.lastSuccess !== null || status.lastAttempt === null);
        health.appendChild(el("strong", { text: healthy ? "Backup: healthy" : "Backup: needs attention" }));
        health.appendChild(el("span", { text: protection + (status.lastAttempt !== null ? ", last run " + status.lastAttempt.outcome : ", never run") }));
      });
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
    ["state", "sender", "recipient", "includeArchived", "includeDeleted"].forEach(function (key) {
      if (params.has(key)) url += "&" + key + "=" + params.get(key);
    });
    view().replaceChildren();
    view().appendChild(el("h2", { text: kind === "inbox" ? "Inbox" : "Outbox" }));
    // WEB-003: the same filter set the CLI offers, URL-addressable so a reload
    // or a shared link reproduces the same listing.
    var filters = el("div", { class: "filters" });
    var stateInput = el("input", { placeholder: "state filter" });
    stateInput.value = params.get("state") || "";
    var senderInput = el("input", { placeholder: "sender slug" });
    senderInput.value = params.get("sender") || "";
    var recipientInput = el("input", { placeholder: "recipient slug" });
    recipientInput.value = params.get("recipient") || "";
    var archived = el("input", { type: "checkbox" });
    archived.checked = params.get("includeArchived") === "true";
    var deleted = el("input", { type: "checkbox" });
    deleted.checked = params.get("includeDeleted") === "true";
    filters.appendChild(stateInput);
    filters.appendChild(senderInput);
    filters.appendChild(recipientInput);
    filters.appendChild(archived);
    filters.appendChild(el("label", { text: " include archived" }));
    filters.appendChild(deleted);
    filters.appendChild(el("label", { text: " include deleted" }));
    filters.appendChild(el("button", { text: "Apply", onclick: function () {
      var next = new URLSearchParams();
      if (stateInput.value !== "") next.set("state", stateInput.value);
      if (senderInput.value !== "") next.set("sender", senderInput.value);
      if (recipientInput.value !== "") next.set("recipient", recipientInput.value);
      if (archived.checked) next.set("includeArchived", "true");
      if (deleted.checked) next.set("includeDeleted", "true");
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

  function deletionRequests() {
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Deletion Requests" }));
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Handoff" }), el("th", { text: "State" }), el("th", { text: "Pinned" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    view().appendChild(table);
    view().appendChild(el("p", { text: "Approve or reject a request from the Handoff detail view; approval of a pinned Handoff asks for the distinct confirmation there." }));
    api("/api/v1/handoffs?asUser=true&includeArchived=true&includeDeleted=true&limit=200").then(function (result) {
      if (result.status !== 200) { note("The deletion requests could not load: " + result.body.error.code); return; }
      result.body.data.handoffs
        .filter(function (handoff) { return handoff.pendingDeletionRequest === true; })
        .forEach(function (handoff) {
          body.appendChild(el("tr", {}, [
            el("td", {}, [el("a", { href: "#/handoff/" + handoff.id, text: handoff.title })]),
            el("td", { text: handoff.reviewState }),
            el("td", { text: handoff.pinned === true ? "pinned" : "" }),
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
      row("recipient", handoff.recipientProjectSlug || handoff.recipientProjectId || "");
      row("review state", handoff.reviewState);
      row("revision", String(handoff.revision));
      row("row version", String(handoff.rowVersion));
      row("next actor", nextActorText(handoff));
      row("first fetched", handoff.firstFetchedAt === null || handoff.firstFetchedAt === undefined ? "never fetched (the sender may still withdraw)" : handoff.firstFetchedAt);
      row("created", handoff.createdAt || "");
      view().appendChild(meta);
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
        ["originalName", "mimeType", "sizeBytes", "sha256", "revision"].forEach(function (key) {
          am.appendChild(el("dt", { text: key }));
          am.appendChild(el("dd", { text: String(artifact[key] === null || artifact[key] === undefined ? "" : artifact[key]) }));
        });
        card.appendChild(am);
        var revealStatus = el("span", {});
        var reveal = el("button", { text: "Reveal in Finder" });
        reveal.addEventListener("click", function () {
          api("/api/v1/handoffs/" + id + "/artifact/reveal?asUser=true", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(function (outcome) {
            revealStatus.textContent = outcome.body.ok ? " " + outcome.body.data.localPath : " " + outcome.body.error.code;
          });
        });
        card.appendChild(el("a", { href: "/api/v1/handoffs/" + id + "/artifact/content?asUser=true", text: "Download" }));
        card.appendChild(reveal);
        card.appendChild(revealStatus);
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
      noteCard.appendChild(el("p", { text: "target revision " + noteView.targetRevision + " — author " + noteView.authorKind }));
      view().appendChild(noteCard);
    });
  }

  function renderTimeline(id) {
    api("/api/v1/handoffs/" + id + "/events?asUser=true").then(function (result) {
      var timelineCard = el("div", { class: "card timeline" });
      timelineCard.appendChild(el("h3", { text: "Timeline" }));
      var list = el("ul", {});
      var events = result.status === 200 && result.body.data ? result.body.data : [];
      events.forEach(function (entry) {
        list.appendChild(el("li", { text: (entry.createdAt || "") + " — " + entry.eventType + " (" + (entry.actorKind || "") + ")" }));
      });
      timelineCard.appendChild(list);
      timelineCard.appendChild(el("p", { text: "Metadata events only; the timeline never implies historical Artifact content is retrievable." }));
      view().appendChild(timelineCard);
    });
  }

  function reviseCard(id) {
    var card = el("div", { class: "card" });
    card.appendChild(el("h3", { text: "Revise" }));
    var status = el("p", {});
    var file = el("input", { type: "file" });
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
    card.appendChild(file);
    card.appendChild(submit);
    card.appendChild(status);
    return card;
  }

  var projectsRender = 0;
  function projects() {
    var ticket = ++projectsRender;
    var stale = function (payload) { projectsRender !== ticket ? null : payload(); };
    view().replaceChildren();
    view().appendChild(el("h2", { text: "Projects" }));
    var status = el("p", {});
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Slug" }), el("th", { text: "Name" }), el("th", { text: "Bindings" }), el("th", { text: "State" }), el("th", { text: "" })])])]);
    var body = el("tbody", {});
    table.appendChild(body);
    view().appendChild(table);
    view().appendChild(status);
    view().appendChild(el("h3", { text: "Register a Project" }));
    var form = el("form", {});
    var name = el("input", { placeholder: "display name", size: "30" });
    var dir = el("input", { placeholder: "directory", size: "40" });
    form.appendChild(el("p", {}, [el("label", { text: "Name " }), name]));
    form.appendChild(el("p", {}, [el("label", { text: "Directory " }), dir]));
    form.appendChild(el("button", { type: "submit", text: "Register" }));
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      api("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.value, dir: dir.value, asUser: true }) })
        .then(function (outcome) { status.textContent = outcome.body.ok ? "Registered " + outcome.body.data.project.slug : outcome.body.error.code; projects(); });
    });
    view().appendChild(form);
    api("/api/v1/projects").then(function (result) {
      stale(function () {
      if (result.status !== 200) { status.textContent = "Projects could not load."; return; }
      result.body.data.forEach(function (entry) {
        var project = entry.project;
        var row = el("tr", {}, [
          el("td", { text: project.slug }),
          el("td", { text: project.displayName }),
          el("td", { text: String(entry.bindingCount) + (entry.unbound ? " (unbound)" : "") }),
          el("td", { text: project.status }),
        ]);
        var cell = el("td", {});
        var rename = el("input", { placeholder: "new name", size: "18" });
        var bindDir = el("input", { placeholder: "bind directory", size: "24" });
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
        cell.appendChild(renameButton);
        cell.appendChild(document.createTextNode(" "));
        cell.appendChild(action("Bind", "/api/v1/projects/" + project.slug + "/bindings", function () {
          return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: bindDir.value, asUser: true }) };
        }));
        cell.appendChild(document.createTextNode(" "));
        cell.appendChild(action("Unbind", function () {
          return "/api/v1/projects/" + project.slug + "/bindings/x?dir=" + encodeURIComponent(bindDir.value) + "&confirm=true";
        }, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ asUser: true }) }));
        cell.appendChild(document.createTextNode(" "));
        cell.appendChild(action("Archive", "/api/v1/projects/" + project.slug + "/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asUser: true }) }));
        cell.appendChild(document.createTextNode(" "));
        cell.appendChild(action("Unarchive", "/api/v1/projects/" + project.slug + "/unarchive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asUser: true }) }));
        cell.appendChild(el("p", {}, [rename, bindDir]));
        row.appendChild(cell);
        body.appendChild(row);
      });
      });
    });

    // Unregistered Workspaces: senders with no Project, listed separately and never
    // offered as recipients.
    view().appendChild(el("h3", { text: "Unregistered Workspaces" }));
    var unregistered = el("ul", {});
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
    var result = el("p", {});
    form.appendChild(el("p", {}, [el("label", { text: "Title " }), title]));
    form.appendChild(el("p", {}, [el("label", { text: "To " }), recipients]));
    form.appendChild(el("p", { text: "Several recipients create one independent Handoff each; every identifier and the shared dispatch group appear after submission." }));
    form.appendChild(el("p", {}, [el("label", { text: "Document " }), file]));
    form.appendChild(el("button", { type: "submit", text: "Send" }));
    form.appendChild(result);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (file.files.length === 0) { result.textContent = "Choose a document."; return; }
      var data = new FormData();
      data.append("title", title.value);
      recipients.value.split(",").map(function (slug) { return slug.trim(); }).filter(function (slug) { return slug !== ""; }).forEach(function (slug) { data.append("to", slug); });
      data.append("file", file.files[0]);
      fetch("/api/v1/handoffs/upload", { method: "POST", headers: { authorization: "Bearer " + store.token }, body: data })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (!body.ok) { result.textContent = "Send failed: " + body.error.code; return; }
          result.textContent = "";
          var list = el("ul", {});
          body.data.handoffs.forEach(function (sent) { list.appendChild(el("li", { text: sent.handoffId + " → " + sent.recipientSlug + " (group " + (body.data.dispatchGroupId || "none") + ")" })); });
          result.appendChild(list);
        });
    });
    view().appendChild(form);
  }

  function actionsCard(handoff) {
    var card = el("div", { class: "card" });
    card.appendChild(el("h3", { text: "Actions" }));
    var status = el("p", {});
    function act(label, path, body, method) {
      var button = el("button", { text: label });
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
    var note = el("textarea", { rows: "2", cols: "40", placeholder: "User proxy review note" });
    card.appendChild(note);
    card.appendChild(act("Set note", "/api/v1/handoffs/" + handoff.id + "/review-note?asUser=true", function () { return { text: note.value, asUser: true }; }, "PUT"));
    card.appendChild(document.createTextNode(" "));
    card.appendChild(act("Remove note", "/api/v1/handoffs/" + handoff.id + "/review-note?asUser=true&confirm=true", { asUser: true }, "DELETE"));
    card.appendChild(el("p", { text: "" }));
    card.appendChild(act("Accept", "/api/v1/handoffs/" + handoff.id + "/accept?asUser=true", { expectedRevision: handoff.revision, expectedRowVersion: handoff.rowVersion, asUser: true }));
    card.appendChild(document.createTextNode(" "));
    card.appendChild(act("Decline", "/api/v1/handoffs/" + handoff.id + "/decline?asUser=true", { reason: "Declined from the Web UI", expectedRowVersion: handoff.rowVersion, asUser: true }));
    card.appendChild(el("p", { text: "" }));
    card.appendChild(act(handoff.pinned === true ? "Unpin" : "Pin", "/api/v1/handoffs/" + handoff.id + "/" + (handoff.pinned === true ? "unpin" : "pin") + "?asUser=true", { asUser: true }));
    card.appendChild(document.createTextNode(" "));
    card.appendChild(act("Archive", "/api/v1/handoffs/" + handoff.id + "/archive?asUser=true", { asUser: true }));
    card.appendChild(document.createTextNode(" "));
    card.appendChild(act("Unarchive", "/api/v1/handoffs/" + handoff.id + "/unarchive?asUser=true", { asUser: true }));
    card.appendChild(el("p", { text: "" }));
    card.appendChild(act("Request deletion", "/api/v1/handoffs/" + handoff.id + "/deletion-request?asUser=true", { asUser: true }));
    card.appendChild(document.createTextNode(" "));
    card.appendChild(act("Reject deletion", "/api/v1/handoffs/" + handoff.id + "/deletion-reject?asUser=true", { asUser: true }));
    card.appendChild(document.createTextNode(" "));
    var pinnedConfirm = el("input", { placeholder: "type the Handoff id to confirm pinned deletion", size: "36" });
    card.appendChild(pinnedConfirm);
    card.appendChild(act("Approve deletion", "/api/v1/handoffs/" + handoff.id + "/deletion-approve?asUser=true&confirm=true", function () { return { asUser: true, confirmPinned: pinnedConfirm.value }; }));
    card.appendChild(el("p", { text: "Approving a pinned Handoff needs the distinct confirmation above; the empty form fails with PINNED_DELETE_CONFIRMATION." }));
    card.appendChild(status);
    return card;
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
    api("/api/v1/backup/status").then(function (result) {
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
          el("td", { text: String(run.startedAt).replace("T", " ").slice(0, 19) }),
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
      view().appendChild(el("p", { text: "Restore is a bootstrap command: stop the daemon and run sorage backup restore --from <vault-path> --dry-run --as-user first." }));
      view().appendChild(el("p", { text: "Deleting a Handoff removes its current file only; prior Git commits may retain earlier content, and Sorage offers no history purge." }));
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
    else if (path === "/projects") projects();
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
