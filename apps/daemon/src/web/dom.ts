import type { DomAttributes } from "./types";

export const REVIEW_STATES = ["awaiting_recipient", "changes_requested", "accepted", "declined", "withdrawn"];
const BADGE_TONES: Record<string, string> = {
  awaiting_recipient: "awaiting",
  changes_requested: "changes",
  accepted: "accepted",
  declined: "declined",
  withdrawn: "withdrawn",
  ok: "accepted",
  warning: "changes",
  blocking: "declined",
  active: "awaiting",
  archived: "withdrawn",
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes?: DomAttributes,
  children?: readonly Node[],
): HTMLElementTagNameMap[K];
export function el(tag: string, attributes?: DomAttributes, children?: readonly Node[]): HTMLElement;
export function el(tag: string, attributes?: DomAttributes, children?: readonly Node[]) {
  const node = document.createElement(tag);
  Object.entries(attributes ?? {}).forEach(([key, value]) => {
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  });
  (children || []).forEach((child) => {
    node.appendChild(child);
  });
  return node;
}

export function view() {
  return document.getElementById("view") as HTMLElement;
}

export function note(text: string) {
  (document.getElementById("session-note") as HTMLElement).textContent = text;
}

export function badge(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return el("span", { class: `badge badge-${BADGE_TONES[text] || "neutral"}`, text: text });
}

function pad2(value: number) {
  return (value < 10 ? "0" : "") + value;
}

export function timeNode(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  if (raw === "") return el("span", { text: "" });
  const parsed = new Date(raw);
  const text = Number.isNaN(parsed.getTime())
    ? raw.replace("T", " ").slice(0, 19)
    : parsed.getFullYear() +
      "-" +
      pad2(parsed.getMonth() + 1) +
      "-" +
      pad2(parsed.getDate()) +
      " " +
      pad2(parsed.getHours()) +
      ":" +
      pad2(parsed.getMinutes());
  return el("span", { class: "time", text: text, title: raw.replace("T", " ").slice(0, 19) });
}

export function loading(text: string) {
  return el("p", { class: "loading", text: text });
}

export function emptyState(text: string) {
  return el("div", { class: "empty", role: "status", text: text });
}
