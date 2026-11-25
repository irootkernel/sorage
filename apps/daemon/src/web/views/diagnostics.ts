import { api } from "../api";
import { badge, el, emptyState, loading, note, view } from "../dom";
import type { Diagnostic } from "../types";

export function diagnostics() {
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Diagnostics" }));
  const pending = loading("Loading the diagnostics…");
  view().appendChild(pending);
  const table = el("table", {}, [
    el("thead", {}, [
      el("tr", {}, [el("th", { text: "Check" }), el("th", { text: "Severity" }), el("th", { text: "Message" })]),
    ]),
  ]);
  const body = el("tbody", {});
  table.appendChild(body);
  api<{ checks: Diagnostic[] }>("/api/v1/diagnostics").then((result) => {
    if (!pending.isConnected) return;
    pending.remove();
    if (!result.body.ok) {
      note("Diagnostics could not load.");
      return;
    }
    if (result.body.data.checks.length === 0) {
      view().appendChild(emptyState("No diagnostics recorded."));
      return;
    }
    result.body.data.checks.forEach((check) => {
      body.appendChild(
        el("tr", {}, [
          el("td", {}, [el("span", { class: "mono", text: check.id })]),
          el("td", {}, [badge(check.severity)]),
          el("td", { text: check.message }),
        ]),
      );
    });
    view().appendChild(table);
  });
}
