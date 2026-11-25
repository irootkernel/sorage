import { api, fetchAllHandoffs, store } from "../api";
import { badge, el, emptyState, loading, note, REVIEW_STATES, timeNode, view } from "../dom";
import { hashQuery } from "../hash";
import { renderMarkdownSafe } from "../markdown";
import type { Handoff, HandoffComment, HandoffEvent, HandoffPage } from "../types";

export function listing(kind: "inbox" | "outbox") {
  const query = hashQuery();
  const params = new URLSearchParams(query);
  let url =
    "/api/v1/handoffs?box=" +
    encodeURIComponent(kind) +
    (store.as ? `&as=${encodeURIComponent(store.as)}` : "&asUser=true");
  ["state", "sender", "recipient", "updatedSince", "updatedUntil", "includeArchived", "includeDeleted"].forEach(
    (key) => {
      const value = params.get(key);
      if (value !== null) url += `&${key}=${encodeURIComponent(value)}`;
    },
  );
  view().replaceChildren();
  view().appendChild(el("h2", { text: kind === "inbox" ? "Inbox" : "Outbox" }));
  // WEB-003: the same filter set the CLI offers, URL-addressable so a reload
  // or a shared link reproduces the same listing.
  const filters = el("div", { class: "filters" });
  const stateInput = el(
    "select",
    { "aria-label": "State filter" },
    [el("option", { value: "", text: "any state" })].concat(
      REVIEW_STATES.map((state) => el("option", { value: state, text: state })),
    ),
  );
  const stateParam = params.get("state") || "";
  stateInput.value = stateParam;
  // A URL value outside the five review states still filters the listing, so
  // it needs a visible option instead of a blank select (WEB-003).
  if (stateParam !== "" && stateInput.value !== stateParam) {
    stateInput.appendChild(el("option", { value: stateParam, text: stateParam }));
    stateInput.value = stateParam;
  }
  const senderInput = el("input", { placeholder: "sender slug", "aria-label": "Sender slug" });
  senderInput.value = params.get("sender") || "";
  const recipientInput = el("input", { placeholder: "recipient slug", "aria-label": "Recipient slug" });
  recipientInput.value = params.get("recipient") || "";
  const sinceInput = el("input", { placeholder: "updated since (ISO-8601)", "aria-label": "Updated since" });
  sinceInput.value = params.get("updatedSince") || "";
  const untilInput = el("input", { placeholder: "updated until (ISO-8601)", "aria-label": "Updated until" });
  untilInput.value = params.get("updatedUntil") || "";
  const archived = el("input", { type: "checkbox" });
  archived.checked = params.get("includeArchived") === "true";
  const deleted = el("input", { type: "checkbox" });
  deleted.checked = params.get("includeDeleted") === "true";
  const invalid = el("span", { class: "filter-error", role: "alert", text: "" });
  const apply = el("button", { class: "primary", text: "Apply" });
  apply.addEventListener("click", () => {
    const sinceBound = sinceInput.value.trim();
    const untilBound = untilInput.value.trim();
    const isoLike = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
    if ((sinceBound !== "" && !isoLike.test(sinceBound)) || (untilBound !== "" && !isoLike.test(untilBound))) {
      invalid.textContent = "Date bounds need ISO-8601 form, for example 2026-08-01T00:00:00Z.";
      return;
    }
    invalid.textContent = "";
    const next = new URLSearchParams();
    if (stateInput.value !== "") next.set("state", stateInput.value);
    if (senderInput.value !== "") next.set("sender", senderInput.value);
    if (recipientInput.value !== "") next.set("recipient", recipientInput.value);
    if (sinceBound !== "") next.set("updatedSince", sinceBound);
    if (untilBound !== "") next.set("updatedUntil", untilBound);
    if (archived.checked) next.set("includeArchived", "true");
    if (deleted.checked) next.set("includeDeleted", "true");
    location.hash = `#/${kind}${next.toString() !== "" ? `?${next.toString()}` : ""}`;
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
  const pending = loading(`Loading the ${kind === "inbox" ? "inbox" : "outbox"}…`);
  view().appendChild(pending);
  const table = el("table", { class: "handoff-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Handoff" }),
        el("th", { text: "State" }),
        el("th", { text: "Revision" }),
        el("th", { text: "Reading / processing" }),
      ]),
    ]),
  ]);
  const body = el("tbody", {});
  table.appendChild(body);
  api<HandoffPage>(url).then((result) => {
    if (!pending.isConnected) return;
    pending.remove();
    if (!result.body.ok) {
      note(`The listing could not load: ${result.body.error.code}`);
      return;
    }
    if (result.body.data.handoffs.length === 0) {
      view().appendChild(emptyState("No Handoffs match the current filters."));
      return;
    }
    result.body.data.handoffs.forEach((handoff) => {
      body.appendChild(
        el("tr", {}, [
          el("td", {}, [el("a", { href: `#/handoff/${encodeURIComponent(handoff.id)}`, text: handoff.title })]),
          el("td", {}, [badge(handoff.reviewState)]),
          el("td", {}, [el("span", { class: "mono", text: String(handoff.revision) })]),
          el("td", { class: "report-summary" }, [
            el("div", { text: readText(handoff) }),
            el("div", { text: processingText(handoff) }),
            el("div", {
              class: "muted",
              text: handoff.comment ? commentText(handoff.comment, handoff.revision) : "No recipient comment",
            }),
          ]),
        ]),
      );
    });
    view().appendChild(table);
  });
}

export function deletionRequests() {
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Deletion Requests" }));
  const pending = loading("Loading the deletion requests…");
  view().appendChild(pending);
  view().appendChild(
    el("p", {
      class: "muted",
      text: "Approve or reject a request from the Handoff detail view; approval of a pinned Handoff asks for the distinct confirmation there.",
    }),
  );
  fetchAllHandoffs(
    "/api/v1/handoffs?asUser=true&includeArchived=true&includeDeleted=true&limit=200",
    () => !pending.isConnected,
  )
    .then((result) => {
      if ("stale" in result || !pending.isConnected) return;
      pending.remove();
      if (!result.body.ok) {
        note(`The deletion requests could not load: ${result.body.error.code}`);
        return;
      }
      const requested = result.body.data.handoffs.filter((handoff) => handoff.pendingDeletionRequest === true);
      if (requested.length === 0) {
        view().appendChild(emptyState("No pending deletion requests."));
        return;
      }
      const table = el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [el("th", { text: "Handoff" }), el("th", { text: "State" }), el("th", { text: "Pinned" })]),
        ]),
      ]);
      const body = el("tbody", {});
      table.appendChild(body);
      requested.forEach((handoff) => {
        body.appendChild(
          el("tr", {}, [
            el("td", {}, [el("a", { href: `#/handoff/${encodeURIComponent(handoff.id)}`, text: handoff.title })]),
            el("td", {}, [badge(handoff.reviewState)]),
            el("td", { text: handoff.pinned === true ? "pinned" : "" }),
          ]),
        );
      });
      view().appendChild(table);
    })
    .catch(() => {
      if (!pending.isConnected) return;
      pending.remove();
      note("The deletion requests could not load.");
    });
}

export function detail(id: string) {
  const encodedId = encodeURIComponent(id);
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Handoff" }));
  const pending = loading("Loading the Handoff…");
  view().appendChild(pending);
  api<Handoff>(`/api/v1/handoffs/${encodedId}?asUser=true`).then((result) => {
    if (!pending.isConnected) return;
    pending.remove();
    if (!result.body.ok) {
      view().appendChild(el("p", { text: `Not found: ${result.body.error.code}` }));
      return;
    }
    const handoff = result.body.data;
    const metaCard = el("div", { class: "card" });
    metaCard.appendChild(
      el("h3", { text: handoff.title === null || handoff.title === undefined ? "Handoff" : handoff.title }),
    );
    const meta = el("dl", { class: "meta" });
    function row(term: string, value: string | Node) {
      const cell = typeof value === "string" ? el("dd", { text: value }) : el("dd", {}, [value]);
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
    row("current reading", readText(handoff));
    row("processing", processingText(handoff));
    row(
      "processing evidence",
      "Revision " +
        handoff.processing.revision +
        "; started " +
        (handoff.processing.startedAt || "not recorded") +
        "; completed " +
        (handoff.processing.completedAt || "not recorded"),
    );
    row(
      "first fetched",
      handoff.firstFetchedAt === null || handoff.firstFetchedAt === undefined
        ? "never fetched (other recipient engagement may prevent withdrawal)"
        : handoff.firstFetchedAt,
    );
    row("created", handoff.createdAt || "");
    metaCard.appendChild(meta);
    view().appendChild(metaCard);
    renderTimeline(id);
    if (handoff.deletedAt !== null && handoff.deletedAt !== undefined) {
      const tomb = el("div", { class: "tombstone" });
      tomb.appendChild(el("strong", { text: `Deleted ${handoff.deletedAt}` }));
      tomb.appendChild(el("p", { text: "This Handoff is a tombstone. Prior Git commits may retain earlier content." }));
      view().appendChild(tomb);
      return;
    }
    if (handoff.currentArtifact !== null && handoff.currentArtifact !== undefined) {
      const artifact = handoff.currentArtifact;
      const card = el("div", { class: "card" });
      card.appendChild(el("h3", { text: "Artifact" }));
      const am = el("dl", { class: "meta" });
      // storageKey ships instead of the artifact DTO's absent revision; the
      // Handoff revision already shows in the metadata card above (WEB-004).
      // An inline Artifact carries null: its stored text is the body, so the
      // detail shows the representation instead of an empty key (SHR-013).
      (["originalName", "mimeType", "sizeBytes", "sha256", "storageKey"] as const).forEach((key) => {
        am.appendChild(el("dt", { text: key }));
        const value =
          key === "storageKey" && (artifact[key] === null || artifact[key] === undefined)
            ? "inline (no Vault file)"
            : String(artifact[key] === null || artifact[key] === undefined ? "" : artifact[key]);
        am.appendChild(
          key === "sha256" || key === "storageKey"
            ? el("dd", {}, [el("span", { class: "mono", text: value })])
            : el("dd", { text: value }),
        );
      });
      card.appendChild(am);
      const revealStatus = el("span", { class: "muted", text: "" });
      const reveal = el("button", { text: "Reveal in Finder" });
      reveal.addEventListener("click", () => {
        api<{ localPath: string }>(`/api/v1/handoffs/${encodedId}/artifact/reveal?asUser=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }).then((outcome) => {
          revealStatus.textContent = outcome.body.ok
            ? ` ${outcome.body.data.localPath}`
            : ` ${outcome.body.error.code}`;
        });
      });
      const actions = el("div", { class: "actions-row" });
      const downloadStatus = el("span", { class: "muted", text: "" });
      const download = el("button", { text: "Download" });
      download.addEventListener("click", () => {
        download.disabled = true;
        downloadStatus.textContent = "";
        fetch(`/api/v1/handoffs/${encodedId}/artifact/content?asUser=true`, {
          headers: { authorization: `Bearer ${store.token}` },
        })
          .then((response) => {
            if (!response.ok) {
              downloadStatus.textContent = `Download failed (HTTP ${response.status}).`;
              return null;
            }
            return response.blob();
          })
          .then((blob) => {
            if (blob === null) return;
            const url = URL.createObjectURL(blob);
            const link = el("a", { href: url, download: artifact.originalName || "artifact" });
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => {
              URL.revokeObjectURL(url);
            }, 60000);
          })
          .catch(() => {
            downloadStatus.textContent = "Download failed. Try again.";
          })
          .finally(() => {
            download.disabled = false;
          });
      });
      actions.appendChild(download);
      actions.appendChild(downloadStatus);
      actions.appendChild(reveal);
      actions.appendChild(revealStatus);
      card.appendChild(actions);
      view().appendChild(card);
      if (isPreviewable(artifact.mimeType || "")) {
        fetch(`/api/v1/handoffs/${encodedId}/artifact/content?asUser=true`, {
          headers: { authorization: `Bearer ${store.token}` },
        })
          .then((response) => {
            if (!response.ok) throw new Error("preview unavailable");
            return response.text();
          })
          .then((text) => {
            if (!metaCard.isConnected) return;
            const preview = el("div", { class: "card" });
            preview.appendChild(el("h3", { text: "Preview" }));
            preview.appendChild(renderMarkdownSafe(text));
            view().appendChild(preview);
            preview.appendChild(
              el("p", {
                class: "muted",
                text: "Successful User-proxy body delivery can confirm its acquired Revision. The metadata above retains the original proposal observation; inspect again to see settled reading.",
              }),
            );
          })
          .catch(() => {
            if (card.isConnected)
              card.appendChild(
                el("p", { role: "status", text: "Preview unavailable; current reading is not inferred." }),
              );
          });
      } else {
        const notice = el("div", { class: "card" });
        notice.appendChild(
          el("p", {
            text:
              artifact.mimeType === "image/svg+xml"
                ? "This Artifact is SVG and is never rendered inline; use the download."
                : "This Artifact type is not previewable; use the download.",
          }),
        );
        view().appendChild(notice);
      }
    }
    renderComment(id, handoff.revision);
    view().appendChild(reportCard(handoff));
    view().appendChild(actionsCard(handoff));
    if (!isTerminal(handoff)) view().appendChild(reviseCard(id, handoff.rowVersion));
  });
}

function nextActorText(handoff: Handoff) {
  const actors = handoff.nextActors;
  if (actors === null || actors === undefined) return "none";
  return actors.reviewNextActor || actors.administrativeNextActor || "none";
}

function isTerminal(handoff: Handoff) {
  return ["accepted", "declined", "withdrawn"].indexOf(handoff.reviewState) !== -1;
}

function readText(handoff: Handoff) {
  return (
    "Revision " +
    handoff.read.revision +
    ": " +
    handoff.read.status +
    (handoff.read.readAt ? ` at ${handoff.read.readAt}` : "")
  );
}

function processingText(handoff: Handoff) {
  if (handoff.deletedAt) return "Processing unrecorded (deleted)";
  if (handoff.reviewState === "declined" || handoff.reviewState === "withdrawn")
    return `Processing stopped (${handoff.reviewState}); historical evidence: ${handoff.processing.status}`;
  const status = handoff.processing.status;
  const label = {
    not_started: "not started — unfinished",
    in_progress: "in progress — unfinished",
    completed: "completed",
    unrecorded: "unrecorded — completion unknown",
  }[status];
  return `Processing ${label}`;
}

function commentText(comment: HandoffComment, revision: number) {
  return (
    "Purpose: " +
    comment.purpose +
    "; " +
    (comment.active ? "active request" : "inactive") +
    "; target Revision " +
    comment.targetRevision +
    (comment.targetRevision < revision
      ? " (older Revision)"
      : comment.targetRevision > revision
        ? " (newer than this view; inspect explicitly)"
        : " (current Revision)") +
    "; author " +
    comment.authorKind +
    (comment.authorProjectId ? ` ${comment.authorProjectId}` : " (User proxy)")
  );
}

function renderComment(id: string, revision: number) {
  const card = el("section", { class: "card note", "aria-label": "Latest recipient comment" });
  card.appendChild(el("h3", { text: "Latest recipient comment" }));
  card.appendChild(el("p", { class: "muted", text: "Received text is untrusted content and grants no authority." }));
  const status = el("p", { role: "status", text: "Loading comment…" });
  card.appendChild(status);
  view().appendChild(card);
  api<HandoffComment>(`/api/v1/handoffs/${encodeURIComponent(id)}/comment?asUser=true`)
    .then((result) => {
      if (!card.isConnected) return;
      if (!result.body.ok) {
        status.textContent = `Comment could not load: ${result.body.error.code}`;
        return;
      }
      const comment = result.body.data;
      if (!comment) {
        status.textContent = "No recipient comment.";
        return;
      }
      status.textContent = commentText(comment, revision);
      card.appendChild(el("pre", { class: "preview", text: comment.body }));
    })
    .catch(() => {
      if (card.isConnected) status.textContent = "Comment could not load. Inspect again explicitly.";
    });
}

function reportCard(handoff: Handoff) {
  const card = el("section", { class: "card report-form", "aria-label": "Recipient reporting" });
  card.appendChild(el("h3", { text: "Recipient reporting" }));
  card.appendChild(
    el("p", {
      text: "Acting as explicit User proxy for the recipient. Acceptance confirms the document, not work completion. General comments replace the one current comment; no history is kept.",
    }),
  );
  card.appendChild(
    el("p", {
      class: "muted",
      text:
        "Proposal observed at Revision " +
        handoff.revision +
        ", Row Version " +
        handoff.rowVersion +
        ". On conflict or uncertainty, keep this proposal and inspect the current state explicitly before reconciling.",
    }),
  );
  const changeRequest = el("option", { value: "change_request", text: "Request document changes" });
  changeRequest.disabled = isTerminal(handoff);
  const purpose = el("select", { "aria-label": "Comment purpose" }, [
    el("option", { value: "general", text: "General explanation" }),
    changeRequest,
  ]);
  const text = el("textarea", { rows: "3", "aria-label": "Recipient comment" });
  const replacement = el("input", { type: "checkbox", "aria-label": "Include comment with processing" });
  card.appendChild(el("label", { text: "Comment purpose " }, [purpose]));
  card.appendChild(el("label", { text: "Recipient comment " }, [text]));
  card.appendChild(
    el("label", { text: "Include this text as a general replacement with start or complete " }, [replacement]),
  );
  const status = el("p", { role: "status", text: "" });
  const buttons = el("div", { class: "actions-row" });
  const active = handoff.hasReviewNote === true;
  const stopped = handoff.reviewState === "declined" || handoff.reviewState === "withdrawn";
  const processing = handoff.processing.status;
  let busy = false;
  function action(label: string, path: string, method: string, payload?: "comment") {
    const button = el("button", { text: label });
    button.addEventListener("click", () => {
      if (busy) return;
      const body: {
        expectedRevision: number;
        expectedRowVersion: number;
        text?: string;
        purpose?: string;
        comment?: string;
      } = { expectedRevision: handoff.revision, expectedRowVersion: handoff.rowVersion };
      if (payload === "comment") {
        body.text = text.value;
        body.purpose = purpose.value;
      } else if (replacement.checked) body.comment = text.value;
      busy = true;
      status.textContent = "Submitting…";
      api(`/api/v1/handoffs/${encodeURIComponent(handoff.id)}${path}?asUser=true`, {
        method: method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((outcome) => {
          if (!outcome.body.ok) {
            status.textContent =
              outcome.body.error.code +
              ": " +
              outcome.body.error.message +
              " Proposal retained with its original observations; inspect before reconciling.";
            return;
          }
          detail(handoff.id);
        })
        .catch(() => {
          status.textContent =
            "Outcome unknown. Proposal and original observations retained. Inspect current state explicitly; do not retry blindly.";
        })
        .finally(() => {
          busy = false;
        });
    });
    buttons.appendChild(button);
    return button;
  }
  const commentButton = action("Set comment", "/comment", "PUT", "comment");
  const start = action("Start processing", "/processing/start", "POST");
  const complete = action("Complete processing", "/processing/complete", "POST");
  function guards() {
    commentButton.disabled = active && purpose.value === "general";
    start.disabled =
      stopped || processing === "in_progress" || processing === "completed" || (active && replacement.checked);
    complete.disabled = stopped || processing === "completed" || active;
  }
  purpose.addEventListener("change", guards);
  replacement.addEventListener("change", guards);
  guards();
  if (active)
    card.appendChild(
      el("p", {
        class: "warning",
        text: "An active change request must be resolved or withdrawn before general replacement or completion. Start without a replacement remains available.",
      }),
    );
  card.appendChild(buttons);
  card.appendChild(status);
  return card;
}

function renderTimeline(id: string) {
  api<HandoffEvent[]>(`/api/v1/handoffs/${encodeURIComponent(id)}/events?asUser=true`).then((result) => {
    const timelineCard = el("div", { class: "card timeline" });
    timelineCard.appendChild(el("h3", { text: "Timeline" }));
    const events = result.status === 200 && result.body.ok ? result.body.data : [];
    if (events.length === 0) {
      timelineCard.appendChild(el("p", { class: "muted", text: "No events recorded." }));
    } else {
      const list = el("ul", {});
      events.forEach((entry) => {
        const item = el("li", {});
        item.appendChild(timeNode(entry.createdAt));
        item.appendChild(el("strong", { text: ` ${entry.eventType} ` }));
        item.appendChild(el("span", { class: "muted", text: `(${entry.actorKind || ""})` }));
        list.appendChild(item);
      });
      timelineCard.appendChild(list);
    }
    timelineCard.appendChild(
      el("p", {
        class: "muted",
        text: "Metadata events only; the timeline never implies historical Artifact content is retrievable.",
      }),
    );
    view().appendChild(timelineCard);
  });
}

function reviseCard(id: string, expectedRowVersion: number) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", { text: "Revise" }));
  const status = el("p", { class: "muted", text: "" });
  const file = el("input", { type: "file", "aria-label": "Replacement document" });
  const submit = el("button", { type: "submit", text: "Revise through upload" });
  submit.addEventListener("click", () => {
    const attachment = file.files?.[0];
    if (!attachment) {
      status.textContent = "Choose a replacement file first.";
      return;
    }
    const form = new FormData();
    form.append("file", attachment);
    form.append("expectedRowVersion", String(expectedRowVersion));
    api<{ revision: number }>(`/api/v1/handoffs/${encodeURIComponent(id)}/revise?asUser=true`, {
      method: "POST",
      body: form,
    })
      .then((outcome) => {
        status.textContent = outcome.body.ok
          ? `Revised to revision ${outcome.body.data.revision}`
          : outcome.body.error.code;
        if (outcome.body.ok) detail(id);
      })
      .catch(() => {
        status.textContent =
          "Revision outcome unknown. Selected file and original observation retained; inspect current state explicitly before retrying.";
      });
  });
  const row = el("div", { class: "actions-row" });
  row.appendChild(file);
  row.appendChild(submit);
  card.appendChild(row);
  card.appendChild(status);
  return card;
}

function actionsCard(handoff: Handoff) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", { text: "Actions" }));
  const status = el("p", { class: "muted", role: "status", text: "" });
  card.appendChild(
    el("p", {
      class: "muted",
      text: "Actions use explicit User authority; recipient reports use User-proxy provenance.",
    }),
  );
  function act(
    label: string,
    path: string,
    body?: Record<string, unknown> | (() => Record<string, unknown>),
    method?: string,
    tone?: string,
  ) {
    const button = el("button", tone === undefined ? { text: label } : { class: tone, text: label });
    button.addEventListener("click", () => {
      status.textContent = "";
      const payload = typeof body === "function" ? body() : body || { asUser: true };
      api(path, {
        method: method || "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((outcome) => {
          if (!outcome.body.ok) {
            status.textContent = `${outcome.body.error.code}: ${outcome.body.error.message}`;
            return;
          }
          detail(handoff.id);
        })
        .catch(() => {
          status.textContent =
            "Outcome unknown. Inputs and original observations retained; inspect current state explicitly before retrying.";
        });
    });
    if (
      (isTerminal(handoff) &&
        ["Set note", "Remove note", "Withdraw request", "Accept", "Decline"].indexOf(label) !== -1) ||
      (label === "Accept" && handoff.hasReviewNote) ||
      (label === "Remove note" && !handoff.comment) ||
      (label === "Withdraw request" && !handoff.hasReviewNote)
    )
      button.disabled = true;
    return button;
  }
  const handoffBase = `/api/v1/handoffs/${encodeURIComponent(handoff.id)}`;
  const noteGroup = el("div", { class: "action-group" });
  noteGroup.appendChild(el("h4", { text: "Review note" }));
  const note = el("textarea", {
    rows: "2",
    cols: "40",
    placeholder: "User proxy review note",
    "aria-label": "Review note",
  });
  const noteRow = el("div", { class: "actions-row" });
  noteRow.appendChild(note);
  noteRow.appendChild(
    act(
      "Set note",
      `${handoffBase}/review-note?asUser=true`,
      () => ({
        text: note.value,
        targetRevision: handoff.revision,
        expectedRowVersion: handoff.rowVersion,
        asUser: true,
      }),
      "PUT",
    ),
  );
  noteRow.appendChild(
    act(
      "Remove note",
      `${handoffBase}/review-note?asUser=true&confirm=true`,
      { expectedRowVersion: handoff.rowVersion, asUser: true },
      "DELETE",
      "danger",
    ),
  );
  noteRow.appendChild(
    act("Withdraw request", `${handoffBase}/review-note/withdraw?asUser=true`, {
      expectedRowVersion: handoff.rowVersion,
      asUser: true,
    }),
  );
  noteGroup.appendChild(noteRow);
  card.appendChild(noteGroup);

  const decisionGroup = el("div", { class: "action-group" });
  decisionGroup.appendChild(el("h4", { text: "Review decision" }));
  const decisionRow = el("div", { class: "actions-row" });
  decisionRow.appendChild(
    act(
      "Accept",
      `${handoffBase}/accept?asUser=true`,
      { expectedRevision: handoff.revision, expectedRowVersion: handoff.rowVersion, asUser: true },
      "POST",
      "primary",
    ),
  );
  decisionRow.appendChild(
    act(
      "Decline",
      `${handoffBase}/decline?asUser=true`,
      { reason: "Declined from the Web UI", expectedRowVersion: handoff.rowVersion, asUser: true },
      "POST",
      "danger",
    ),
  );
  decisionGroup.appendChild(decisionRow);
  card.appendChild(decisionGroup);

  const organizationGroup = el("div", { class: "action-group" });
  organizationGroup.appendChild(el("h4", { text: "Organization" }));
  const organizationRow = el("div", { class: "actions-row" });
  organizationRow.appendChild(
    act(
      handoff.pinned === true ? "Unpin" : "Pin",
      `${handoffBase}/${handoff.pinned === true ? "unpin" : "pin"}?asUser=true`,
      { asUser: true },
    ),
  );
  organizationRow.appendChild(
    act(
      handoff.archivedAt !== null && handoff.archivedAt !== undefined ? "Unarchive" : "Archive",
      handoffBase +
        "/" +
        (handoff.archivedAt !== null && handoff.archivedAt !== undefined ? "unarchive" : "archive") +
        "?asUser=true",
      { asUser: true },
    ),
  );
  organizationGroup.appendChild(organizationRow);
  card.appendChild(organizationGroup);

  const deletionGroup = el("div", { class: "action-group danger-zone" });
  deletionGroup.appendChild(el("h4", { text: "Deletion" }));
  const deletionRow = el("div", { class: "actions-row" });
  deletionRow.appendChild(
    act("Request deletion", `${handoffBase}/deletion-request?asUser=true`, { asUser: true }, "POST", "danger"),
  );
  deletionRow.appendChild(act("Reject deletion", `${handoffBase}/deletion-reject?asUser=true`, { asUser: true }));
  const pinnedConfirm = el("input", {
    placeholder: "type the Handoff id to confirm pinned deletion",
    size: "36",
    "aria-label": "Pinned deletion confirmation",
  });
  deletionRow.appendChild(pinnedConfirm);
  deletionRow.appendChild(
    act(
      "Approve deletion",
      `${handoffBase}/deletion-approve?asUser=true&confirm=true`,
      () => ({ asUser: true, expectedRowVersion: handoff.rowVersion, confirmPinned: pinnedConfirm.value }),
      "POST",
      "danger",
    ),
  );
  deletionGroup.appendChild(deletionRow);
  deletionGroup.appendChild(
    el("p", {
      class: "muted",
      text: "Approving a pinned Handoff needs the distinct confirmation above; the empty form fails with PINNED_DELETE_CONFIRMATION.",
    }),
  );
  card.appendChild(deletionGroup);
  card.appendChild(status);
  return card;
}

function isPreviewable(mimeType: string) {
  if (mimeType === "image/svg+xml") return false; // SVG never renders inline (WEB-006)
  if (mimeType === "text/markdown" || mimeType === "text/plain") return true;
  if (/^text\//.test(mimeType)) return true;
  return false;
}
