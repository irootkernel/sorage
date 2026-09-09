# Changelog

This file records concise shipped outcomes and the planned next stable release.

## v0.1.1 - Unreleased

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
