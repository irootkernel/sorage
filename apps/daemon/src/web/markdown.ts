import { el } from "./dom";

export function renderMarkdownSafe(text: string) {
  // Build DOM nodes exclusively via el(..., { text }) (textContent); no raw
  // HTML from the document is ever parsed (WEB-006).
  const lines = String(text).split("\n");
  const container = el("div", {});
  let list: HTMLUListElement | null = null;
  lines.forEach((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (heading !== null) {
      list = null;
      container.appendChild(el(`h${(heading[1]?.length ?? 0) + 2}`, { text: heading[2] ?? "" }));
    } else if (bullet !== null) {
      if (list === null) {
        list = el("ul", {});
        container.appendChild(list);
      }
      list.appendChild(el("li", { text: bullet[1] ?? "" }));
    } else {
      list = null;
      container.appendChild(el("p", { text: line }));
    }
  });
  return container;
}
