/**
 * The CLI's plain-text usage sentences for the rules the MCP adapter mirrors
 * as its exit-2 admission layer (interface section 39's first clarification
 * paragraph). One source serves both surfaces: the CLI prints them after its
 * `sorage: ` prefix with exit 2, and the adapter's `-32602` answers carry the
 * same sentence, so a wording change can never drift between the two.
 */
export const SEND_TAKES_ONE_SOURCE = "send takes exactly one of --file or --body";
export const BODY_MUST_NOT_BE_EMPTY = "the --body text must not be empty";
export const SEND_REPLAY_ONLY_KEY = "send --replay-only requires the original nonempty --idempotency-key";
export const INBOX_WAIT_WHOLE_SECONDS = "inbox --wait polls at whole-second intervals; pass --interval 1 or more";
export const INBOX_WAIT_NO_CURSOR = "inbox --wait cannot combine with --cursor; a wait lists only new items";
export const REVIEW_SET_ONE_SOURCE = "review set takes exactly one of --text or --file";
export const REVISE_ONE_SOURCE = "revise takes exactly one of --body, --file or --no-change";
export const CHANNEL_WAIT_UNHANDLED_ONLY = "channel messages --wait lists only unhandled messages; remove --all";
export const CHANNEL_WAIT_WHOLE_SECONDS =
  "channel messages --wait polls at whole-second intervals; pass --interval 1 or more";
export const CHANNEL_WAIT_ONLY_OPTIONS = "channel messages --interval and --timeout apply only with --wait";
export const ACCEPT_REQUIRES_ROW_VERSION = "accept requires --expected-row-version <n>";
export const DECLINE_REQUIRES_ROW_VERSION = "decline requires --expected-row-version <n>";
