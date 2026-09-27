import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { appError, err, MEMO_BODY_BYTES, validateMemoBody, type Result } from "@sorage/core";

/** Import only the explicitly selected regular file; never spool or attach its content. */
export function readMemoBodyFile(path: string): Result<string> {
  let handle: number | undefined;
  try {
    const resolved = realpathSync(path);
    const before = statSync(resolved);
    if (!before.isFile()) return err(appError("MEMO_INVALID_INPUT", "Memo body file must be a readable regular file"));
    if (before.size > MEMO_BODY_BYTES) return err(appError("MEMO_TOO_LARGE", "Memo body file exceeds 65536 bytes"));
    handle = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      return err(appError("MEMO_INVALID_INPUT", "Memo body file changed while opening"));
    if (opened.size > MEMO_BODY_BYTES) return err(appError("MEMO_TOO_LARGE", "Memo body file exceeds 65536 bytes"));
    const bytes = Buffer.alloc(MEMO_BODY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MEMO_BODY_BYTES) return err(appError("MEMO_TOO_LARGE", "Memo body file exceeds 65536 bytes"));
    // A BOM is accepted body content, not a decoder directive to discard bytes.
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } catch {
      return err(appError("MEMO_INVALID_INPUT", "Memo body file must contain valid UTF-8"));
    }
    return validateMemoBody(body);
  } catch {
    return err(appError("MEMO_FILE_READ_FAILED", "The selected Memo body file could not be read"));
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
