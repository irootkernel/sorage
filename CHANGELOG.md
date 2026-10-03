# Changelog

This file records concise shipped outcomes and the planned next stable release.

## v0.1.3 - Unreleased

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
