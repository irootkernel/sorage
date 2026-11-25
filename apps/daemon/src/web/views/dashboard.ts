import { api, fetchAllHandoffs } from "../api";
import { badge, el, emptyState, loading, note, REVIEW_STATES, timeNode, view } from "../dom";
import type { BackupStatus } from "../types";

export function dashboard() {
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Dashboard" }));
  const pending = loading("Loading the dashboard…");
  view().appendChild(pending);
  const counts = el("div", { class: "counts" });
  const states: Record<string, number> = {};
  const retention = { pinned: 0, archived: 0, deletionRequested: 0, deleted: 0 };
  fetchAllHandoffs(
    "/api/v1/handoffs?asUser=true&includeArchived=true&includeDeleted=true&limit=200",
    () => !pending.isConnected,
  )
    .then((result) => {
      // A late response must not paint into whatever view navigated in meanwhile.
      if ("stale" in result || !pending.isConnected) return;
      pending.remove();
      if (!result.body.ok) {
        note(`The dashboard could not load: ${result.body.error.code}`);
        return;
      }
      result.body.data.handoffs.forEach((handoff) => {
        states[handoff.reviewState] = (states[handoff.reviewState] || 0) + 1;
        if (handoff.pinned === true) retention.pinned += 1;
        if (handoff.archivedAt !== null) retention.archived += 1;
        if (handoff.pendingDeletionRequest === true) retention.deletionRequested += 1;
        if (handoff.deletedAt !== null && handoff.deletedAt !== undefined) retention.deleted += 1;
      });
      // WEB-002: every review state and retention class shows as a fixed card,
      // including at a zero count, so the dashboard is a census rather than a
      // list of whatever happens to be non-empty.
      REVIEW_STATES.forEach((state) => {
        counts.appendChild(
          el("div", { class: "stat", "data-state": state }, [
            el("strong", { text: String(states[state] || 0) }),
            el("span", { text: state }),
          ]),
        );
      });
      counts.appendChild(
        el("div", { class: "stat" }, [
          el("strong", { text: String(retention.pinned) }),
          el("span", { text: "pinned" }),
        ]),
      );
      counts.appendChild(
        el("div", { class: "stat" }, [
          el("strong", { text: String(retention.archived) }),
          el("span", { text: "archived" }),
        ]),
      );
      counts.appendChild(
        el("div", { class: "stat" }, [
          el("strong", { text: String(retention.deletionRequested) }),
          el("span", { text: "deletion requested" }),
        ]),
      );
      counts.appendChild(
        el("div", { class: "stat" }, [
          el("strong", { text: String(retention.deleted) }),
          el("span", { text: "deleted" }),
        ]),
      );
      // WEB-002: Backup Health, shown once Git backup exists, populated from
      // the same backup_runs data the backup page lists.
      const health = el("div", { class: "stat backup-health", "data-state": "backup-ok" });
      counts.appendChild(health);
      api<BackupStatus>("/api/v1/backup/status")
        .then((statusResult) => {
          if (!health.isConnected) return;
          if (!statusResult.body.ok) {
            health.setAttribute("data-state", "backup-warn");
            health.appendChild(el("strong", { text: "Backup: unknown" }));
            health.appendChild(el("span", { text: "the status endpoint is unavailable" }));
            return;
          }
          const status = statusResult.body.data;
          const protection = status.schedule.enabled
            ? status.lastPush !== null
              ? "scheduled, remote push"
              : "scheduled, local commits"
            : status.lastPush !== null
              ? "manual, remote push"
              : "local commits only";
          const healthy = status.lastFailure === null && (status.lastSuccess !== null || status.lastAttempt === null);
          health.setAttribute("data-state", healthy ? "backup-ok" : "backup-warn");
          health.appendChild(el("strong", { text: healthy ? "Backup: healthy" : "Backup: needs attention" }));
          health.appendChild(
            el("span", {
              text:
                protection + (status.lastAttempt !== null ? `, last run ${status.lastAttempt.outcome}` : ", never run"),
            }),
          );
        })
        .catch(() => {
          if (!health.isConnected) return;
          health.setAttribute("data-state", "backup-warn");
          health.appendChild(el("strong", { text: "Backup: unknown" }));
          health.appendChild(el("span", { text: "the status endpoint is unavailable" }));
        });
      view().appendChild(counts);
      view().appendChild(el("h3", { text: "Recent updates" }));
      if (result.body.data.handoffs.length === 0) {
        view().appendChild(emptyState("No Handoffs yet; compose one from the Compose tab."));
        return;
      }
      const recent = el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [el("th", { text: "Updated" }), el("th", { text: "Title" }), el("th", { text: "State" })]),
        ]),
      ]);
      const body = el("tbody", {});
      result.body.data.handoffs.slice(0, 10).forEach((handoff) => {
        body.appendChild(
          el("tr", {}, [
            el("td", {}, [timeNode(handoff.updatedAt || handoff.createdAt || "")]),
            el("td", {}, [el("a", { href: `#/handoff/${encodeURIComponent(handoff.id)}`, text: handoff.title })]),
            el("td", {}, [badge(handoff.reviewState)]),
          ]),
        );
      });
      recent.appendChild(body);
      view().appendChild(recent);
    })
    .catch(() => {
      if (!pending.isConnected) return;
      pending.remove();
      note("The dashboard could not load.");
    });
}
