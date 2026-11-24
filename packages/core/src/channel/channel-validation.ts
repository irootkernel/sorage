import { CONTENT_INLINE_MAX_UTF8_BYTES } from "../content/content";
import { utf8ByteLength } from "../primitives/validation";
import { appError, err, ok, type Result } from "../shared/errors";
import { invalid } from "./channel-internal";
import {
  type AcceptedChannelBody,
  CHANNEL_HANDLE_BYTES,
  CHANNEL_HANDLE_SCALARS,
  CHANNEL_NAME_BYTES,
  CHANNEL_NAME_SCALARS,
  CHANNEL_NOTE_BYTES,
  CHANNEL_REF_BYTES,
  CHANNEL_REF_SCALARS,
  CHANNEL_TITLE_BYTES,
  CHANNEL_TITLE_SCALARS,
  isChannelUuid,
} from "./channel-model";

// ---------------------------------------------------------------------------
// Bounds validation (interface section 38.3)

function isSingleLineWellFormed(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && !/[\p{Cc}\u2028\u2029]/u.test(value);
}

/**
 * A Channel name: a single line of 1 to 64 scalars and at most 256 UTF-8
 * bytes, control-free and never trimmed because it is an identity, unique
 * under exact case-sensitive comparison; a UUID-shaped name is refused because
 * the UUID is the other addressing form (CHN-002).
 */
export function validateChannelName(value: unknown): Result<string> {
  if (!isSingleLineWellFormed(value)) {
    return invalid("Channel name must be valid single-line Unicode text");
  }
  const name = value as string;
  if (name.length === 0 || [...name].length > CHANNEL_NAME_SCALARS || utf8ByteLength(name) > CHANNEL_NAME_BYTES) {
    return invalid("Channel name must contain 1 to 64 scalars and at most 256 UTF-8 bytes");
  }
  if (isChannelUuid(name)) {
    return invalid("A Channel name must not be UUID-shaped; the UUID addresses an existing Channel");
  }
  return ok(name);
}

/**
 * A participant handle: a single line of 1 to 64 scalars and at most 256 UTF-8
 * bytes, control-free and never trimmed because it is an identity, unique
 * within its Channel under exact comparison (section 38.3). The only empty
 * handle is the empty string: a blank-looking handle built from whitespace or
 * a lone byte-order mark is nonempty and stays byte-exact.
 */
export function validateChannelHandle(value: unknown): Result<string> {
  if (!isSingleLineWellFormed(value)) {
    return invalid("Participant handle must be valid single-line Unicode text");
  }
  const handle = value as string;
  if (
    handle.length === 0 ||
    [...handle].length > CHANNEL_HANDLE_SCALARS ||
    utf8ByteLength(handle) > CHANNEL_HANDLE_BYTES
  ) {
    return invalid("Participant handle must contain 1 to 64 scalars and at most 256 UTF-8 bytes");
  }
  return ok(handle);
}

/** A Channel title: null at creation, else a trimmed single line of 1 to 200 scalars and at most 800 UTF-8 bytes. */
export function normalizeChannelTitle(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (!isSingleLineWellFormed(value)) {
    return invalid("Channel title must be valid single-line Unicode text");
  }
  const title = value.trim();
  if (title.length === 0 || [...title].length > CHANNEL_TITLE_SCALARS || utf8ByteLength(title) > CHANNEL_TITLE_BYTES) {
    return invalid("Channel title must contain 1 to 200 scalars and at most 800 UTF-8 bytes");
  }
  return ok(title);
}

/**
 * A `--ref` reference: null when absent, else a trimmed single line of 1 to
 * 200 scalars and at most 800 UTF-8 bytes without control characters,
 * recorded verbatim as untrusted data (CHN-004).
 */
export function validateMessageRef(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (!isSingleLineWellFormed(value)) {
    return invalid("Message reference must be valid single-line Unicode text");
  }
  const reference = (value as string).trim();
  if (
    reference.length === 0 ||
    [...reference].length > CHANNEL_REF_SCALARS ||
    utf8ByteLength(reference) > CHANNEL_REF_BYTES
  ) {
    return invalid("Message reference must contain 1 to 200 scalars and at most 800 UTF-8 bytes");
  }
  return ok(reference);
}

/** A handling note: at most 8,000 UTF-8 bytes of verbatim text; null means no note was supplied. */
export function validateHandleNote(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string" || !value.isWellFormed()) {
    return invalid("Handling note must be valid Unicode text");
  }
  if (utf8ByteLength(value) > CHANNEL_NOTE_BYTES) {
    return invalid("Handling note must carry at most 8,000 UTF-8 bytes");
  }
  return ok(value);
}

/**
 * The Channel body's domain rule beyond the shared exact-bytes text rules: the
 * body must be nonempty after trimming and at most the shared accepted-body
 * bound, while the stored bytes stay the exact accepted bytes — trim never
 * rewrites them (CHN-004, SHR-002).
 */
export function checkChannelBodyText(text: string, maxBytes: number): Result<void> {
  if (text.includes("\0")) return invalid("Channel message body must not contain NUL");
  if (text.trim().length === 0) return invalid("Channel message body must be nonempty after trimming");
  if (utf8ByteLength(text) > maxBytes) {
    return err(
      appError(
        "CHN_TOO_LARGE",
        `The Channel body crossed the accepted bound artifact.maxBytes ${String(maxBytes)} bytes`,
        {
          maxBytes,
          sizeBytes: utf8ByteLength(text),
        },
      ),
    );
  }
  return ok(undefined);
}

/** True when the accepted body routes to the Vault's shared content store rather than inline text (SHR-005). */
export function channelBodyRoutesFile(accepted: AcceptedChannelBody): boolean {
  return accepted.sizeBytes > CONTENT_INLINE_MAX_UTF8_BYTES;
}
