import type { ApiResult, Handoff, HandoffPage, HandoffPageResult } from "./types";

export const store: { token: string | null; as?: string } = { token: null };
try {
  store.token = sessionStorage.getItem("sorage-session");
} catch {
  store.token = null;
}

export function api<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const options: RequestInit = Object.assign({}, init || {});
  options.headers = Object.assign({ authorization: `Bearer ${store.token}` }, init?.headers || {});
  return fetch(path, options).then((response) =>
    response.json().then((body) => ({ status: response.status, body: body })),
  );
}

export function fetchAllHandoffs(baseUrl: string, isStale?: () => boolean): Promise<HandoffPageResult> {
  const all: Handoff[] = [];
  const seen = new Set();
  const seenCursors = new Set();
  function nextPage(cursor: string | null): Promise<HandoffPageResult> {
    if (isStale?.()) return Promise.resolve({ stale: true });
    const url = cursor ? `${baseUrl}&cursor=${encodeURIComponent(cursor)}` : baseUrl;
    return api<HandoffPage>(url).then((result) => {
      if (isStale?.()) return { stale: true };
      if (result.status !== 200 || !result.body.ok) return result;
      const data = result.body?.data ? result.body.data : { handoffs: [], nextCursor: null };
      const pageItems = Array.isArray(data.handoffs) ? data.handoffs : [];
      pageItems.forEach((handoff) => {
        if (!seen.has(handoff.id)) {
          seen.add(handoff.id);
          all.push(handoff);
        }
      });
      if (data.nextCursor && !seenCursors.has(data.nextCursor) && pageItems.length > 0) {
        seenCursors.add(data.nextCursor);
        return nextPage(data.nextCursor);
      }
      return { status: 200, body: { ok: true, data: { handoffs: all, nextCursor: null } } };
    });
  }
  return nextPage(null);
}

export function enterSessionOrRoute(route: () => void, note: (text: string) => void) {
  const fragment = location.hash.match(/[#&]s=([^&]+)/);
  if (fragment === null) {
    route();
    return;
  }
  // A fresh fragment can reauthenticate this same tab after a daemon restart
  // without throwing away its Memo recovery record or unsaved drafts.
  history.replaceState(null, "", location.pathname);
  fetch("/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: fragment[1] }),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { data: { token: string } } | null) => {
      if (body !== null) {
        store.token = body.data.token;
        try {
          sessionStorage.setItem("sorage-session", store.token);
        } catch (_error) {
          /* optional */
        }
      }
      route();
    })
    .catch(() => {
      note("Disconnected: session exchange failed. Run sorage web again.");
    });
}
