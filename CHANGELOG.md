# Changelog

This file records concise shipped outcomes and the planned next stable release.

## v0.1.3 - Unreleased

### Added

- Add per-Revision Handoff reading and processing reports with one retained recipient comment, separating general explanations and change requests from document acceptance.
- Show Handoff reading, unfinished/completed/unrecorded processing and attributed retained feedback in the Web inbox, outbox and detail; support explicit User-proxy reporting, terminal general updates and exact proposal retention on conflicts or uncertain responses.

- Add `sorage preflight` to report Installation compatibility without migration or managed-storage writes.
- Add `sorage send --replay-only` to inspect the original request's receipt without sending again, preserving uncertainty when its original material or receipt is unavailable.
- Store newly accepted Handoff text up to 65,536 UTF-8 bytes inline in SQLite, retaining larger text and binary bodies in the Vault and existing file-backed Artifacts on their original paths.
- Store Project Memo bodies through the same inline/Vault boundary, adding multipart create/update for larger bodies while retaining the existing JSON responses, 512 KiB JSON request limit, literal search, title-only edits and Web recovery gate.
- Add named upstream Channels with participant handles and per-Channel sequence numbers, a five-step create/add/post/messages/ack loop, idempotent roster/handling/closure operations, content-based duplicate detection for unhandled posts, attributed bodies and handling notes, waits and filters, and format-3 backup/restore.
- Add the STDIO `sorage mcp` server with 35 Handoff, Memo, Channel and Project-read tools, native CLI envelopes and diagnostics, accurate annotations, workspace-confined file inputs and 30-second MCP wait defaults, leaving administration on the CLI and global registration an explicit user setup decision.
- Make covered Handoff, Memo, Project and Channel reads and waits write nothing, without startup recovery, migration, cleanup or installation logging.
- Add `sorage revise --body <text>` as the inline alternative to a file or an explicit no-change revision.
- Teach MCP-first messaging with CLI fallback through the self-contained shipped skill, including a worked Channel loop, explicit request scope, untrusted-content boundaries, distinct pinned-deletion decisions, observed-version conflicts and original-request recovery.

### Changed

- **Breaking Handoff data contract:** `storageKey` is always present and may be `null` for inline content, requiring updates to string-only consumers while preserving protocol version 1, the response envelope and `/api/v1`.
- **Breaking read-state behavior:** covered reads refuse an older or empty database with `STORAGE_MIGRATION_REQUIRED`/78 and a missing database with `STORAGE_INTEGRITY_ERROR`/73 instead of migrating or recreating it, and refuse unsafe or unavailable WAL/SHM state without repairing it as detailed in [the compatibility record](docs/roadmap/README.md#task-122-contract-record).
- Preserve committed Handoff, Project and Channel outcomes when later physical completion or inbox-marker work fails, returning the committed result with a warning and leaving pending physical work for normal recovery.
- Return typed `STORAGE_INSPECTION_UNAVAILABLE` refusals for storage-preparation contention and write-protected Handoff, Project and Channel operations, including HTTP 503 on the affected Handoff/Project routes, with state-specific recovery that preserves original requests and never authorizes permission or actor changes.
- Inspect readable write-protected Installations correctly for preflight, send replay-only and daemon admission, including committed WAL data, without changing their live files.
- Append schema 12 for current Handoff reading/processing evidence and one recipient comment, emitting deterministic format-4 backups while preserving format-1 through format-3 readers and legacy evidence as `unrecorded`.
- Normalize Handoff and Memo content references through schema 11 and format-3 backups without repacking existing bodies or rewriting retained receipts, preserving exact content/digests, excluding derived fetch caches and restoring fresh private content records without operational receipts.
- Keep complete historical Memo reads, receipt output and unchanged-body title edits available after an input-cap reduction, while enforcing the current cap on newly supplied bodies and disclosing large-content Git-history retention.
- Replace the previously unreleased Channel commands, codes, schema-11 tables and format-3 representation with the rebuilt surface before its first publication, with development homes/snapshots carrying the replaced representation refused rather than converted.

### Fixed

- Return `STORAGE_INSPECTION_UNAVAILABLE`/75 for expected Memo CLI startup/open storage denial instead of `INTERNAL_ERROR`/1, preserving original recovery mode and requests; clarify send replay private-scratch requirements and permitted MCP recovery, and point internal-error diagnosis at the selected Sorage home with a fallback when no log was written.

- Give Vault-open, configuration-access and unsafe-path failures recovery actions that apply to the actual state, preserving typed codes and avoiding initialization or verification advice that cannot work while storage is inaccessible.
- Diagnose Vault policy and filesystem checks accurately in `sorage doctor`, and refuse unreadable or non-regular initialization configurations instead of treating an existing Installation as new.

### Upgrade disclosure

The intended v0.1.3 release combines M8, M9, the EPIC-017/EPIC-018 corrections and EPIC-019 Handoff reporting under [ADR-0033](docs/architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release). The schema-7-through-12 upgrade is one-way. Stop old writers and scheduling/push, make and verify a backup with the matching old executable, and complete its separate restore drill before replacement. Require `preflight` to report `upgrade_required`, then run `sorage backup run` once with the new executable in that disabled-scheduling/push context; require `compatible` and verify the new backup before Vault verification. Covered reads do not perform this migration.

Rollback restores the retained pre-upgrade backup with its matching old executable into a fresh home and Vault; preserve the upgraded home, keep old writers away from it, and account for the absence of later data and operational receipts in the restored Installation. Format-3 backups require a compatible reader. The [operations procedure](docs/ops/README.md#m9-shared-content-upgrade-and-rollback) and [assembled qualification map](docs/implementation-tips/mcp-and-channel-qualification.md) describe the supported boundaries and native drills.

These capabilities belong to the unpublished source candidate; the published v0.1.2 distribution predates them. [The roadmap](docs/roadmap/README.md) owns delivery status. Version changes, installation, consumer activation and publication retain separate authorization.

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
