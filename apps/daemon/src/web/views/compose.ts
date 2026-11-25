import { store } from "../api";
import { el, view } from "../dom";
import type { ApiEnvelope, DispatchResult } from "../types";

export function compose() {
  view().replaceChildren();
  view().appendChild(el("h2", { text: "New Handoff" }));
  const form = el("form", {});
  const title = el("input", { placeholder: "title", size: "40" });
  const recipients = el("input", { placeholder: "recipient slugs, comma-separated", size: "40" });
  const file = el("input", { type: "file" });
  const body = el("textarea", { rows: "8", cols: "40", placeholder: "Markdown body", "aria-label": "Body" });
  const result = el("p", {});
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Title " }, [title])]));
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "To " }, [recipients])]));
  form.appendChild(
    el("p", {
      class: "muted",
      text: "Several recipients create one independent Handoff each; every identifier and the shared dispatch group appear after submission.",
    }),
  );
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Document " }, [file])]));
  form.appendChild(el("p", { class: "field" }, [el("label", { text: "Body " }, [body])]));
  form.appendChild(
    el("p", { class: "muted", text: "Supply a file or a Markdown body, not both. The sender is the User." }),
  );
  form.appendChild(el("button", { class: "primary", type: "submit", text: "Send" }));
  form.appendChild(result);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const attachment = file.files?.[0];
    const hasFile = attachment !== undefined;
    const hasBody = body.value.trim() !== "";
    if (hasFile && hasBody) {
      result.textContent = "Choose a file or a Markdown body, not both.";
      return;
    }
    if (!hasFile && !hasBody) {
      result.textContent = "Choose a document or enter a Markdown body.";
      return;
    }
    const data = new FormData();
    data.append("title", title.value);
    recipients.value
      .split(",")
      .map((slug) => slug.trim())
      .filter((slug) => slug !== "")
      .forEach((slug) => {
        data.append("to", slug);
      });
    if (hasFile) data.append("file", attachment);
    else data.append("body", body.value);
    fetch("/api/v1/handoffs/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${store.token}` },
      body: data,
    })
      .then((response) => response.json())
      .then((outcome: ApiEnvelope<DispatchResult>) => {
        if (!outcome.ok) {
          result.textContent = `Send failed: ${outcome.error.code}`;
          return;
        }
        result.textContent = "";
        const list = el("ul", {});
        outcome.data.handoffs.forEach((sent) => {
          list.appendChild(
            el("li", {}, [
              el("span", { class: "mono", text: sent.handoffId }),
              el("span", {
                text: ` → ${sent.recipientSlug} (group ${outcome.data.dispatchGroupId || "none"})`,
              }),
            ]),
          );
        });
        result.appendChild(list);
      });
  });
  view().appendChild(form);
}
