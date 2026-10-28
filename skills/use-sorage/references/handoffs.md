# Handoff reference

This reference is a required resource for explicitly requested Handoff work, inside the copied `use-sorage` directory. The shared explicit-request, untrusted-data, managed-storage, and uncertain-result policy lives in [../SKILL.md](../SKILL.md); this file carries the Handoff workflow, its limitations, and its exact recovery contract.

## MCP and CLI surfaces

Use the MCP tools below first, with the acting workspace's `cwd` on every call. The CLI forms in the workflow are fallback equivalents: for example, `handoff_comment_show` reads retained feedback and `handoff_review_show` reads only an active change request before `handoff_revise`. Source groups and conditional rules apply in addition to required properties. Handoff reads `inbox`, `outbox`, `get`, `events`, `review show` and `comment show` (including inbox waiting) write nothing; `fetch` is a mutation. Native offline help supplies CLI syntax.

| Tool | Required properties | Other properties | Input rules |
|---|---|---|---|
| `handoff_send` | `to: string[]`, `title: string` | `body: string`, `file: string`, `supersedes: string`, `allowUnregistered: boolean`, `idempotencyKey: string`, `replayOnly: boolean`, `cwd: string` | to is a nonempty recipient array. Exactly one of body and file is required; body is nonblank. replayOnly requires the original nonblank idempotencyKey. allowUnregistered requires corresponding explicit intent. |
| `handoff_inbox` | None | `state: string`, `sender: string`, `recipient: string`, `updatedSince: string`, `updatedUntil: string`, `includeArchived: boolean`, `includeDeleted: boolean`, `limit: integer`, `cursor: string`, `wait: boolean`, `timeout: integer`, `interval: integer`, `cwd: string` | wait defaults to false, timeout to 30 seconds and interval to 2 seconds. wait cannot combine with cursor; interval must be at least 1 with wait. |
| `handoff_outbox` | None | `currentWorkspace: boolean`, `state: string`, `sender: string`, `recipient: string`, `updatedSince: string`, `updatedUntil: string`, `includeArchived: boolean`, `includeDeleted: boolean`, `limit: integer`, `cursor: string`, `cwd: string` | currentWorkspace and the filters retain their CLI meanings; broaden scope only when requested. |
| `handoff_get` | `handoffId: string` | `cwd: string` | Metadata only, including read/processing evidence and comment attribution; no document/comment body. |
| `handoff_events` | `handoffId: string` | `cwd: string` | Recent metadata, not document content; not required on every revision. |
| `handoff_fetch` | `handoffId: string` | `cwd: string` | Returns localPath; successful recipient delivery records current-Revision reading and can set historical firstFetchedAt, without changing Row Version. This is not a covered read. |
| `handoff_review_show` | `handoffId: string` | `cwd: string` | Returns only the active change-request Note or null, without recording engagement. |
| `handoff_comment_show` | `handoffId: string` | `cwd: string` | Returns the retained recipient comment with body, purpose/activity, author and target Revision, including inactive/older feedback, or null; writes nothing. |
| `handoff_comment_set` | `handoffId: string`, `expectedRevision: integer`, `expectedRowVersion: integer` | `text: string`, `file: string`, `purpose: string`, `cwd: string` | Exactly one text/file source; purpose is general (default) or change_request. Only the recipient authors reports; an active request blocks general replacement. Files remain inside cwd. |
| `handoff_processing_start` | `handoffId: string`, `expectedRevision: integer`, `expectedRowVersion: integer` | `commentText: string`, `commentFile: string`, `cwd: string` | At most one optional general replacement, with files inside cwd. Reports work without implying reading or acceptance. |
| `handoff_processing_complete` | `handoffId: string`, `expectedRevision: integer`, `expectedRowVersion: integer` | `commentText: string`, `commentFile: string`, `cwd: string` | Same sources as start; direct completion is allowed, an active request blocks completion, repeated completion conflicts. |
| `handoff_review_set` | `handoffId: string`, `targetRevision: integer`, `expectedRowVersion: integer` | `text: string`, `file: string`, `cwd: string` | Exactly one of text and file is required. Supply the actually reviewed targetRevision and expectedRowVersion. |
| `handoff_review_withdraw` | `handoffId: string`, `expectedRowVersion: integer` | `cwd: string` | Withdraw the current recipient Note within the requested scope using the observed Row Version. |
| `handoff_revise` | `handoffId: string` | `body: string`, `file: string`, `noChange: boolean`, `reason: string`, `expectedRowVersion: integer`, `idempotencyKey: string`, `cwd: string` | Exactly one of body, file and noChange=true is required; reason is present exactly with noChange=true. Body is nonblank. Fresh mutation requires the reviewed expectedRowVersion, including no-change; it is syntactically optional only to replay an identical retained successful receipt. |
| `handoff_accept` | `handoffId: string`, `expectedRevision: integer`, `expectedRowVersion: integer` | `cwd: string` | Both expectedRevision and expectedRowVersion come from the state actually reviewed. |
| `handoff_decline` | `handoffId: string`, `reason: string`, `expectedRowVersion: integer` | `cwd: string` | reason is required; retain the reviewed expectedRowVersion. |
| `handoff_withdraw` | `handoffId: string` | `expectedRowVersion: integer`, `cwd: string` | Only before recipient fetch or review; preserve the observed version when supplied. |

## Checking boxes and waiting

For an inbox check, run `sorage inbox --json`; for an outbox check, run `sorage outbox --json`. Check both only when requested. Report the requested results: a check does not authorize comment/review reads, fetching Artifacts, processing start/complete, comment writes, revising documents, sending, reviewing, accepting, declining, or withdrawing Handoffs. An outbox item in `changes_requested` is information to report, not an obligation to interrupt other work.

When the user requests Handoff processing, perform the operations needed within that request. Revisions supersede older content through the review loop.

`sorage inbox --wait --timeout <seconds> --json` blocks until a new item arrives or the timeout elapses; use it only when the user explicitly requests waiting for an inbox item. Being idle alone is not a trigger. The deadline is measured from invocation. A retryable listing failure (`STORAGE_INSPECTION_UNAVAILABLE` or a read-side `CONTENT_MATERIALIZING`) is retried until that deadline; if it persists at the deadline, the wait returns that typed error with exit 75. An ordinary empty timeout exits 0 with `meta.timedOut: true` and an empty list. The wait returns only items that appeared after it began: an item created at or after invocation is new even when a retried seed lists it, and a known item's later state change does not wake the wait.

## Sending and uncertain send results

Before first send, retain a nonempty idempotency key, exact arguments/recipients/title/body or file bytes, supersedes, Installation and cwd/sender context, including authorized flags. Unlike Memo keys, legacy Handoff keys need not be UUIDs. Use `sorage config show --json` when needed for Installation identity.

After a timeout, lost/malformed response or other ambiguity, inspect only that original material and command with `--idempotency-key <original-key> --replay-only --json`. Ordinary same-key send can execute if its receipt is missing; never use it to resolve uncertainty. Missing original material means unknown outcome, not permission to fetch newer content, reconstruct inputs, replace the key/context, repair storage or repeat work.

An eligible receipt returns historical creation data with `replayed: true`, not current delivery, Handoff state or completed Artifact activation. `HANDOFF_REPLAY_UNAVAILABLE`/75, absent or expired receipts, conflict, restore loss, another Installation or a later error leaves the original outcome unknown. A miss cannot prove failure or cancel a late original. Same-Installation backup restore excludes operational receipts; unchanged identity and client time cannot establish receipt continuity. Preserve original material and diagnostic request ID/output; no recovery result grants a new send or repeated work. Current-state reads require the user's requested processing scope. A live `send`, `revise`, or `delete approve` result returned with a warning is committed; do not resend or repeat it. Only a warning about a post-commit physical activation, unlink, or completion step says that step is left for a later mutating process's startup recovery; other warnings, such as an inbox-marker refresh, logging, or cleanup, are contained advisories about derived or diagnostic state.

## Reading and processing a received Handoff

A request to inspect metadata, read a document or accept it does not authorize starting or completing the work described in it. A request covering actual work permits the required operations within that scope; report start when work starts and completion only with evidence that the authorized work finished.

Read current metadata with `sorage get <handoff-id> --json`; it includes the current `revision`, `rowVersion`, `read`, `processing` and body-free comment metadata. To read the actual document, use `sorage fetch <handoff-id> --json` and read its returned `localPath`. Successful recipient or explicit User-proxy delivery records reading of the acquired current Revision, without incrementing Row Version; sender fetch and metadata/comment/events reads do not. `firstFetchedAt` is historical and cannot prove a later Revision was read. Fetch does not start work, complete it or accept the document. Failed or superseded delivery cannot confirm a newer Revision.

New documents have `read.status: unconfirmed` and `processing.status: not_started`. Migrated/restored legacy evidence can be `unrecorded`: report it as unknown, never infer read or completion from fetch history or acceptance. Processing is independently `not_started`, `in_progress` or `completed`; it carries the current Revision and its own timestamps. Direct completion without start is allowed when the work is already verified. Neither start nor completion fabricates a read receipt or document acceptance. A changed document Revision resets reading/processing to unconfirmed/not_started; no-change resolution resets neither.

Only the recipient Project or an explicitly authorized User proxy authors comments and processing reports. MCP has no User-proxy assertion; never add CLI `--as-user` to bypass a recipient refusal. The sender discovers the result through requested metadata/comment reads and cannot reply in the comment slot. There is one current recipient comment, no thread or native history. Use `comment show` for its body, original purpose, activity, author and target Revision. Feedback whose target is older than the current document remains older feedback, not new instructions for that Revision.

For a general explanation, use `sorage comment set <handoff-id> --text "<report>" --purpose general --expected-revision <observed-revision> --expected-row-version <observed-row-version> --json`. It replaces the one current comment without changing processing or blocking acceptance. An explicit change request uses `--purpose change_request` or legacy `review set ... --target-revision <observed-revision> --expected-row-version <observed-row-version>` and enters `changes_requested`. `review show` and `hasReviewNote` expose only active requests; null/false does not mean no retained feedback. General reporting cannot replace an active request, and completion cannot bypass one. Start without replacement can coexist with it.

When actual work is authorized, use `sorage processing start <handoff-id> --expected-revision <observed-revision> --expected-row-version <observed-row-version> --json`, then retain the returned version for the next authorized step. After verifying the work, use `sorage processing complete <handoff-id> --expected-revision <observed-revision> --expected-row-version <observed-row-version> --comment-text "<verified result>" --json`. Start and complete each optionally replace the comment with general text using `--comment-text` or `--comment-file`, never both; omission retains it. Status plus replacement is atomic and increments Row Version once. Repeated start/complete or start after completion returns `PROCESSING_STATE_CONFLICT` without applying the replacement. Preserve the exact rejected proposal.

`accept <id> --expected-revision <n> --expected-row-version <n>` accepts only the exact document; a general comment does not block it. Accepted processing may remain not started or in progress even when `reviewNextActor` is null. Accepted bytes stay immutable. The recipient may start or complete authorized work after acceptance or archive while its processing state permits it; after completion, only general comment replacement remains available. Decline/withdrawal means stopped work, regardless of historical processing timestamps; never present it as ongoing or infer successful completion. Declining an active request retains its change-request purpose/body/author/target with `active: false`; a later explicitly authorized general replacement is allowed with current observations, without terminal review withdrawal/removal or a processing restart. General comments remain writable after acceptance, decline, withdrawal and archive; terminal change requests and tombstone reporting are forbidden.


## Worked MCP reporting loop

This example assumes an explicit request to read a known Handoff, verify `result.txt`, report progress/completion, and let its sender inspect the result. Recipient and sender calls belong to their respective authorized sessions, not permission to switch Project identity. Replace `handoff-id` and `/lab/recipient` or `/lab/sender` with actual identities/workspaces. Each block is a separate call. The shown Revision 1 and Row Versions 1–4 are example observations, never defaults.

1. Recipient reads metadata (`data.revision`/`data.rowVersion`), then fetches and reads `data.localPath`. Compare fetch's `data.handoff` observations with the metadata before acting; disagreement requires stopping. In this unchanged example both are Revision 1/Row Version 1. Fetch records reading without starting work.

```json
{"tool":"handoff_get","arguments":{"handoffId":"handoff-id","cwd":"/lab/recipient"}}
```

```json
{"tool":"handoff_fetch","arguments":{"handoffId":"handoff-id","cwd":"/lab/recipient"}}
```

2. When the authorized work starts, report it. Success returns `data.handoff.rowVersion: 2`; carry that actual value into the next authorized mutation.

```json
{"tool":"handoff_processing_start","arguments":{"handoffId":"handoff-id","expectedRevision":1,"expectedRowVersion":1,"cwd":"/lab/recipient"}}
```

3. A separate progress comment leaves processing in progress. Its successful `data.handoff.rowVersion` is 3.

```json
{"tool":"handoff_comment_set","arguments":{"handoffId":"handoff-id","text":"Checking result.txt.","purpose":"general","expectedRevision":1,"expectedRowVersion":2,"cwd":"/lab/recipient"}}
```

4. Read the authorized workspace file and verify its exact bytes. Here it contains `pending` followed by LF. Only after that verification, complete with the truthful replacement comment in one atomic mutation; success returns Row Version 4. This verifies existing bytes without changing the file or accepting the document.

```json
{"tool":"handoff_processing_complete","arguments":{"handoffId":"handoff-id","expectedRevision":1,"expectedRowVersion":3,"commentText":"Verified result.txt contains pending; no file changed.","cwd":"/lab/recipient"}}
```

5. Under its requested result-inspection scope, sender reads metadata and retained text. Processing is completed while document review remains awaiting recipient. Attribute the verification to the recipient's report; these reads do not independently verify its external work.

```json
{"tool":"handoff_get","arguments":{"handoffId":"handoff-id","cwd":"/lab/sender"}}
```

```json
{"tool":"handoff_comment_show","arguments":{"handoffId":"handoff-id","cwd":"/lab/sender"}}
```

Use the CLI equivalents below/above when MCP is unavailable and the selected CLI is compatible. A failed/conflicting call stops this success sequence: preserve the rejected proposal, never substitute refreshed observations to retry it. Lost reporting outcomes remain unknown under the next section; matching current text is not a receipt.

## Mandatory observations and uncertain report outcomes

Retain the caller's actual reviewed state and complete proposal before dispatch. Fresh `comment set` and `processing start/complete` require both `expectedRevision` and `expectedRowVersion`; legacy `review set` requires `targetRevision` and `expectedRowVersion`. `review withdraw`, User-only `review remove`, `revise` including no-change, and User-only `delete approve` require the observed current Row Version. Decline keeps its required Row Version; accept keeps both Revision and Row Version. Values are positive safe integers. An old comment's target Revision is attribution, not the current mutation's authorization token; withdrawal/removal/resolution uses the actually observed current Row Version.

Missing observations refuse a fresh mutation; the server never fills them from loaded state. Stale document/row observations return `REVISION_CONFLICT`/`ROW_VERSION_CONFLICT`, preserving the requested comment/status/events. Keep the exact proposed text/file/options/observations and report the conflict. Requested read-only investigation is allowed, but do not automatically refresh expectations, retry, overwrite newer feedback or repeat external work. Applying a proposal to changed instructions needs a new user decision.

Existing matching unexpired successful receipts for revise/deletion approval replay their original recorded outcome before current-state admission, even when a legacy original request omitted a now-mandatory observation. Preserve the original key/hash inputs rather than adding a default version to manufacture a match. An absent/expired receipt must satisfy fresh observations before any new mutation; syntactically optional revise/delete-approve observations exist only for this historical replay exception. Reporting adds no new receipts or replay-only mode. A timeout/lost result from comment/start/complete therefore stays unknown: preserve the original request and actual external-work evidence; requested current-state inspection cannot prove which ambiguous invocation committed. Never blindly retry, change expectations/key, invent completion or repeat work. Send recovery keeps the separate original-request replay-only rules above.

## Project unfinished-work protection

Project unbind confirmation counts each non-deleted recipient Handoff once in the union of open review (`awaiting_recipient`/`changes_requested`) and accepted known `not_started`/`in_progress` processing. Archive does not remove known unfinished work, and the last binding is protected. Accepted `completed` processing adds no pending contribution; accepted legacy `unrecorded` adds no invented work. Approved deletion removes its live contribution. These facts do not authorize unbind, archive, deletion or confirmation flags; those remain explicit CLI administration.

## Reading results and answering an active request as the sender

For requested sender-side processing, use `get` and `comment show` to discover results without authoring a reply. With an active request, use `get` → `sorage review show <handoff-id> --json` → `fetch` → `revise`. Revise a workspace copy with `--file <workspace-copy>` or inline `--body "<revised-text>"`; use `--no-change --reason "<why>"` only when the Note needs no content change. Each fresh revision, including no-change, uses the actually reviewed `--expected-row-version <n>`.

If fetch metadata disagrees in Revision or Row Version with the get snapshot associated with the Note you read, stop and preserve the proposal rather than adopting an unseen changed Note's version. Recipient fetch may record first engagement but never changes Revision/Row Version. Sender fetch returns `localPath` without setting `firstFetchedAt`; metadata get has no Note body. Read the returned Vault or inline-cache path, copy it into the workspace before editing, and never edit the managed original. `sorage events <handoff-id> --json` reconstructs recent metadata and is not required on every revision. Conflict handling follows the mandatory-observation rules above.

Withdraw only what the recipient has neither fetched nor engaged with through review, comment or processing, with `sorage withdraw <handoff-id>`.

## Deletion decisions

A request to request deletion authorizes `sorage delete request <handoff-id>` only, with the observed row version when supplied; it does not authorize User approval. When reporting a deletion-request result or a deletion-approval decision or result, state the actual request or deletion status and explain that deletion is not secure erasure: Vault Git history and backups may retain document or Note content. A pending request is not approval or deletion. Never delete Git history, backups or other retained files as an implied extension of the request.

Native approval is a separate administrative intent: `sorage delete approve <handoff-id> --as-user --confirm` with the mandatory observed `--expected-row-version` for a fresh mutation. It tombstones the Handoff and removes managed current content. Preserve the Handoff and Project identities. A pinned Handoff also needs a distinct explicit user decision that addresses the pin itself before adding `--confirm-pinned <handoff-id>`: the decision must itself state, in the user's own words, that this exact Handoff is pinned and is to be deleted anyway — any words that say that suffice, with no specific wording required. A deletion approval that names the Handoff but does not address its pinned state is an ordinary approval, and an approval that follows the agent's own report of the pin while again only naming the Handoff is still an ordinary approval, so the agent asks again rather than treating it as the answer; neither such an approval, a blanket confirmation nor a recovery hint supplies that decision, so report the pin and ask. Read current state and report missing authority instead of escalating flags.

## Handoff storage

New Handoff text may stay inline in SQLite under the shared content bound stated in [../SKILL.md](../SKILL.md); larger text and binary bodies use Vault files under `artifacts/<handoff-id>/<artifact-id>/<stored-name>`. Existing file-backed Artifacts keep their recorded files. The public `storageKey` is always present and can be `null`. Read the `localPath` returned by `fetch` instead of constructing a path from that key. Inline fetch uses a derived read-only file under `state/fetch-cache/`, which is not authoritative or part of Vault backup. Authoritative corruption is reported as `ARTIFACT_CORRUPTED` by the relevant accept, revise and deletion-approval integrity checks; `sorage vault verify --json` instead reports detected inconsistencies in its findings (`blocking: true`, exit 1); by default `fetch` does not re-verify Vault-file digests (`verifyChecksumOnFetch` is off by default), while inline authoritative bodies and fetch-cache acquisition carry their own checksum validation, so detection is not guaranteed at an earlier read. The inline fetch cache is derived and recreatable: a bad or missing cache file is replaced, never adopted, and a fabricated file is never treated as authoritative.

The `.sorage/INBOX.md` marker that appears in your working directory when the installation enables `handoff.inboxMarker` is derived: during a requested broker operation, read it as a hint if it helps, never as authority, and never edit it. Its presence does not trigger a broker operation. Do not remove it as a repair shortcut.
