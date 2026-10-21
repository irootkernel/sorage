# Changelog

This file records concise shipped outcomes and the planned next stable release.

## v0.1.3 - Unreleased

### Added

- Add `sorage preflight` to inspect Installation compatibility without migration or managed-storage writes.
- Add `sorage send --replay-only` to inspect original-request receipts without sending again, preserving unknown outcomes when recovery evidence is unavailable.
- Harden the standalone shipped agent policy for explicit authority, pinned deletion, observed-version conflicts, untrusted content and recovery using original send material.
- Route newly accepted Handoff text of at most 65,536 UTF-8 bytes to SQLite, with larger text and binary content kept in the Vault. Preserve existing file-backed Artifacts and return a readable Vault or derived fetch-cache path from `fetch`.
- Store newly accepted Project Memo bodies through the shared SQLite/Vault interface: up to 65,536 UTF-8 bytes inline and larger text in immutable files, bounded by `artifact.maxBytes`. The existing Memo JSON responses and the 512 KiB JSON request limit are preserved, with multipart create/update added for larger bodies and literal search, title-only edits and the Web recovery gate retained across both storage backends; complete historical reads and original receipt output stay independent of a later lowered input cap, while newly supplied request bodies still meet the current input bounds.
- Add CLI-only agent communication Channels: one main participant with registered Worker/Judge participants, attributed messages with exact-bytes bodies through the shared inline/Vault interface, immutable first handling decisions behind a compare-and-set, pending-inclusive waiting, metadata-only retained receipts with replay-only recovery, and format-3 snapshot export/restore of complete Channel runtime records without operational receipts.

### Changed

- **Breaking data contract:** Handoff `storageKey` fields are always present and may be `null` for inline content. Update string-only consumers; the response envelope, protocol version 1 and `/api/v1` prefix remain unchanged under [ADR-0030](docs/architecture-decision-records/README.md#adr-0030-agent-communication-channels-and-shared-content-storage-in-m9).
- Classify storage-preparation contention in the shared CLI and adapter layers under [SHR-015](docs/specs/required-specification.md): database open, migration, actor-resolution, keyed-lookup expiry-cleanup, startup-drain, and busy write-lock failures on Channel, Handoff, and Project commands return the typed `STORAGE_INSPECTION_UNAVAILABLE` envelope with HTTP 503 and exit 75 — carrying per-surface recovery guidance and asserting the invoking command committed none of the requested changes — instead of an untyped exit-2 message or `INTERNAL_ERROR` exit 1; genuine usage errors keep exit 2, an unreadable configuration on an operational command path is `CONFIG_INVALID` exit 78, replay-only inspection keeps its recovery semantics, and excluded surfaces (Memo, vault, backup, config, doctor, preflight) keep their existing contracts while the daemon's Handoff and Project routes inherit the classification (expected contention answers 503 instead of 500).
- Report committed Handoff outcomes truthfully: `send`, `revise`, and `delete approve` return their committed result with a warning when a post-commit physical activation, unlink, or completion step fails (the pending intent is left to the next process start), every derived inbox-marker refresh warns contained instead of escaping as an untyped failure, Project mutations read their result rows inside the committing transaction so a committed registration can no longer be misreported as an error or a spurious conflict, and each Channel command resolves its actor on its existing open-and-migrated connection with every connection closed ([SHR-015](docs/specs/required-specification.md), [ADR-0033](docs/architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release)).
- Normalize Handoff content references in database schema 9 and Memo references in schema 10 without repacking historical bodies or rewriting retained receipts; add the Channel tables and their event association in schema 11; extend format-3 backups with inline Artifact bodies, selected Memo content files, Channel records and exact digest validation; keep file-backed Artifacts on their existing `artifacts/` paths and omit derived fetch-cache files from backups; restore fresh private records without operational receipts; disclose configured large-content Git-history growth through the CLI and Web guidance.

### Upgrade disclosure

The intended v0.1.3 release carries M8, M9, and the EPIC-017 Channel adoption corrections together under [ADR-0033](docs/architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release). The M9 storage upgrade from schema 7 through 11 is one-way for v0.1.2 homes: keep a verified pre-upgrade backup made with the matching old executable and roll back with it into a separate empty home through the documented restore drill, because older binaries cannot read the upgraded database or format-3 backups. The EPIC-017 corrections land before the release; their entries are appended by their owning Tasks and consolidated at release qualification.

These capabilities are implemented in the source candidate for intended v0.1.3; the published v0.1.2 distribution predates them. [The roadmap](docs/roadmap/README.md) owns delivery status, and [the M8 design entrypoints](docs/README.md#m8-design-entrypoints) and [the M9 design entrypoints](docs/README.md#m9-design-entrypoints) define behavior. Installation, consumer activation and publication require separate authorization.

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
