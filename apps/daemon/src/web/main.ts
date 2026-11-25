import { enterSessionOrRoute, store } from "./api";
import { el, note, view } from "./dom";
import { decodeHashSegment } from "./hash";
import { memoRenderRecovery } from "./memos/recovery";
import { memoDetail, memoList, resetMemoViewState } from "./memos/views";
import { backupPage } from "./views/backup";
import { compose } from "./views/compose";
import { dashboard } from "./views/dashboard";
import { diagnostics } from "./views/diagnostics";
import { deletionRequests, detail, listing } from "./views/handoffs";
import { projects } from "./views/projects";
import { settings } from "./views/settings";

export function route() {
  resetMemoViewState();
  memoRenderRecovery();
  if (store.token === null) {
    view().replaceChildren(el("p", { text: "Run sorage web to open this page with a one-time session secret." }));
    return;
  }
  note("");
  const hash = location.hash.replace(/^#/, "") || "/dashboard";
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  if (path === "/" || path === "/dashboard") dashboard();
  else if (path === "/projects") projects();
  else if (path === "/memos") memoList();
  else if (path.indexOf("/memo/") === 0) memoDetail(decodeHashSegment(path.slice("/memo/".length)));
  else if (path === "/compose") compose();
  else if (path === "/inbox") listing("inbox");
  else if (path === "/outbox") listing("outbox");
  else if (path === "/deletion-requests") deletionRequests();
  else if (path.indexOf("/handoff/") === 0) detail(decodeHashSegment(path.slice("/handoff/".length)));
  else if (path === "/diagnostics") diagnostics();
  else if (path === "/backup") backupPage();
  else if (path === "/settings") settings();
  else dashboard();
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.getAttribute("href") === `#${path}`;
    link.className = active ? "active" : "";
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

if (typeof window !== "undefined") {
  enterSessionOrRoute(route, note);
  window.addEventListener("hashchange", () => enterSessionOrRoute(route, note));
}
