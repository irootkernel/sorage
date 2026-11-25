import { api } from "../api";
import { el, loading, note, timeNode, view } from "../dom";
import type { BackupRun, BackupStatus } from "../types";

export function backupPage() {
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Backup" }));
  const pending = loading("Loading the backup status…");
  view().appendChild(pending);
  api<BackupStatus>("/api/v1/backup/status").then((result) => {
    if (!pending.isConnected) return;
    pending.remove();
    if (!result.body.ok) {
      note(`The backup status could not load: ${result.body.error.code}`);
      return;
    }
    const status = result.body.data;
    const remote = status.lastPush !== null;
    const protection = el("p", {}, [
      el("strong", { text: remote ? "Protection includes a remote." : "Protection is local-only." }),
      el("span", {
        text: remote
          ? " Commits are pushed to the configured remote after every run."
          : " Commits stay in this machine's Vault repository; enable a remote with sorage backup enable-push.",
      }),
    ]);
    view().appendChild(protection);
    if (status.schedule.enabled) {
      view().appendChild(
        el("p", {
          text:
            "The daily schedule runs at " +
            status.schedule.at +
            " in " +
            status.schedule.timezone +
            (status.nextDueAt !== null ? `; next due ${status.nextDueAt.replace("T", " ").slice(0, 19)}` : "") +
            ".",
        }),
      );
    } else {
      view().appendChild(
        el("p", { text: "The daily schedule is disabled; enable it with sorage backup enable --daily-at <HH:MM>." }),
      );
    }
    if (status.lastFailure !== null) {
      view().appendChild(
        el("p", {
          class: "warning",
          text:
            "The last backup run failed with " +
            String(status.lastFailure.failureCode) +
            " at " +
            String(status.lastFailure.startedAt).replace("T", " ").slice(0, 19) +
            ".",
        }),
      );
    }
    const table = el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Started" }),
          el("th", { text: "Trigger" }),
          el("th", { text: "Outcome" }),
          el("th", { text: "Snapshot" }),
          el("th", { text: "Commit" }),
          el("th", { text: "Push" }),
        ]),
      ]),
    ]);
    const body = el("tbody", {});
    // The runs themselves come from the history the status exposes; the
    // endpoint returns the five last-* projections, so the page lists the
    // recorded outcomes it names and points at status for the full history.
    const runs: BackupRun[] = [];
    const seenRunIds = new Set();
    (["lastAttempt", "lastSuccess", "lastCommit", "lastPush", "lastFailure"] as const).forEach((key) => {
      const row = status[key];
      if (!row) return;
      if (row.id !== null && row.id !== undefined) {
        if (seenRunIds.has(row.id)) return;
        seenRunIds.add(row.id);
      } else if (runs.indexOf(row) !== -1) {
        return;
      }
      runs.push(row);
    });
    runs.forEach((run) => {
      body.appendChild(
        el("tr", {}, [
          el("td", {}, [timeNode(run.startedAt)]),
          el("td", { text: String(run.triggeredBy) }),
          el("td", { text: String(run.outcome) }),
          el("td", { text: String(run.snapshotOutcome) }),
          el("td", {
            text:
              run.commitSha !== null
                ? `${String(run.commitOutcome)} (${String(run.commitSha).slice(0, 8)})`
                : String(run.commitOutcome),
          }),
          el("td", { text: String(run.pushOutcome) }),
        ]),
      );
    });
    table.appendChild(body);
    view().appendChild(el("h3", { text: "Recent runs" }));
    view().appendChild(table);
    view().appendChild(
      el("p", {
        class: "muted",
        text: "Restore is a bootstrap command: stop the daemon and run sorage backup restore --from <vault-path> --dry-run --as-user first.",
      }),
    );
    view().appendChild(
      el("p", {
        class: "muted",
        text: "Deleting a Handoff removes its current file only; prior Git commits may retain earlier content, and Sorage offers no history purge.",
      }),
    );
  });
}
