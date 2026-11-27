# Changelog

This file records concise shipped outcomes and the planned next stable release.

## v0.1.6 - 2026-11-27

### Changed

- **Breaking storage upgrade:** Upgrade live storage one-way to schema 17 with 12 additive secondary indexes and no table rebuilds, indexed Memo receipt scans, and a minimum schema-16 requirement for `sorage exchange`, preserving backup format 5, Format 1–5 restore support, and short Artifact IDs; guarded v0.1.5 refuses schema 17 (`STORAGE_SCHEMA_UNSUPPORTED`, exit 78), so follow the [schema 17 upgrade and rollback procedure](docs/ops/README.md#m11-schema-v17-upgrade-and-rollback) for matched-binary rollback into a separate home.
- **Breaking Handoff restriction:** Reject fresh registered-Project self-handoffs all-or-nothing for single and fan-out sends across CLI, HTTP, and MCP (`HANDOFF_INVALID_INPUT`, HTTP 422, CLI exit 64), while preserving User and unregistered-Workspace sends, existing self-handoff rows and receipts with deterministic sender/recipient role resolution, and inherited-workspace sender authority.
- **Breaking HTTP idempotency receipts:** Use semantic SQLite receipts on the five keyed Handoff and Backup HTTP routes so eligible replays return the committed outcome with `replayed: true` in a fresh envelope and `X-Request-Id` while enforcing sender or User authorization on `revise` replays, returning `422 CONFIG_INVALID` for duplicate or empty `Idempotency-Key` headers or differing trimmed header and body keys, `409 IDEMPOTENCY_CONFLICT` for a concurrent duplicate with the same scope and trimmed header key on the same daemon, and `413 ARTIFACT_TOO_LARGE` for oversized keyed uploads.
- **Breaking Vault and Project containment:** Reject `/` targets and mutual Vault/Project containment—including Vault placement inside bound Git repository working trees and resolving absent Vault paths through their longest existing ancestor while failing closed on dangling symlinks—across `project add`, `bind`, `rebind`, `vault move`, and file `send`/`revise` (`VAULT_CONTAINMENT`), fail unregistered sends from `/` with `SENDER_IDENTITY_DOWNGRADE` when valid bindings exist while keeping external-source checks fail-closed at `/`, and isolate pre-existing legacy `/` bindings from implicit authority and runtime containment while `sorage doctor` (`bindings.nested`) guides repair through `sorage project rebind` or `sorage project unbind` (see [legacy root-binding recovery](docs/ops/README.md#web-and-daemon-cli-json-cutover-and-legacy-root-binding-recovery-adr-0041)).
- **Breaking `web` and `daemon` CLI output cutover:** Align `sorage web` and `sorage daemon start|stop|restart|status` with the shared `--json` envelope and human-default output contract—moving `web --json` fields under `data` with JSON error envelopes on stderr and structured failure logging, replacing literal `"daemon"` `meta.requestId` values with per-invocation UUIDs, emitting one final envelope from `daemon restart --json`, aligning uninitialized/invalid-config daemon fallbacks to `NOT_INITIALIZED`/`CONFIG_INVALID` (exit 78), defaulting non-`--json` runs (including `daemon status` errors) to human text, and suppressing duplicate child daemon envelopes and logs in `init --start-daemon` and `uninstall`—so callers must update `web --json` consumers from top-level `url`, `daemonStarted`, `expiresAt`, and `note` to `data.url`, `data.daemonStarted`, `data.expiresAt`, and `data.note`, parse non-zero stderr as a standard JSON error envelope, and pass `--json` explicitly wherever JSON is expected (see [CLI JSON cutover guidance](docs/ops/README.md#web-and-daemon-cli-json-cutover-and-legacy-root-binding-recovery-adr-0041)).
- Complete options for visible subcommands in Bash and Zsh and omit the internal `daemon serve` command from suggestions.
- Embed framework-free Web UI assets into the single compiled executable at build time, with both `make test-prepare` and `make package` checking the tracked HTML, CSS, and JavaScript embedding for drift before compilation.

### Fixed

- Enforce User-admin context (`asUser: true`) on HTTP Handoff `archive`, `unarchive`, and `deletion-reject` routes and forward optional `reason` on `deletion-reject`.
- Honor `?sender=` and `?recipient=` in HTTP and Web Handoff listings, with pagination cursors bound to both filters.
- Reject non-empty malformed or non-object JSON request bodies on daemon HTTP routes (`CONFIG_INVALID` 422 on general routes, `UNAUTHENTICATED` 401 on `/api/v1/session`) instead of silently falling back to `{}`.
- Validate Handoff multipart `body` UTF-8 encoding and non-whitespace content incrementally during streaming instead of rescanning synchronously after upload, rejecting invalid UTF-8 anywhere in the body including past the first 64 KiB (`422 CONFIG_INVALID`) while preserving error precedence, upload spool cleanup, and body-only title validation.
- Restore `--as-user` enforcement, `--expected-revision` forwarding, and human/JSON output parity when `sorage config set` routes through a running daemon.
- Fall back to `vi` in `sorage config edit` when `EDITOR` is unset or blank.
- Keep `sorage daemon start`, `sorage daemon stop`, and `sorage web` polling within their readiness and stop-grace deadlines using capped exponential backoff.
- Write `VAULT_MOVED` structured log entries to the active installation's configured log target instead of reading global `SORAGE_HOME` or the default home directory.
- Return Channel-specific error codes (`CHN_TOO_LARGE` and `CHN_INVALID_INPUT`) when staging oversized or invalid Channel message text instead of Memo error codes.
- Verify lock ownership before removing `daemon.lock` so releasing a superseded lock cannot delete another live daemon's lock file.
- Clean up temporary Vault marker files after failed marker adoption during restore so retries in the same process do not fail with `EEXIST`.
- Remove double HTML-entity escaping in the Web UI Markdown preview so angle brackets and ampersands render accurately without HTML parsing.
- Percent-encode Web UI URL query and hash parameters, deduplicate Backup page run rows, paginate Web dashboard, deletion-request, and unregistered-workspace Handoff summaries across all pages, and debounce Memo editor preview and byte-counting while keeping draft tracking and submission synchronous.
- Fit the Web UI Dashboard, Compose, and Backup views cleanly within narrow 390px viewports using keyboard-focusable scrollable table regions, full-width Compose form fields with assistive status announcements, and bounded text wrapping while preserving the desktop layout and accessibility.
- Eliminate unnecessary startup migration write locks on up-to-date databases while preserving fail-closed refusal on write-protected databases, reuse per-command SQLite connections and configuration across Handoff, Project, Vault, and startup-drain operations, release idle database handles between `sorage inbox --wait` polls, and skip opening inbox-marker storage when `handoff.inboxMarker` is disabled.
- Prevent daemon event-loop stalls by running scheduled and `POST /api/v1/backup/run` backups with asynchronous Git execution and streaming Vault verification, streaming periodic Artifact checksum sweeps with abort handling and shared daemon resources, streaming multipart uploads with linear framing, and caching API token file metadata while immediately invalidating browser sessions on token rotation.
- Reduce disk I/O and query overhead across Exchange file activation and paged material reads, Handoff listings and detail lookups using the schema 17 sort indexes, content-cleanup reference checks, non-mutating `sorage preflight` inspection, file-backed Memo search and large-body staging, and `sorage doctor` diagnostics without weakening integrity or cross-domain audits.

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
