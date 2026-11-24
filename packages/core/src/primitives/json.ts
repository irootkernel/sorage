import { appError, err, ok, type Result } from "../shared/errors";
import { isPlainObject } from "./validation";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/** Sorts object keys lexicographically at every level and prints two-space JSON with a trailing LF. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** The one-line form `events.jsonl` uses: sorted keys, compact separators, LF-terminated. */
export function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(sortKeys(value))}\n`;
}

/** JSON.parse validates grammar first; this scan then checks decoded keys at every nesting level. */
export function parseUniqueSnapshotJson(text: string): Result<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(appError("VAULT_INTEGRITY_ERROR", "Snapshot JSON is invalid"));
  }
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const key: string = JSON.parse(text.slice(start, i + 1));
        const keys = stack[stack.length - 1];
        if (keys?.has(key)) return err(appError("VAULT_INTEGRITY_ERROR", "Snapshot contains duplicate JSON keys"));
        keys?.add(key);
      }
    }
  }
  return ok(value);
}
