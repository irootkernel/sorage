import { api, fetchAllHandoffs } from "../api";
import { badge, el, emptyState, loading, view } from "../dom";
import type { ProjectEntry } from "../types";

let projectsRender = 0;

export function projects() {
  const ticket = ++projectsRender;
  const stale = (payload: () => void) => {
    projectsRender !== ticket ? null : payload();
  };
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Projects" }));
  const status = el("p", { class: "muted", text: "" });
  const pending = loading("Loading the projects…");
  view().appendChild(pending);
  const table = el("table", {}, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Slug" }),
        el("th", { text: "Name" }),
        el("th", { text: "Bindings" }),
        el("th", { text: "State" }),
        el("th", { text: "Actions" }),
      ]),
    ]),
  ]);
  const body = el("tbody", {});
  table.appendChild(body);
  view().appendChild(status);
  view().appendChild(el("h3", { text: "Register a Project" }));
  const form = el("form", {});
  const name = el("input", { placeholder: "display name", size: "30" });
  const dir = el("input", { placeholder: "directory", size: "40" });
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Name " }, [name])]));
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Directory " }, [dir])]));
  form.appendChild(el("button", { class: "primary", type: "submit", text: "Register" }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    api<ProjectEntry>("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.value, dir: dir.value, asUser: true }),
    }).then((outcome) => {
      status.textContent = outcome.body.ok ? `Registered ${outcome.body.data.project.slug}` : outcome.body.error.code;
      projects();
    });
  });
  view().appendChild(form);
  api<ProjectEntry[]>("/api/v1/projects").then((result) => {
    stale(() => {
      if (!pending.isConnected) return;
      pending.remove();
      if (!result.body.ok) {
        status.textContent = "Projects could not load.";
        return;
      }
      if (result.body.data.length === 0) {
        view().insertBefore(emptyState("No Projects registered yet; register one below."), status);
        return;
      }
      result.body.data.forEach((entry) => {
        const project = entry.project;
        const row = el("tr", {}, [
          el("td", {}, [el("span", { class: "mono", text: project.slug })]),
          el("td", { text: project.displayName }),
          el("td", { text: String(entry.bindingCount) + (entry.unbound ? " (unbound)" : "") }),
          el("td", {}, [badge(project.status)]),
        ]);
        const cell = el("td", {});
        const rename = el("input", {
          placeholder: "new name",
          size: "18",
          "aria-label": `New name for ${project.slug}`,
        });
        const bindDir = el("input", {
          placeholder: "bind directory",
          size: "24",
          "aria-label": `Binding directory for ${project.slug}`,
        });
        function action(label: string, path: string | (() => string), init: RequestInit | (() => RequestInit)) {
          const button = el("button", { text: label });
          button.addEventListener("click", () => {
            // Path and body are built at click time so the row's inputs are read
            // live rather than captured empty at render.
            api(typeof path === "function" ? path() : path, typeof init === "function" ? init() : init).then(
              (outcome) => {
                status.textContent = outcome.body.ok ? `${label} done` : outcome.body.error.code;
                projects();
              },
            );
          });
          return button;
        }
        const encodedSlug = encodeURIComponent(project.slug);
        const renameButton = el("button", { text: "Rename" });
        renameButton.addEventListener("click", () => {
          if (rename.value === "") return;
          api(`/api/v1/projects/${encodedSlug}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: rename.value, asUser: true }),
          }).then(() => {
            projects();
          });
        });
        const rowActions = el("div", { class: "actions-row" });
        rowActions.appendChild(el("a", { href: `#/memos?projectId=${encodeURIComponent(project.id)}`, text: "Memos" }));
        rowActions.appendChild(renameButton);
        rowActions.appendChild(
          action("Bind", `/api/v1/projects/${encodedSlug}/bindings`, () => ({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dir: bindDir.value, asUser: true }),
          })),
        );
        rowActions.appendChild(
          action(
            "Unbind",
            () =>
              "/api/v1/projects/" +
              encodedSlug +
              "/bindings/x?dir=" +
              encodeURIComponent(bindDir.value) +
              "&confirm=true",
            {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ asUser: true }),
            },
          ),
        );
        rowActions.appendChild(
          action("Archive", `/api/v1/projects/${encodedSlug}/archive`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ asUser: true }),
          }),
        );
        rowActions.appendChild(
          action("Unarchive", `/api/v1/projects/${encodedSlug}/unarchive`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ asUser: true }),
          }),
        );
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
  const unregistered = el("ul", { class: "muted" });
  view().appendChild(unregistered);
  fetchAllHandoffs(
    "/api/v1/handoffs?asUser=true&includeArchived=true&limit=200",
    () => projectsRender !== ticket || !unregistered.isConnected,
  )
    .then((result) => {
      if ("stale" in result) return;
      stale(() => {
        if (!unregistered.isConnected) return;
        if (!result.body.ok) {
          unregistered.replaceChildren(el("li", { text: "Unregistered workspaces could not load." }));
          return;
        }
        const seen: Record<string, number> = Object.create(null);
        result.body.data.handoffs.forEach((handoff) => {
          if (handoff.senderKind !== "unregistered_workspace") return;
          const key = handoff.senderWorkspaceKey || handoff.senderPathSnapshot || "unknown";
          if (seen[key] !== undefined) {
            seen[key] += 1;
            return;
          }
          seen[key] = 1;
        });
        Object.keys(seen).forEach((key) => {
          unregistered.appendChild(el("li", { text: `${key} — ${seen[key]} sent Handoff(s); not a recipient` }));
        });
        if (Object.keys(seen).length === 0) unregistered.appendChild(el("li", { text: "None recorded." }));
      });
    })
    .catch(() => {
      stale(() => {
        if (!unregistered.isConnected) return;
        unregistered.replaceChildren(el("li", { text: "Unregistered workspaces could not load." }));
      });
    });
}
