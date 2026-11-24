import { type AppError, err, ok, type Result } from "./errors";
import { exchangeCount, exchangeInvalid, type ExchangeWaitPage, type ExchangeWaitResult } from "./exchanges";
import { isCanonicalUuid } from "./primitives/identity";
import { canonicalJson } from "./primitives/json";
import { sleepWithinDeadline } from "./primitives/polling";
import { sha256OfText } from "./primitives/validation";

export interface ExchangeHistoryCursor {
  version: 1;
  exchangeId: string;
  projectId: string;
  seq: number;
  projection: string;
}

export function exchangeProjection(state: string, members: string[]): string {
  return sha256OfText(canonicalJson([state, [...members].sort()]));
}

export function encodeExchangeHistoryCursor(cursor: ExchangeHistoryCursor): string {
  return Buffer.from(canonicalJson(cursor)).toString("base64url");
}

export function readExchangeHistoryCursor(
  token: string,
  exchangeId: string,
  projectId: string,
  lastSeq: number,
): Result<ExchangeHistoryCursor> {
  const invalid = () => err(exchangeInvalid("Supply a valid history cursor for this Exchange and acting Project."));
  if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return invalid();
  try {
    const cursor = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as ExchangeHistoryCursor;
    if (
      !cursor ||
      cursor.version !== 1 ||
      !isCanonicalUuid(cursor.exchangeId) ||
      cursor.exchangeId !== exchangeId ||
      cursor.projectId !== projectId ||
      !exchangeCount(cursor.seq) ||
      cursor.seq > lastSeq ||
      typeof cursor.projection !== "string" ||
      !/^[a-f0-9]{64}$/.test(cursor.projection) ||
      Object.keys(cursor).length !== 5 ||
      token !== encodeExchangeHistoryCursor(cursor)
    )
      return invalid();
    return ok(cursor);
  } catch {
    return invalid();
  }
}

interface ExchangePollOptions {
  cursor?: string | undefined;
  intervalSeconds: number;
  timeoutSeconds: number;
  now: () => number;
  sleep: (milliseconds: number) => void;
  poll: (cursor: string | undefined) => Result<ExchangeWaitPage>;
}

/** The caller opens and closes one coherent read per poll. The cursor is delivery progress only. */
export function waitForExchangeActivity(options: ExchangePollOptions): Result<ExchangeWaitResult> {
  const { intervalSeconds, timeoutSeconds, now, sleep, poll } = options;
  const deadline = now() + timeoutSeconds * 1_000;
  let cursor = options.cursor;
  let lastFailure: AppError | undefined;
  let lastPage: ExchangeWaitPage | undefined;
  for (;;) {
    const page = poll(cursor);
    if (page.ok) {
      if (page.value.stateChanged || page.value.messages.length) return ok({ ...page.value, timedOut: false });
      lastFailure = undefined;
      lastPage = page.value;
      cursor = page.value.cursor;
    } else if (page.error.code === "STORAGE_INSPECTION_UNAVAILABLE") {
      lastFailure = page.error;
    } else {
      return page;
    }
    if (!sleepWithinDeadline(deadline, now(), intervalSeconds * 1_000, sleep)) {
      if (lastFailure) return err(lastFailure);
      if (lastPage) return ok({ ...lastPage, timedOut: true });
    }
  }
}
