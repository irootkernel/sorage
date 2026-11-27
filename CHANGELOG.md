# Changelog

This file records concise shipped outcomes and the planned next stable release.

## v0.1.6 - Unreleased

### Changed

- **Reject fresh registered-Project self-handoffs (ADR-0038, breaking)** all-or-nothing for single and fan-out sends through CLI, HTTP, and MCP (`HANDOFF_INVALID_INPUT`, HTTP 422, CLI exit 64), preserving User and unregistered Workspace sends, pre-M11 rows and replay with unified sender/recipient role resolution, and inherited-workspace authority (`PRJ-020`).
- **Upgrade storage one-way to schema 17 (`m11-secondary-indexes-v1`, ADR-0038, breaking for older executables)** with 12 additive indexes and no table rebuilds, indexed Memo receipt scans, and a CLI schema-surface floor of 16 for `exchange`, preserving backup format 5, Format 1–5 restore support, and short Artifact IDs, with [matched-binary rollback into a separate home](docs/ops/README.md#m11-schema-v17-upgrade-and-rollback) because guarded v0.1.5 refuses schema 17 (`STORAGE_SCHEMA_UNSUPPORTED`, exit 78).
- Complete options for visible subcommands in Bash and Zsh and omit the internal `daemon serve` command from suggestions.
- **Use semantic SQLite receipts on five keyed Handoff and Backup HTTP routes (ADR-0039, breaking)** so eligible replays return the committed outcome with `replayed: true` and a fresh envelope and `X-Request-Id`, with `422 CONFIG_INVALID` for duplicate or empty `Idempotency-Key` headers or differing trimmed header/body keys, `409 IDEMPOTENCY_CONFLICT` for a concurrent duplicate on the same daemon with the same scope and trimmed header key, and `413 ARTIFACT_TOO_LARGE` for oversized keyed uploads.
- **Embed framework-free Web assets at build time (ADR-0040)** in the single executable, with packaging checking the tracked HTML, CSS, and JavaScript embedding for drift before compilation.
- **Enforce root-safe Vault/Project containment and isolate legacy `/` bindings (ADR-0041, breaking)** so `project add`/`bind`/`rebind`, commit-time repository checks (resolving absent Vault paths via their longest existing ancestor while keeping dangling symlinks fail-closed), `vault move`, and file `send`/`revise` reject `/` targets and Vault placement inside bound `git_repository` working trees (`VAULT_CONTAINMENT`), unregistered sends from `/` fail with `SENDER_IDENTITY_DOWNGRADE` when valid bindings exist, `checkExternalSource` stays fail-closed on `/` (`VLT-016`), `absentRealPath`/`resolvePhysicalPath` join root-parent paths cleanly, and pre-existing invalid `/` bindings are excluded from implicit authority and runtime containment while `doctor` `bindings.nested` guides repair via `sorage project rebind` or `sorage project unbind`.
- **Cut over `sorage web` and `sorage daemon start|stop|restart|status` CLI output onto the shared `--json` envelope and human-default contract (ADR-0041, breaking)** so `web --json` emits one standard `successEnvelope` (`data.url`, `data.daemonStarted`, `data.expiresAt`, `data.note`) on stdout and a standard JSON error envelope on stderr with `RUN-009` failure logging, `daemon` lifecycle commands emit per-invocation UUID `meta.requestId` values instead of literal `"daemon"`, `daemon restart --json` emits one final start envelope (or only the terminal error envelope on failure), direct/internal uninitialized or invalid-config daemon fallbacks align to `NOT_INITIALIZED`/`CONFIG_INVALID` (exit `78`), non-`--json` invocations emit human stdout/stderr templates (including `daemon status` errors), and `init --start-daemon` and `uninstall` suppress duplicate internal daemon envelopes. Migration: update `web --json` callers from top-level `url`, `daemonStarted`, `expiresAt`, and `note` to `data.url`, `data.daemonStarted`, `data.expiresAt`, and `data.note`, parse stderr as a standard error envelope on non-zero exit, and pass `--json` explicitly wherever JSON output is expected.

### Fixed

- Enforce User-admin context (`asUser: true`) on HTTP Handoff `archive`, `unarchive`, and `deletion-reject` routes and forward optional `reason` on `deletion-reject`.
- Honor `?sender=` and `?recipient=` in HTTP and Web Handoff listings, with pagination cursors bound to both filters.
- Restore `--as-user` enforcement, `--expected-revision` forwarding, and human/JSON output parity when `sorage config set` routes through a running daemon.
- Reject non-empty malformed or non-object JSON request bodies on daemon HTTP routes (`CONFIG_INVALID` 422 on general routes, `UNAUTHENTICATED` 401 on `/api/v1/session`) instead of silently falling back to `{}`.
- Route `VAULT_MOVED` structured logging through the resolved installation home and configured logger instead of global `process.env.SORAGE_HOME` and `homedir()`.
- Bind Channel error codes (`CHN_TOO_LARGE` and `CHN_INVALID_INPUT`) in `stageAccepted` text capture and use `CONTENT_INLINE_MAX_UTF8_BYTES` in `memo-body-file.ts`.
- Fix `sorage config edit` `EDITOR` fallback to `"vi"` when `EDITOR` is unset or blank.
- Return owner-checked lock release from `acquireDaemonLock` so releasing a superseded lock cannot delete another owner's `daemon.lock`.
- Clean up temporary `.sorage-vault.json.tmp-<pid>` files on `adoptMarker` failures so same-process retries succeed without `EEXIST`.
- Remove double HTML-entity escaping in Web Markdown preview (`renderMarkdownSafe`) so angle brackets and ampersands render uncorrupted via `textContent` without HTML parsing.
- Percent-encode Web UI URL query and hash interpolations with `encodeURIComponent`, deduplicate Backup page runs by `run.id`, paginate Web dashboard/deletion-request/unregistered-workspace Handoff aggregates beyond a single page, and debounce Memo editor preview and byte-counting with synchronous draft tracking and submit flush.
- Eliminate the startup migrator write-lock storm on up-to-date databases, reuse command-scoped SQLite connections and operational configuration across Handoff, Project, and startup-drain port bundles with explicit `.close()` lifecycle cleanup, open one coherent `CoveredReadStorage` per `inbox --wait` poll iteration without holding an idle handle across sleeps, and check `handoff.inboxMarker` before opening marker database ports on fan-out refreshes.
- Offload daemon backup runs (`runBackupTick` and `POST /api/v1/backup/run`) onto asynchronous child-process Git and streaming Vault verification, convert periodic Artifact checksum sweeps (`runSweepTick` and `hashArtifact`) to abort-aware asynchronous streaming with single-tick configuration and daemon database reuse, migrate browser multipart uploads onto `push-sink` with O(N) linear buffered text-part and header scanning in `multipart-engine.ts`, and cache API token `stat`/`mtime` metadata in `auth.ts` with immediate browser session pruning on token rotation.
- Optimize Exchange, read-path, and diagnostics I/O hot paths: reduce Exchange file activation hashing via `dev:ino` identity verification and eliminate O(S^2/page) full-file re-hashing in Exchange `planRead` and versioned `readExchangeOriginal`, fold Handoff `listPage` and `loadHandoff` queries into a single `LEFT JOIN` projection using schema `v17` sort indexes, switch `removeContentRecordInTx` to indexed point-lookup `EXISTS` checks while preserving full cross-domain audits in Vault GC and `doctor`, switch `preflight.ts` to 100-byte SQLite header inspection, streaming SHA-256, and per-run configuration caching, combine file-backed Memo query scanning and head preview capture into one pass while staging oversized in-memory text directly via `stageBytes`, and add request-scoped `DoctorContext` session caching, deduplicated artifact/content hashing, and O(B log B) binding checks in `doctor.ts`.
- Track Handoff multipart `body` fatal UTF-8 validity across the entire streamed body payload and non-whitespace presence incrementally inside the streaming push-sink in `apps/daemon/src/upload.ts`, eliminating the post-stream synchronous `readSync` rescan on the daemon request callback, rejecting invalid UTF-8 even past the first 64 KiB of valid text (`422 CONFIG_INVALID`, `API-013`), and preserving error precedence, spool cleanup, and body-only title validation.
- Fit the Web UI Dashboard, Compose, and Backup views cleanly within narrow 390 CSS pixel viewports by wrapping the Recent updates and Recent runs tables in keyboard-focusable scrollable regions (`role="region"`, `tabindex="0"`), constraining Compose form fields and adding `role="status"` announcements for Compose feedback, wrapping long content on narrow screens, keeping the 1280px desktop layout usable, and staying free of `axe-core` accessibility violations.

## v0.1.5 - 2026-11-22

### Added

- Collaborate across registered Projects through `sorage exchange` and 24 new MCP tools, with addressed messages, versioned reports, exact acceptance, and operation-ID recovery.
- Share workspace-confined working copies or registered originals whose ownership, path, and version are checked on retrieval.
- Inspect Exchange history and materials, wait for activity, and look up committed operations without writing to the Installation.
- Keep claims renewed through the CLI session owner or MCP connection, release them on graceful shutdown, and follow acceptance of a replacement assignee's report from a delivery cursor.
- Correct membership and request ownership, pause and resume work, and agree on completion by unanimous vote with recoverable cleanup that protects original sources.
- Revoke a Project's Exchange session and notice claims when it is archived or loses its last workspace binding.
- Discover eligible connection checks and unread-delivery notices, reserve a reporting slot, and acknowledge a notice after issuing it to the user.
- Use the standalone `start-exchange` and `join-exchange` skills through CLI or MCP, including supported Plan-mode and read-only MCP sessions.

### Changed

- Build and verify from source with pinned Bun and Node runtimes, explicit toolchain setup and dependency-lock commands, and automatic formatting before the complete test gate.
- **Breaking storage upgrade:** Move live storage one-way to schema 16 and use a compatible executable for the global format-5 `notices` backup inventory.
- Stop old writers and verify a backup with its matching executable before upgrading, then use that pair for rollback into a separate empty home and Vault.
- Back up compact Exchange outcomes with configurable workspace-path redaction and exclude working bytes, Project bindings, and live claims from the snapshot.
- Restore formats 1 through 4 or earlier format-5 inventories with the new executable, and rebind the owning Project and revalidate its local references before using them in a restored Installation.

### Fixed

- Clarify how to identify the current Exchange assignee and recover from stale report assignments or notice reporting claims.

## v0.1.4 - 2026-11-08

### Fixed

- Publish consistent internal-communication descriptions and Plan-mode annotations for all 35 MCP tools, server instructions and the shipped skill, preserving automatic read receipts and existing domain safeguards.
- Name intended MCP communication calls in migration recovery guidance instead of the obsolete write-tool label.

## v0.1.3 - 2026-10-29

### Added

- Add per-Revision Handoff reading and processing reports with one retained recipient comment, separating general explanations and change requests from document acceptance.
- Show Handoff reading, unfinished/completed/unrecorded processing and attributed retained feedback in the Web inbox, outbox and detail; support explicit User-proxy reporting, terminal general updates and exact proposal retention on conflicts or uncertain responses.
- Add `sorage preflight` to report Installation compatibility without migration or managed-storage writes.
- Add `sorage send --replay-only` to inspect the original request's receipt without sending again, preserving uncertainty when its original material or receipt is unavailable.
- Store newly accepted Handoff text up to 65,536 UTF-8 bytes inline in SQLite, retaining larger text and binary bodies in the Vault and existing file-backed Artifacts on their original paths.
- Store Project Memo bodies through the same inline/Vault boundary, adding multipart create/update for larger bodies while retaining the existing JSON responses, 512 KiB JSON request limit, literal search, title-only edits and Web recovery gate.
- Add named upstream Channels with participant handles and per-Channel sequence numbers, a five-step create/add/post/messages/ack loop, idempotent roster/handling/closure operations, content-based duplicate detection for unhandled posts, attributed bodies and handling notes, waits and filters, and backup/restore.
- Add the STDIO `sorage mcp` server with 35 Handoff, Memo, Channel and Project-read tools, native CLI envelopes and diagnostics, accurate annotations, workspace-confined file inputs and 30-second MCP wait defaults, leaving administration on the CLI and global registration an explicit user setup decision.
- Make covered Handoff, Memo, Project and Channel reads and waits write nothing, without startup recovery, migration, cleanup or installation logging.
- Add `sorage revise --body <text>` as the inline alternative to a file or an explicit no-change revision.
- Teach MCP-first messaging with CLI fallback through the self-contained shipped skill, including a worked Channel loop, explicit request scope, untrusted-content boundaries, distinct pinned-deletion decisions, observed-version conflicts and original-request recovery.

### Changed

- **Breaking Handoff data contract:** `storageKey` is always present and may be `null` for inline content, and Handoff get/list/detail and report results always include `read`, `processing` and body-free `comment` metadata, requiring updates to string-only and closed-DTO consumers while protocol version 1, the response envelope and `/api/v1` remain unchanged.
- **Breaking read-state behavior:** covered reads refuse an older or empty database with `STORAGE_MIGRATION_REQUIRED`/78 and a missing database with `STORAGE_INTEGRITY_ERROR`/73 instead of migrating or recreating it, and refuse unsafe or unavailable WAL/SHM state without repairing it as detailed in [the compatibility record](docs/roadmap/README.md#task-122-contract-record).
- **Breaking Handoff writer inputs:** fresh comment/start/complete and review set require the current Revision and Row Version, while review withdrawal/removal, revise including no-change and deletion approval require Row Version; original successful-receipt replay retains its legacy exception.
- Protect Project unbind, including archived Projects and the last binding, while accepted work is known unfinished, without inferring pending work from legacy `unrecorded` evidence.
- Preserve committed Handoff, Project and Channel outcomes when later physical completion or inbox-marker work fails, returning the committed result with a warning and leaving pending physical work for normal recovery.
- Return typed `STORAGE_INSPECTION_UNAVAILABLE` refusals for storage-preparation contention and write-protected Handoff, Project and Channel operations, including HTTP 503 on the affected Handoff/Project routes, with state-specific recovery that preserves original requests and never authorizes permission or actor changes.
- Inspect readable write-protected Installations correctly for preflight, send replay-only and daemon admission, including committed WAL data, without changing their live files.
- Append schema 12 for current Handoff reading/processing evidence and one recipient comment, emitting deterministic format-4 backups while preserving format-1 through format-3 readers and legacy evidence as `unrecorded`.
- Normalize Handoff and Memo content references without repacking existing bodies or rewriting retained receipts, preserving exact content/digests, excluding derived fetch caches and restoring fresh private content records without operational receipts.
- Keep complete historical Memo reads, receipt output and unchanged-body title edits available after an input-cap reduction, while enforcing the current cap on newly supplied bodies and disclosing large-content Git-history retention.
- Refuse development homes and snapshots carrying the superseded unreleased Channel representation rather than converting them.

- **One-way storage upgrade:** stop old writers and scheduling/push, make and verify a backup with the matching old executable and complete its separate restore drill, then require `preflight` to report `upgrade_required`, run `sorage backup run` once with the new executable in that disabled-scheduling/push context, require `compatible` and verify the new backup before Vault verification as described in [the upgrade procedure](docs/ops/README.md#m9-shared-content-upgrade-and-rollback).
- Roll back only by restoring the retained pre-upgrade backup with its matching old executable into a fresh home and Vault, preserving the upgraded home and keeping old writers away from it, with later data and operational receipts absent from the restored Installation.
- Require a compatible reader for format-4 backups; published v0.1.2 cannot read the upgraded schema-12 storage or these backups.

### Fixed

- Return `STORAGE_INSPECTION_UNAVAILABLE`/75 for expected Memo CLI startup/open storage denial instead of `INTERNAL_ERROR`/1, preserving original recovery mode and requests; clarify send replay private-scratch requirements and permitted MCP recovery, and point internal-error diagnosis at the selected Sorage home with a fallback when no log was written.
- Give Vault-open, configuration-access and unsafe-path failures recovery actions that apply to the actual state, preserving typed codes and avoiding initialization or verification advice that cannot work while storage is inaccessible.
- Diagnose Vault policy and filesystem checks accurately in `sorage doctor`, and refuse unreadable or non-regular initialization configurations instead of treating an existing Installation as new.

## v0.1.2 - 2026-10-03

This corrected distribution replaces the withdrawn original v0.1.2 distribution dated 2026-09-29. Existing v0.1.2 installations must replace the binary and verify the new release manifest and checksum; the version string remains unchanged.

### Added

- Let the local User create a Handoff from the Web compose form by supplying a Markdown body instead of a file.
- Add `sorage project rebind` to replace a Project directory binding in one command.
- Add durable Project Memos through the CLI, authenticated local HTTP API, Web UI, and shipped `use-sorage` skill with explicit actions and replay-only recovery for uncertain writes.

### Changed

- Let Project archive and unarchive run without `--as-user`, and prevent archived Projects from starting new outgoing Handoffs.
- Export Memo data in format-2 backups while retaining format-1 restore support; before upgrading, stop old writers and keep a verified format-1 backup because older binaries cannot read the new format.

### Fixed

- Allow a registered Git Project to revise a document inside its documented workspace root without an external-source override.
- Preserve multipart Web upload bodies that begin with dashes.
- Keep Handoff sender identity and Project bindings stable when archive or rebind races with a send, and require an explicit override for ancestor-path sends above registered Projects.
- Restore the Web Handoff detail Download action for authenticated sessions.

## v0.1.1 - 2026-09-09

### Added

- Add `sorage review show` and `sorage events` so a session can read the current Review Note and the bounded metadata timeline through the CLI without a daemon.
- Teach requested Handoff processing in the shipped `use-sorage` skill to read the Note with `review show` before `revise`, and keep inbox and outbox checks report-only.

### Changed

- Refresh the Web control plane visual presentation with light and dark design tokens, state badges, census cards, loading and empty states, and grouped detail actions, without changing HTTP endpoints or DTOs.
- Require explicit broker requests for inbox, outbox, and Handoff processing, and default requested project setup to ignore `.sorage/`.
- Pin the required Bun toolchain to `1.4.2`.

### Fixed

- Classify Git password-acquisition failures as authentication errors.
- Correct Web rendering defects found during the visual refresh: invalid button padding, an undefined deleted census card, and an empty artifact revision row.

## v0.1.0 - 2026-09-02

### Added

- Publish the first public Apple Silicon macOS release with the Sorage CLI, loopback daemon, local Web UI, LaunchAgent service, Vault integrity, Git backup and restore, and GitHub Release assets.
