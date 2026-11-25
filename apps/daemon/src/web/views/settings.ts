import { api } from "../api";
import { el, view } from "../dom";
import type { ConfigSnapshot } from "../types";

export function settings() {
  view().replaceChildren();
  view().appendChild(el("h2", { text: "Settings" }));
  const path = el("p", { class: "muted", text: "" });
  const yaml = el("pre", { class: "preview", text: "Loading…" });
  const form = el("form", {});
  const pageSize = el("input", { type: "number", min: "1" });
  const marker = el("select", {}, [
    el("option", { value: "false", text: "off" }),
    el("option", { value: "true", text: "on" }),
  ]);
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Default page size " }, [pageSize])]));
  form.appendChild(el("p", { class: "field" }, [el("label", { text: " Inbox marker " }, [marker])]));
  const saveNote = el("p", { class: "muted", text: "" });
  form.appendChild(el("button", { class: "primary", type: "submit", text: "Save" }));
  form.appendChild(saveNote);
  // The form saves against the ETag it was loaded with: a save after an
  // out-of-band write conflicts instead of silently overwriting (CFG-019).
  let loadedEtag: string | null = null;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (loadedEtag === null) {
      saveNote.textContent = "The configuration has not loaded.";
      return;
    }
    api<ConfigSnapshot>("/api/v1/config", {
      method: "PUT",
      headers: { "if-match": loadedEtag, "content-type": "application/json" },
      body: JSON.stringify({ key: "ui.defaultPageSize", value: pageSize.value }),
    }).then((saved) => {
      if (!saved.body.ok) {
        saveNote.textContent = `Save failed: ${saved.body.error.code}`;
        return;
      }
      loadedEtag = saved.body.data.etag;
      // The inbox-marker toggle saves under the same loaded basis; its failure
      // is reported without undoing the page-size save.
      api<ConfigSnapshot>("/api/v1/config", {
        method: "PUT",
        headers: { "if-match": loadedEtag, "content-type": "application/json" },
        body: JSON.stringify({ key: "handoff.inboxMarker", value: marker.value }),
      }).then((second) => {
        if (second.body.ok) {
          loadedEtag = second.body.data.etag;
          saveNote.textContent = "Saved.";
        } else {
          saveNote.textContent = `Saved the page size; the marker save failed: ${second.body.error.code}`;
        }
      });
    });
  });
  view().appendChild(form);
  const yamlCard = el("div", { class: "card" });
  yamlCard.appendChild(el("h3", { text: "Canonical configuration (read-only)" }));
  yamlCard.appendChild(path);
  yamlCard.appendChild(yaml);
  view().appendChild(yamlCard);
  api<ConfigSnapshot>("/api/v1/config").then((result) => {
    if (!result.body.ok) {
      yaml.textContent = "Configuration could not load.";
      return;
    }
    path.textContent = result.body.data.configFile;
    yaml.textContent = result.body.data.yaml;
    pageSize.value = String(result.body.data.config.ui.defaultPageSize);
    marker.value = String(result.body.data.config.handoff.inboxMarker);
    loadedEtag = result.body.data.etag;
  });
}
