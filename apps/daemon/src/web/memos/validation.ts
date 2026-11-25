import type { MemoInput, MemoMetadata, MemoOperation } from "../types";

export function memoUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function memoBytes(text: string) {
  return new TextEncoder().encode(text).length;
}

export function memoText(text: unknown, limit: number): text is string {
  if (typeof text !== "string" || memoBytes(text) > limit || text.indexOf("\0") !== -1) return false;
  for (const scalar of text) {
    const code = scalar.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

export function memoBodyText(value: unknown, cap: number | null): value is string {
  if (typeof value !== "string" || value.indexOf("\0") !== -1) return false;
  for (const scalar of value) {
    const code = scalar.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return cap === null || memoBytes(value) <= cap;
}

export function memoTitle(text: unknown): text is string {
  return (
    memoText(text, 800) &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Memo titles reject these control characters.
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text) &&
    Array.from(text.trim()).length > 0 &&
    Array.from(text.trim()).length <= 200
  );
}

export function memoVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function memoTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function memoObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function memoKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return memoObject(value) && Object.keys(value).every((key) => keys.indexOf(key) !== -1);
}

export function memoMetadata(value: unknown): value is MemoMetadata {
  return (
    memoObject(value) &&
    typeof value.origin === "string" &&
    value.origin.length <= 200 &&
    memoUuid(value.installationId) &&
    memoUuid(value.key) &&
    memoUuid(value.projectId) &&
    (value.memoId === null || memoUuid(value.memoId)) &&
    typeof value.operation === "string" &&
    ["add", "update", "done", "dismiss", "reopen"].includes(value.operation) &&
    memoTitle(value.title) &&
    memoTime(value.firstAttemptAt)
  );
}

export function memoInputValid(
  operation: MemoOperation,
  input: unknown,
  projectId: string,
  memoId: string | null,
  cap: number | null,
): input is MemoInput {
  if (!memoObject(input) || !memoUuid(projectId)) return false;
  if (operation === "add")
    return (
      memoId === null &&
      memoKeys(input, ["projectId", "title", "body"]) &&
      input.projectId === projectId &&
      memoTitle(input.title) &&
      memoBodyText(input.body, cap)
    );
  if (!memoUuid(memoId) || !memoVersion(input.expectedRowVersion)) return false;
  if (operation === "update") {
    if (
      !memoKeys(input, ["title", "body", "expectedRowVersion"]) ||
      (input.title === undefined && input.body === undefined)
    )
      return false;
    if (input.title !== undefined && !memoTitle(input.title)) return false;
    if (input.body !== undefined && !memoBodyText(input.body, cap)) return false;
    return true;
  }
  return ["done", "dismiss", "reopen"].indexOf(operation) !== -1 && memoKeys(input, ["expectedRowVersion"]);
}

export function memoActor(value: unknown) {
  return memoKeys(value, ["kind", "id"]) && value.kind === "user" && value.id === null;
}
