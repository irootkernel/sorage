# Security and Reliability

## 1. Trust model

The MVP runs as one operating-system user on one machine, and every guarantee below is scoped to that assumption.

Sorage provides **logical workflow authorization**: it decides which actor may move a Handoff into which state, refuses moves that break the state machine, and records who acted in an append-only event ledger.

Sorage does not isolate processes that already run with the same user permissions, and it MUST NOT claim to (`SEC-013` in [required-specification.md](required-specification.md)). Any AI session with the same operating-system user can read the Vault, the database, and the API token directly.

Working-directory actor resolution is **provenance, not authorization** (CLI-017). It answers "where did this come from", so the event ledger and the inbox routing stay meaningful; it is not a permission check, and `FORBIDDEN_ACTOR` is a guardrail against acting from the wrong directory rather than a security boundary.

The honesty clause is normative and appears in the permission matrix of [../architecture/README.md](../architecture/README.md) and in the `--as-user` help text (SEC-021):

> User-admin rows express workflow intent; any process that can read the API token or run the CLI as this OS user can assert User context (see `SEC-013`).

### 1.1 What `--as-user` does and does not protect

| `--as-user` does | `--as-user` does not |
|---|---|
| Make administrative intent explicit, so an agent acting as a Project cannot approve a deletion by accident | Authenticate anybody; any process able to run `sorage` as this user can supply the flag |
| Record `actorKind = user` on the event, separating User-proxy actions from Project actions in the audit trail | Prevent a hostile local process from asserting User context |
| Fail closed with `USER_CONTEXT_REQUIRED` when a User-admin command is invoked without it (CLI-019) | Gate reading; every actor that can reach the installation can read it |
| Pair with `--confirm`, and with the distinct `--confirm-pinned <id>` argument for a pinned deletion (LIFE-012) | Replace operating-system permissions, keychain storage, or per-agent sandboxing |

The commands that require `--as-user` are `review remove`, `pin`, `unpin`, `archive`, `unarchive`, `delete approve`, `delete reject`, `config set`, `config edit`, `vault move`, `backup enable`, `backup disable`, `backup enable-push`, `backup disable-push`, `backup restore`, `token rotate`, and `uninstall` (CLI-019). `project archive` and `project unarchive` imply User context without a flag and record `actorKind = user` (CLI-024).

### 1.2 Project Memo boundary, milestone M7

[MEM-003](required-specification.md#18-project-memos) and [the Memo contract](project-memos.md) add implicit User provenance for explicit Memo operations without claiming human authentication or a sender/recipient boundary. Existing Handoff actor guards and destructive-operation approvals remain unchanged. The CLI must not discover other Projects on a failed implicit resolution, and the HTTP API must authenticate and validate Host before any Memo read.

A Memo body is untrusted text, even when written as a command or attributed to the User. Reading or storing it does not authorize execution, network access, commits, or deletion. No session-start scanning, stop hooks, automatic completion, or sibling-tool mutation is introduced. Safe Markdown rendering must not execute raw HTML, accept unsafe link schemes, or fetch remote images automatically.

Memo row changes, metadata-only events, and receipts use one existing fenced write transaction with compare-and-set. The normalized application/DB receipt is the only Memo replay authority; Memo HTTP handlers bypass the legacy raw-body response cache, not Host/authentication checks or request limits. Content stays out of logs and events, but intentional backup includes current free text. Structured path redaction does not sanitize paths or secrets inside that text. Closed Memos remain retained; prior Git snapshots may contain older bodies. A caller-declared done state is not external verification or erasure.

The [Memo Web pending gate](project-memos.md#10-web-behavior) must preserve one active original operation/key per tab before sending. Unknown responses are inspected only through replay-only, never execute fallback. The active gate remains until a matching receipt or conclusive original non-execution settles it, or the User explicitly abandons recovery under [section 10.1](project-memos.md#101-abandon-recovery-without-asserting-an-outcome). Abandonment must preserve a bounded nonblocking unknown-outcome notice and retire the active record in one local storage replacement before unlocking; it is not server cancellation, deletion, failure, success, or a replacement submission. Storage failure cannot unlock; navigation, expiry, or a title match cannot silently discard identity. Late responses must not clear a newer request. Keep notices and pending material out of logs, disclose their temporary same-tab lifetime and explicit retention controls, and leave reads, other tabs, and CLI independent.

Snapshot format 2 introduces verified Memo inventory and digests and must be implemented with migration/restore before public Memo writes. The [exact-byte and path rules](project-memos.md#111-canonical-bytes-digest-and-path-identity) require canonical UTF-8 files, SHA-256 over the raw bytes including the final LF, and UUID-derived keys relative to `snapshots/`; malformed, duplicate, escaping, symlinked, or mismatched inventory must not reach import. Format-1 backups retain their distinct field set and never silently acquire Memo semantics. The exact failure, restart, and rollback contract is [Memo backup and restore](project-memos.md#11-backup-restore-upgrade-and-rollback). Do not assume old binaries reject an upgraded database; stop old writers before upgrade and use a separate empty installation plus a verified older backup for rollback. Neither this design nor a process-restart test establishes live synchronization or empirical power-loss qualification.

## 2. Local network boundary, milestone M2

The daemon binds only to `127.0.0.1` or `::1`; the configuration enum admits no other value and a non-loopback bind address MUST be rejected (SEC-001, GEN-005).

Every request, including every `GET`, is checked against the Host allowlist `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` **before routing and before authentication**, and any other value is rejected with `HOST_NOT_ALLOWED` and HTTP 421 without reaching a handler (SEC-017).

The check has to precede routing because DNS rebinding defeats every later control: an attacker-controlled page whose hostname re-resolves to `127.0.0.1` issues same-origin requests from the browser's point of view, so CORS never applies and a CSRF token never enters the picture, and a plain `GET /api/v1/handoffs` would read every Handoff. The `Host` header is the only field that still carries the name the browser dialed, so comparing it to an allowlist of literal loopback authorities is what closes the read path (ADR-0017 in [../architecture-decision-records/README.md](../architecture-decision-records/README.md)).

The allowlist deliberately keeps the name `localhost`, which the bind enum does not, because the browser sends the name the User typed while the socket must still be a literal loopback address.

### 2.1 Browser session

Sorage uses no cookies anywhere, and no response ever sets one (SEC-019).

`sorage web` starts the daemon when it is not running and opens `http://127.0.0.1:<port>/#s=<one-time-secret>` (RUN-012); the fragment never leaves the browser, never appears in a request line, and never lands in the access log or in shell history.

The SPA exchanges the secret once at `POST /api/v1/session` for a session token, stores that token in `sessionStorage`, clears the fragment, and sends `Authorization: Bearer <session-token>` on every subsequent request; a second exchange of the same secret MUST fail with `UNAUTHENTICATED` and HTTP 401.

Direct navigation with no fragment and no session in `sessionStorage` MUST render a refusal and MUST NOT fetch data.

### 2.2 Response headers

Every daemon response, including error bodies, static assets, and Artifact content, carries the following headers (SEC-018):

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |

### 2.3 Why there are no CSRF tokens

CSRF exists to stop a third-party page from spending an **ambient** credential, and after SEC-019 there is no ambient credential left: the session token lives in `sessionStorage`, which is readable only by its own origin, and it must be attached deliberately by the SPA's own code.

A cross-origin page cannot read that token, and a request without the `Authorization` header is rejected with `UNAUTHENTICATED` regardless of where it came from, so the entire token-pair mechanism was removed rather than hardened (ADR-0017).

The residual attack the tokens never covered — a rebinding page that is, from the browser's view, same-origin — is handled by the Host allowlist of SEC-017 instead.

## 3. Tokens, milestone M2

| Property | Rule |
|---|---|
| Material | At least 32 random bytes from the platform CSPRNG, encoded base64url (SEC-020) |
| Location | `~/.sorage/state/api-token`, outside `config.yaml` (SEC-002, CFG-008) |
| Permissions | `0600`, restored after every write |
| Comparison | Constant time through `timingSafeEqual`, never `===` |
| Rotation | `sorage token rotate --as-user`, which emits `TOKEN_ROTATED` and invalidates every browser session immediately |
| Rejection | A missing `Authorization` header fails with `UNAUTHENTICATED` and HTTP 401; a presented token that is unknown, malformed, or rotated away fails with `TOKEN_INVALID` and HTTP 401 |
| Exposure | Never logged, never echoed in `--json` output, never included in an error body or a diagnostic bundle (SEC-010) |

After a rotation the CLI retries a failed **read** exactly once with the freshly read token file and reports `TOKEN_INVALID` if the retry also fails; a mutation is never retried and surfaces `TOKEN_INVALID` immediately, so a rotation that races a read is self-healing while a racing write stays visible instead of being replayed.

Browser sessions are not renewed silently: an invalidated session must go through `sorage web` again for a new one-time secret.

## 4. Path and file safety

Every user-supplied path is expanded, made absolute, and `realpath`-resolved before any check, and every check is then applied to the resolved path so that a symlink cannot smuggle a target past validation (SEC-006).

| Rule | Statement | Requirement |
|---|---|---|
| Managed-path escape | A resolved source or destination that leaves its allowed root is rejected; Vault and Project directory containment cycles are rejected | VLT-017 |
| Regular files only | Directories, sockets, named pipes, character devices, block devices, and unsupported symbolic-link chains are rejected as Artifacts | VLT-006, VLT-015, SEC-007 |
| Copy only | Import copies with bounded-memory streaming and never moves or deletes the source | VLT-004, VLT-005, NFR-005 |
| Size | The configured `artifact.maxBytes` limit is enforced while streaming and aborts mid-stream with `ARTIFACT_TOO_LARGE` | VLT-015 |
| Source scope | A file outside the resolved sender workspace requires `--allow-external-source` and otherwise fails with `SOURCE_OUTSIDE_WORKSPACE` | VLT-016 |
| Stored names | The stored name is sanitized while `originalName` keeps the name the User supplied, so traversal sequences and control characters never reach the filesystem | VLT-018 |
| Destination | The destination is `storageKey`, the sole path authority; it is never derived from user input, never reused, and destination symlinks are never followed | VLT-020 |
| Managed files | Imported Artifact files are made read-only where the filesystem supports it | VLT-008 |

Because `storageKey` embeds a fresh `artifact-id`, two imports can never collide on one path, and an in-place overwrite is structurally impossible (ADR-0013).

External processes are executed with an argument array and never through a shell string; `shell: true` and string concatenation into a command line are prohibited, and every invocation has a timeout and bounded output capture (SEC-004, SEC-005).

Every value written into the LaunchAgent plist is XML-escaped, including paths containing `&`, `<`, or quotation marks.

## 5. MIME and preview safety

The MIME type recorded for an Artifact comes from an **extension allowlist**; Sorage never sniffs content to decide how to serve it, and an extension outside the allowlist is recorded and served as `application/octet-stream`.

| Class | Serving rule |
|---|---|
| Default for every Artifact | `Content-Type: application/octet-stream` with `Content-Disposition: attachment` |
| `.md` and `.txt` | The only inline preview the Web UI offers (WEB-005) |
| `text/html`, SVG, and any other active format | Never rendered inline and never served with an inline disposition; metadata plus download or reveal only (WEB-006) |
| Unknown or unsupported binary | Metadata plus download or reveal, with no inline rendering (WEB-006) |

Markdown is rendered client-side from sanitized output with raw HTML disabled, under the CSP of section 2.2, so a Markdown Artifact cannot introduce script, an external fetch, or a frame; `object-src 'none'` and `frame-ancestors 'none'` remove the plugin and clickjacking paths (SEC-018, API-010).

Preview and download endpoints enforce Handoff ownership before streaming, and no endpoint exposes arbitrary filesystem browsing (API-009, API-010).

## 6. Storage integrity

### 6.1 Intent-log protocol

Create, fan-out, revise, and deletion approval commit their `pending_fs_ops` intents in the same transaction as the domain change, execute the filesystem work afterwards, and clear the intents in a second transaction; section 20 of [../architecture/README.md](../architecture/README.md) is the normative description and this section only states the consequences for reliability (VLT-021, ADR-0013).

A committed intent is a promise the database has already made, so any process that starts next is obliged to keep it, which is what makes several concurrent writer processes safe without a single-writer daemon (RUN-001, RUN-002).

A read of a Handoff whose current Artifact has `materialized = 0` returns `ARTIFACT_MATERIALIZING`; the row is real and the write is not lost, and the caller retries after the drain.

### 6.2 Durability order

Every Artifact write follows one order with no step reordered or skipped (VLT-022):

```text
write -> fsync(file) -> rename -> fsync(parent directory) -> commit that sets materialized = 1
```

Because Bun does not use libuv, the foundation milestone verifies empirically that the adapter's `fsync` reaches `F_FULLFSYNC` semantics on macOS rather than assuming it (ADR-0016).

### 6.3 Garbage collection

| Rule | Statement |
|---|---|
| Drain first | Garbage collection MUST NOT run until the `pending_fs_ops` drain has finished at this process start (RUN-002) |
| Grace window | A file under `artifacts/` is a candidate only when no row in the `artifacts` table names it and it is older than `gc.graceHours`, default 24 |
| Staging | `staging/` is swept by age, after the drain, and is excluded from Git by the Vault `.gitignore` |
| Absolute exclusion | GC never deletes a path that matches any `storageKey` or any pending intent, whatever its age |

### 6.4 Orphan classes

| Class | Shape | Handling |
|---|---|---|
| No row | A file under `staging/` or `artifacts/` that no `artifacts` row names, typically a crash before the intent commit or a compare-and-set loser whose transaction rolled back | Swept by GC after `gc.graceHours`; visible to `sorage vault verify` before that |
| Superseded or deleted Artifact | A previous current Artifact removed by revision or deletion approval | Its row is deleted in the domain transaction and its bytes are removed by the committed `unlink` intent; GC never owns this removal because the pending intent protects the path until completion (VLT-011) |

The asymmetry is deliberate: unlink is owned by the intent log so that removal is a recorded decision, and GC is a conservative backstop that can only remove bytes nothing has ever named.

### 6.5 Missing and Mismatched Artifacts

| Condition | Detection | Effect |
|---|---|---|
| Missing Artifact | The current Artifact's `storageKey` does not exist, or a drain found both source and destination gone | The Handoff is marked integrity-failed and `ARTIFACT_INTEGRITY_FAILED` is appended; a replacement file is never fabricated |
| Mismatched Artifact | The recomputed SHA-256 of the current Artifact differs from the recorded value | Handled exactly like a Missing Artifact and reported as `ARTIFACT_CORRUPTED` (VLT-023) |

Both conditions block `revise`, `accept`, backup success, and any deletion claim that depends on the bytes, while diagnostics, listing, and restore remain available; the next actor becomes the User (VLT-023).

### 6.6 Checksum verification points

`artifact.verifyChecksumOnFetch` defaults to `false` because `fetch` is the hot path for an AI session and rehashing an Artifact up to `artifact.maxBytes` on every fetch would add seconds to the most frequent operation, while the bytes are already protected by read-only stored files, the intent log, and the exhaustive and background sweeps below; setting it to `true` trades that latency for per-fetch certainty and is the right choice on a shared or network filesystem.

| Point | Coverage | Milestone |
|---|---|---|
| Daemon periodic sweep | Once the daemon exists it rehashes current Artifacts continuously in the background, bounded to 64 MiB of hashing per garbage-collection tick, with no configuration key | M2 |
| `sorage doctor` | Every live Handoff's current Artifact, exhaustively, reported as the `artifacts.checksums` check | M1 |
| `sorage vault verify` | Every current Artifact, plus orphan classes and Vault layout | M1 |
| `sorage backup verify` | Every current Artifact plus the `core.autocrlf` and `.gitattributes` checks of BKP-022 and VLT-024; a Handoff whose current Artifact has `materialized = 0` is skipped and reported as a warning without failing the run | M3 |
| `sorage backup restore` | Every restored Artifact; a mismatch fails the restore (BKP-021, SEC-014) | M3 |
| Every fetch | Only when `artifact.verifyChecksumOnFetch` is `true` | M1 |

## 7. Concurrency and locks

Correctness under several concurrent writer processes rests on three mechanisms, none of which counts processes (RUN-001).

Row Version compare-and-set is one statement whose affected-row count is the verdict, so the check and the write cannot separate:

```sql
UPDATE handoffs SET rowVersion = rowVersion + 1 WHERE id = ? AND rowVersion = ?;
```

Anything other than one changed row means another writer moved first, and the operation fails with `ROW_VERSION_CONFLICT` without retrying; an expected Row Version is the value the client currently holds, and reads, `fetch`, preview, and their events never increment it (HND-014, HND-025).

Operations that cannot be one transaction take an exclusive lockfile under `~/.sorage/run/`; each complete `{pid, startedAt, hostname}` record is written to a unique temporary file with `O_EXCL` and atomically published at the lock path with a hard link. The lock set is normative in section 19 of [../architecture/README.md](../architecture/README.md) and is restated here because the reliability claims of this document depend on it:

| Lockfile | Protects | Stale when | Milestone |
|---|---|---|---|
| `config.lock` | Configuration writes | The recorded pid is dead, or the lock is older than 30 seconds | M1 |
| `migration.lock` | Schema migration at process start | The recorded pid is dead | M1 |
| `vault-move.lock` | Vault relocation and, once restore exists, `backup restore` | The recorded pid is dead | M1 |
| `daemon.lock` | Single daemon instance | The recorded pid is dead | M2 |
| `backup.lock` | Scheduled and manual backup runs; a run that finds it held by a live process fails with `BACKUP_IN_PROGRESS` | The recorded pid is dead | M3 |
| `inbox-marker.lock` | Derived marker refresh and retired binding cleanup; contention retries for up to five seconds and then warns | The recorded pid is dead | M6 |

A stale lock may be broken by the next process; a live lock produces a conflict rather than a wait loop, except for the bounded retry of advisory marker work. A lock whose pid belongs to a different program is treated as live and reported rather than broken.

While `vault-move.lock` is held by a Vault move or, once restore exists, by `backup restore`, every other process attempting a domain mutation fails with `SERVICE_PAUSED` and recovery guidance, and the daemon returns the same code to API callers (RUN-014).

Each process opens exactly one write connection with WAL mode, foreign keys, and an explicit `busy_timeout`, so writes queue instead of interleaving.

`UnitOfWork.run` is synchronous, `run<T>(fn: (tx: Tx) => T): T`; `await` inside the callback is forbidden by lint because every candidate SQLite driver is synchronous and an awaited callback lets two logical transactions interleave on one connection, and filesystem I/O never happens inside a transaction (NFR-014, ADR-0013).

## 8. Idempotency

| Operation | Surface |
|---|---|
| Handoff creation | `sorage send --idempotency-key <uuid>` (CLI-021) and `POST /api/v1/handoffs/import-path` |
| Fan-out creation | The same call with several recipients; the whole Dispatch Group is one idempotent unit |
| Browser upload completion | `POST /api/v1/handoffs/upload` |
| Revise | `sorage revise --idempotency-key <uuid>` and `POST /api/v1/handoffs/{id}/revise` |
| Deletion approval | `sorage delete approve --idempotency-key <uuid>` and `POST /api/v1/handoffs/{handoffId}/deletion-approve` |
| Manual backup run | `sorage backup run --idempotency-key <uuid>` and `POST /api/v1/backup/run` |

Callers supply the key as the `Idempotency-Key: <uuid>` header or as `--idempotency-key <uuid>`, and the daemon and CLI store `key`, `scope` naming the operation, `requestHash`, `responseJson`, `createdAt`, and `expiresAt` in `idempotency_keys` with a 24-hour retention. The legacy execute behavior may treat an expired key as new. This does not apply to Memo replay-only recovery, which must never execute on an absent or expired receipt.

For existing non-Memo operations, matching key/hash replays the stored response without effects, and a different hash conflicts. M7 uses the [shared Memo receipt contract](project-memos.md#81-execution-versus-replay-only-recovery): execute and replay-only share request identity, but only execute may run on a receipt miss. All unknown-response recovery uses replay-only with the original key/input/version. Eligible receipt means expiresAt > server lookup time; equality is expired. Replay-only returns historical data with replayed=true, conflicts on a different retained request, or returns MEMO_REPLAY_UNAVAILABLE without Memo/event/receipt writes, reservation, cleanup, or expiry extension. Storage errors never become permission to execute. Fatal decoding and input validation still precede lookup. Clients must not remove the recovery mode or generate a replacement key automatically.

Backup restore preserves Installation ID and Memo rows but not operational receipts; valid receipts are retained by in-place upgrade, not reconstructed by restore. Token regeneration or reauthentication provides no execution evidence. Within-window recovery after restore and recovery at an expiry boundary remain replay-only and cannot duplicate a creation. Missing receipt also cannot prove an original in-flight request will not commit later. Existing restore fences apply, and no new receipt exporter, recovery service, or installation-identity change is introduced.

For legacy operations, replay detection precedes the Row Version check and current-state domain validation so the original effect does not cause a spurious `ROW_VERSION_CONFLICT` or `NO_CONTENT_CHANGE` (API-012). Memo requests first pass authentication, bounded fatal decoding, structural/scalar validation, and normalization; mode-aware receipt lookup then precedes current-state/version evaluation. Replay-only never evaluates a fresh write path on a miss. This ordering does not weaken any input validation or existing Handoff contract.

## 9. Crash handling

Every process, CLI or daemon, drains `pending_fs_ops` in `createdAt` order at start, before executing the requested command; each intent is re-evaluated from filesystem state, `attempts` increments per try, and no intent is ever executed destructively twice (RUN-002).

The protocol and its crash points are normative in section 20 of [../architecture/README.md](../architecture/README.md); the matrix below states the recovery this document's guarantees rely on.

| # | Crash point | Expected recovery |
|---|---|---|
| 1 | After staging, before the intent commit | No Handoff, Artifact, or intent row exists; the staged file is an orphan of the no-row class and the `staging/` sweep removes it after its age threshold; the caller saw a failure and may retry with the same idempotency key |
| 2 | After the intent commit, before the rename | Rows exist with `materialized = 0` and reads return `ARTIFACT_MATERIALIZING`; the drain finds the source present, renames it, `fsync`s the parent directory, and marks the Artifact materialized |
| 3 | After the rename, before `fsync` of the parent directory | The drain re-reads the filesystem: destination present means complete, source still present means rename again, both missing means integrity failure with `ARTIFACT_INTEGRITY_FAILED` |
| 4 | After `fsync`, before the completion commit | Files are final and intents are still pending; the drain observes destination present and source gone, sets `materialized = 1`, deletes the intents, and appends `ARTIFACT_ACTIVATED` |
| 5 | During fan-out, between two renames | Every row committed together, so the Dispatch Group is complete in the database; materialized Artifacts read normally, the rest return `ARTIFACT_MATERIALIZING`, and the drain finishes them — fan-out atomicity is unaffected |
| 6 | After the delete commit, before the unlink | The tombstone is authoritative and `currentArtifactId` is already null; the drain executes the protected `unlink` intent. Every tombstone is terminal, because `delete approve` requires a terminal review state and otherwise fails with `HANDOFF_NOT_TERMINAL`, so the recovered Handoff rejects `fetch`, `revise`, review operations, `accept`, `decline`, `withdraw`, and a further `delete request` with `HANDOFF_DELETED`, while `get`, listing, pin, unpin, archive, and unarchive remain available (LIFE-018) |
| 7 | Process restart in the middle of a drain | A partially applied drain is safe to repeat because each intent is decided by current filesystem state, not by how far the previous run got |

The daemon stops accepting mutations before storage shutdown, finishes in-flight transactions, drains outstanding intents, releases `daemon.lock`, and removes `run/daemon.json` (SEC-015).

A lockfile left behind by a killed process is recovered by the stale rules of section 7; a `daemon.lock` with a dead pid is broken by the next `daemon start`, and a `config.lock` older than 30 seconds is broken by the next configuration write.

Configuration recovery prefers the valid canonical file, preserves and reports temporary or backup copies, and never automatically chooses a newer invalid file over the last known good one (CFG-015, SEC-016).

## 10. Event ledger

Events are append-only, are written in the same transaction as the mutation that caused them, never contain Artifact bytes, and are exported to `snapshots/events.jsonl` by every backup so the audit trail survives a restore (SEC-012, HND-016, HND-017, BKP-023).

The table below is the normative event catalog for Sorage; other documents cite these names rather than restating them.

| Event | Actor kind | Milestone |
|---|---|---|
| `HANDOFF_CREATED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `ARTIFACT_FETCHED_FIRST_TIME` | `registered_project` as the recipient, `user` | M1 |
| `REVIEW_NOTE_CREATED` | `registered_project`, `user` | M1 |
| `REVIEW_NOTE_UPDATED` | `registered_project`, `user` | M1 |
| `REVIEW_NOTE_WITHDRAWN` | `registered_project`, `user` | M1 |
| `REVIEW_NOTE_REMOVED` | `user` | M1 |
| `REVIEW_NOTE_RESOLVED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `HANDOFF_REVISED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `HANDOFF_NO_CHANGE_RESOLVED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `HANDOFF_ACCEPTED` | `registered_project`, `user` | M1 |
| `HANDOFF_DECLINED` | `registered_project`, `user` | M1 |
| `HANDOFF_WITHDRAWN` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `HANDOFF_PINNED` | `user` | M1 |
| `HANDOFF_UNPINNED` | `user` | M1 |
| `HANDOFF_ARCHIVED` | `user` | M1 |
| `HANDOFF_UNARCHIVED` | `user` | M1 |
| `DELETION_REQUESTED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `DELETION_APPROVED` | `user` | M1 |
| `DELETION_REJECTED` | `user` | M1 |
| `ARTIFACT_ACTIVATED` | `system` | M1 |
| `ARTIFACT_UNLINKED` | `system` | M1 |
| `ARTIFACT_INTEGRITY_FAILED` | `system` | M1 |
| `PROJECT_REGISTERED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `PROJECT_BINDING_ADDED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `PROJECT_BINDING_REMOVED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `PROJECT_BINDING_REBOUND` | `user` | M6 |
| `PROJECT_STATUS_ARCHIVED` | `user` | M1 |
| `PROJECT_STATUS_ACTIVE` | `user` | M1 |
| `PROJECT_RENAMED` | `registered_project`, `unregistered_workspace`, `user` | M1 |
| `CONFIG_CHANGED` | `user` | M1 |
| `VAULT_MOVED` | `user` | M1 |
| `VAULT_ADOPTED` | `user` | M3 |
| `BACKUP_RUN` | `registered_project`, `unregistered_workspace`, `user`, `system` | M3 |
| `RESTORE_COMPLETED` | `user` | M3 |
| `MEMO_CREATED` | `user` | M7 |
| `MEMO_UPDATED` | `user` | M7 |
| `MEMO_MARKED_DONE` | `user` | M7 |
| `MEMO_DISMISSED` | `user` | M7 |
| `MEMO_REOPENED` | `user` | M7 |
| `TOKEN_ROTATED` | `user` | M2 |

`REVIEW_NOTE_RESOLVED` is appended in the same transaction as `HANDOFF_REVISED` or `HANDOFF_NO_CHANGE_RESOLVED` whenever that sender operation removed a Review Note; `REVIEW_NOTE_WITHDRAWN` means the recipient withdrew the current Note, and `REVIEW_NOTE_REMOVED` means the User removed it administratively.

`ARTIFACT_ACTIVATED` and `ARTIFACT_UNLINKED` are appended by the completion transaction that clears the intent, never by the transaction that created it, so the ledger records what actually happened on disk.

No event is ever sampled. Only the first `sorage fetch` or Web artifact-content read of a Handoff records `ARTIFACT_FETCHED_FIRST_TIME` and sets `firstFetchedAt`; later fetches record nothing, and `get`, listing, and the Web detail screen record nothing at all and never set `firstFetchedAt` (HND-012, HND-024).

Path fields are redacted on export while `gitBackup.snapshot.redactWorkspacePaths` is `true`, which is its default: `senderPathSnapshot`, Project Binding paths, and every path field inside an event's metadata are dropped from `snapshots/events.jsonl`, so the exported ledger is the audit record minus machine-local paths, and `backup restore` rebuilds the ledger exactly as it was exported rather than reconstructing paths it no longer has (BKP-023, BKP-024).

## 11. Logging

Every Sorage process writes structured JSON, one object per line, to `~/.sorage/logs/sorage.log` (RUN-009).

| Field | Meaning |
|---|---|
| `ts` | UTC timestamp in RFC 3339 |
| `level` | `error`, `warn`, `info`, or `debug` |
| `requestId` | Correlation id, generated per CLI invocation and per HTTP request |
| `actorKind` | `registered_project`, `unregistered_workspace`, `user`, or `system` |
| `operation` | Use-case name, matching the idempotency `scope` vocabulary |
| `handoffId` | Handoff UUID when the operation targets one |
| `errorCode` | Symbolic error code on failure, absent on success |
| `durationMs` | Wall-clock duration of the operation |
| `pid` | Process id, which distinguishes concurrent CLI processes from the daemon |

Path redaction is on by default, because `logging.includeFullPaths` defaults to `false`: absolute paths outside the Sorage home are replaced by a stable digest that keeps them correlatable across lines, stable identifiers are retained either way, and full paths appear only when the key is deliberately turned on for diagnosis (SEC-011).

Never logged, at any level: bearer tokens and session tokens, the one-time browser secret, Git credentials, Artifact bytes, Review Note bodies, and the full environment of an external command (SEC-010, SEC-020).

Rotation follows `logging.rotation.maxBytes`, default 10485760, and `logging.rotation.maxFiles`, default 5; the CLI defaults to level `warn` so that normal command output stays clean, and the daemon defaults to the configured level.

## 12. macOS platform

The default Vault is `~/.sorage/vault` rather than a folder under `~/Documents`, because a LaunchAgent-started daemon touching a TCC-protected folder raises a consent prompt no background process can answer, and denial then looks like a permission bug (VLT-001).

The `platform.tcc` doctor check covers the Vault and every Project Binding directory, and warns when one of them sits under `~/Documents`, `~/Desktop`, or `~/Downloads`, naming `sorage vault move --to <path> --as-user` as the recovery for the Vault.

The LaunchAgent uses the modern launchd domain-target form, `launchctl bootstrap gui/$UID <plist-path>` to install and `launchctl bootout gui/$UID/xyz.rootkernel.sorage` to remove; the legacy `load` and `unload` verbs are not used, and every value interpolated into the plist is XML-escaped (RUN-007, RUN-011).

Release binaries are produced with `bun build --compile`, ad-hoc codesigned, and distributed as architecture-specific GitHub Release assets with a checksum and manifest (ADR-0023). The first release makes no notarization, Developer ID, or Gatekeeper-bypass claim.

Sorage never modifies global or system Git configuration; `core.autocrlf=false` is set in the Vault repository only (BKP-022).

`sorage uninstall --as-user --confirm` removes the LaunchAgent, `~/.sorage/state`, `~/.sorage/run`, `~/.sorage/logs`, and `~/.sorage/config.yaml`, never deletes the Vault, and prints the retained Vault path (INIT-016).

## 13. Git safety, milestone M3

| Rule | Statement |
|---|---|
| Execution | Every Git invocation uses an argument array with `shell: false`; no user value is ever interpolated into a command line (SEC-004, SEC-005) |
| Batch mode | `GIT_TERMINAL_PROMPT=0` and SSH `BatchMode=yes` on every invocation, so a credential prompt fails instead of hanging (BKP-025) |
| Timeout | 60 seconds per invocation; a timeout is a failure with recovery guidance, never a retry loop |
| Missing credentials | `GIT_AUTH_REQUIRED`, with the remote and the credential mechanism named |
| Push | Push MUST use `git push --atomic` to the configured remote and branch, so a partially applied ref update is impossible; a non-fast-forward push fails with `GIT_BACKUP_CONFLICT` and requires manual intervention (BKP-014, BKP-025) |
| Never | Force push, rebase, merge, automatic conflict resolution, and history rewriting are not implemented (BKP-013, BKP-020) |
| Line endings | Vault initialization writes `.gitattributes` with `artifacts/** -text -diff`, `snapshots/** text eol=lf`, and `.sorage-vault.json text eol=lf`, and `.gitignore` with `staging/`, at milestone M1 (VLT-024); Git initialization sets `core.autocrlf=false` and re-asserts both files idempotently at M3, and `sorage backup verify` checks them (BKP-022) |
| Commit decision | Only changed managed content is committed, decided by `git diff --cached --quiet` over the managed pathspecs (BKP-009, BKP-024) |
| Excluded | The SQLite database, its WAL and SHM files, logs, tokens, and credentials are never committed (BKP-004) |

Without `.gitattributes` a clone made with `core.autocrlf=true` rewrites the bytes of every text Artifact and breaks its recorded SHA-256; this was reproduced during the review of the previous Source of Truth revision, which is why the attribute file is a requirement rather than a convention.

Two data-loss properties are stated to the User rather than hidden: prior Git commits may retain earlier content and deletion never claims to purge them (LIFE-015, repeated in backup messaging by BKP-019), and Revisions that were replaced between two backups are not preserved anywhere, because Sorage natively retains only the current Artifact (VLT-011, ADR-0003).

## 14. `doctor` check catalog

The `doctor` check catalog is normative in section 35 of [interfaces-and-operations.md](interfaces-and-operations.md), which owns every check id, its severity, its milestone, and its recovery text, and which the daemon exposes at `GET /api/v1/diagnostics` from M2; this document does not restate the catalog, and a check named anywhere in this document means the entry of that name there (INIT-017).

## 15. Security checks

These are the checks the release gates of [testing-and-acceptance.md](testing-and-acceptance.md) require, each observable as a command plus an expected code or state.

| # | Check | Expected result |
|---|---|---|
| 1 | Bind to a non-loopback address | Rejected at startup; the configuration enum admits only `127.0.0.1` and `::1` (SEC-001) |
| 2 | `Host: attacker.example` on `GET /api/v1/handoffs` | `HOST_NOT_ALLOWED` with HTTP 421, decided before routing and before authentication, no handler invoked, no Handoff data in the body (SEC-017) |
| 3 | Every allowlisted Host value, including `localhost:<port>` and `[::1]:<port>` | Accepted, so the allowlist is not accidentally narrower than the browser's behavior |
| 4 | Any request with no `Authorization` header | `UNAUTHENTICATED` with HTTP 401, including `GET` and multipart (SEC-002, SEC-003) |
| 5 | Unknown, malformed, or rotated-away token | `TOKEN_INVALID` with HTTP 401; the CLI retries once after a rotation and then reports it (SEC-020) |
| 6 | Any response, success or error, static or Artifact | No `Set-Cookie`, and no code path reads a cookie (SEC-019) |
| 7 | One-time fragment secret replayed at `POST /api/v1/session` | Second exchange refused with `UNAUTHENTICATED` and HTTP 401; the first session remains the only one issued |
| 8 | Cross-origin `fetch` from a non-allowlisted origin | Fails; there is no ambient credential to attach and no CORS allowance |
| 9 | Every response's headers | CSP of section 2.2, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (SEC-018) |
| 10 | Upload or preview of an SVG and of an `.html` file | Served as `application/octet-stream` with `Content-Disposition: attachment`, never rendered inline (WEB-006) |
| 11 | Markdown Artifact containing a `<script>` tag and an external image | Rendered sanitized; the script never executes and the external load is blocked by CSP |
| 12 | Upload exceeding `artifact.maxBytes` | Aborted mid-stream with `ARTIFACT_TOO_LARGE`, with memory bounded and no full-body buffering (NFR-005, API-003) |
| 13 | Path traversal, symlink escape, and containment-cycle source paths | Rejected after `realpath` resolution (SEC-006, VLT-017) |
| 14 | Socket, named pipe, and device file as an Artifact source | Rejected (SEC-007, VLT-015) |
| 15 | Shell metacharacters in a title, slug, filename, and commit message | Treated as data; the argument-array execution never spawns a shell (SEC-004, SEC-005) |
| 16 | A User-admin command without `--as-user` | `USER_CONTEXT_REQUIRED`; with the flag, the event records `actorKind = user` (CLI-019) |
| 17 | Pinned deletion approval without `--confirm-pinned <id>` | `PINNED_DELETE_CONFIRMATION` (LIFE-012) |
| 18 | Read of a Handoff by an actor that is neither its sender nor its recipient | `HANDOFF_NOT_FOUND` with HTTP 404 and exit 66 from `get`, `fetch`, and the API alike, so existence is not disclosed |
| 19 | `delete approve` on a non-terminal Handoff, and any content operation on a tombstone | `HANDOFF_NOT_TERMINAL` for the first, `HANDOFF_DELETED` for the second; approval without `--as-user` returns `USER_CONTEXT_REQUIRED` (LIFE-018, CLI-019) |
| 20 | Log file and `--json` output after a full journey | No token, no session secret, no Git credential, no Artifact bytes, no Review Note body (SEC-010) |
| 21 | Token file and home directory modes | `0600` for the token, owner-only for the home directory (SEC-020) |
| 22 | Backup status with a remote configured | States plainly whether protection is local-only or includes a remote (BKP-018) |
| 23 | Deletion confirmation and messaging | States that Git history may retain the deleted content and never claims a purge (LIFE-015, BKP-019) |
