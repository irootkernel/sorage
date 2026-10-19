import { createHash } from "node:crypto";
import { ok, type AppError, type Result } from "./errors";
import { utf8ByteLength } from "./content";

/**
 * The one canonical Memo request-hash composer (MEM-007, ADR-0032 plan): it
 * reproduces the legacy `sha256(JSON.stringify([operation, installationId,
 * {"kind":"user","id":null}, request]))` bytes exactly — fixed key orders with
 * the body field last — while feeding the body as a bounded byte stream, so a
 * Vault-routed body is hashed from its accepted bytes without materializing
 * the body string or the JSON envelope. The hash is computed once over the
 * accepted input and never recomputed, keeping every retry's identity stable.
 */

/** Streams the exact accepted body bytes through the sink in bounded chunks. */
export interface MemoBodyByteSource {
  stream(sink: (chunk: Uint8Array) => void): Result<void, AppError>;
}

export interface MemoBodyStreamOutcome {
  digest: string;
  bodyBytes: number;
}

/** The request shapes whose serialization the composer reproduces, body excluded. */
export type MemoHashRequest =
  | { kind: "add"; operation: "add"; installationId: string; projectId: string; title: string }
  | {
      kind: "update";
      operation: "update";
      installationId: string;
      id: string;
      projectId?: string;
      expectedRowVersion: number;
      title?: string;
    }
  | {
      kind: "state";
      operation: "done" | "dismiss" | "reopen";
      installationId: string;
      id: string;
      projectId?: string;
      expectedRowVersion: number;
    };

const ACTOR_JSON = JSON.stringify({ kind: "user", id: null });

/** The byte-local JSON string escaper: identical output to JSON.stringify for well-formed UTF-8 strings. */
function escapedBodyByte(byte: number): string {
  if (byte === 0x22) return '\\"';
  if (byte === 0x5c) return "\\\\";
  if (byte === 0x08) return "\\b";
  if (byte === 0x09) return "\\t";
  if (byte === 0x0a) return "\\n";
  if (byte === 0x0c) return "\\f";
  if (byte === 0x0d) return "\\r";
  return byte < 0x20 ? `\\u00${byte.toString(16).padStart(2, "0")}` : "";
}

/** Feeds one body chunk's JSON-escaped bytes into the hasher; multibyte bytes pass through untouched. */
function updateEscaped(hash: ReturnType<typeof createHash>, chunk: Uint8Array): void {
  let start = -1;
  for (let index = 0; index <= chunk.length; index++) {
    const byte = index < chunk.length ? (chunk[index] ?? -1) : -1;
    if (index < chunk.length && byte >= 0x20 && byte !== 0x22 && byte !== 0x5c) {
      if (start === -1) start = index;
      continue;
    }
    if (start !== -1) {
      hash.update(chunk.subarray(start, index));
      start = -1;
    }
    if (index < chunk.length && byte >= 0) hash.update(escapedBodyByte(byte));
  }
}

function updateJsonString(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(JSON.stringify(value));
}

function updateJsonNumber(hash: ReturnType<typeof createHash>, value: number): void {
  hash.update(JSON.stringify(value));
}

/**
 * Composes the exact legacy request digest. `body.present` mirrors the
 * normalized request's own `body` presence; when present, the source streams
 * the accepted body bytes and the digest counts them for the caller's
 * accepted-identity cross-check.
 */
export function composeMemoRequestDigest(
  request: MemoHashRequest,
  body: { present: false } | { present: true; source: MemoBodyByteSource },
): Result<MemoBodyStreamOutcome, AppError> {
  const hash = createHash("sha256");
  hash.update("[");
  updateJsonString(hash, request.operation);
  hash.update(",");
  updateJsonString(hash, request.installationId);
  hash.update(",");
  hash.update(ACTOR_JSON);
  hash.update(",{");
  let firstField = true;
  const field = (name: string, write: () => void): void => {
    if (!firstField) hash.update(",");
    firstField = false;
    updateJsonString(hash, name);
    hash.update(":");
    write();
  };
  if (request.kind === "add") {
    field("projectId", () => updateJsonString(hash, request.projectId));
    field("title", () => updateJsonString(hash, request.title));
  } else {
    field("id", () => updateJsonString(hash, request.id));
    // The legacy normalized request carried `projectId` for updates and state
    // operations alike whenever supplied; emit it for both kinds in the same
    // position, before the expected version.
    if (request.projectId !== undefined) field("projectId", () => updateJsonString(hash, request.projectId as string));
    field("expectedRowVersion", () => updateJsonNumber(hash, request.expectedRowVersion));
    if (request.kind === "update" && request.title !== undefined)
      field("title", () => updateJsonString(hash, request.title as string));
  }
  let bodyBytes = 0;
  if (body.present) {
    field("body", () => {
      hash.update('"');
    });
    const streamed = body.source.stream((chunk) => {
      bodyBytes += chunk.byteLength;
      updateEscaped(hash, chunk);
    });
    if (!streamed.ok) return streamed;
    hash.update('"');
  }
  hash.update("}]");
  return ok({ digest: hash.digest("hex"), bodyBytes });
}

/** The bounded byte source over an accepted in-memory text body. */
export function memoTextBodySource(text: string): MemoBodyByteSource {
  return {
    stream(sink) {
      // Slice by scalar boundaries so every chunk encodes independently and the
      // concatenation is exactly the whole string's UTF-8 encoding.
      const total = utf8ByteLength(text);
      let index = 0;
      let sent = 0;
      while (sent < total) {
        let end = index;
        let chunkBytes = 0;
        while (end < text.length && chunkBytes < 16 * 1024) {
          const scalar = text.codePointAt(end) as number;
          const width = scalar > 0xffff ? 2 : 1;
          const bytes = scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
          if (chunkBytes + bytes > 16 * 1024 && chunkBytes > 0) break;
          chunkBytes += bytes;
          end += width;
        }
        const piece = text.slice(index, end);
        sink(Buffer.from(piece, "utf8"));
        sent += chunkBytes;
        index = end;
      }
      return ok(undefined);
    },
  };
}
