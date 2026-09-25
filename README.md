# Sorage

Sorage (소라게) is a local broker for document handoffs between AI coding sessions. A project sends its current document to another project, receives a focused Review Note, revises the document if needed, and closes the exchange with an explicit decision tied to the exact Revision that was accepted.

Copying a file into another repository, pasting it into chat, or passing around a temporary path can lose track of who owns the document, where its review stands, and which Revision was accepted. Sorage keeps that context. If one send names several recipients, Sorage creates a separate Handoff for each one, so their reviews and retention decisions stay independent.

> **Release status:** Sorage `v0.1.1` is the current public release on GitHub Releases. The supported release target is Apple Silicon macOS. See [CHANGELOG.md](CHANGELOG.md) for shipped outcomes.

## Features

- A CLI that works without a running daemon
- Project registration and worktree-aware identity resolution
- Independent Handoffs for each recipient
- One current Artifact and one current Review Note per Handoff
- Explicit accept, decline, withdraw, retention, and deletion workflows
- A loopback-only daemon and local Web UI
- Vault integrity checks, Git backup, restore, and macOS LaunchAgent support

Documents remain ordinary files. Sorage tracks their custody and review, but it does not edit them or replace version control, chat, issue tracking, or multi-agent orchestration.

## Requirements

- Apple Silicon Mac
- Git
- [Bun 1.4.2](https://bun.sh/) only when building from source

## Install v0.1.1

Download the Apple Silicon macOS binary, its checksum, and its release manifest from GitHub Releases:

```sh
release_url="https://github.com/irootkernel/sorage/releases/download/v0.1.1"
curl -fLO "$release_url/sorage-v0.1.1-darwin-arm64"
curl -fLO "$release_url/sorage-v0.1.1-darwin-arm64.sha256"
curl -fLO "$release_url/sorage-v0.1.1-darwin-arm64.manifest.json"
shasum -a 256 -c sorage-v0.1.1-darwin-arm64.sha256
codesign --verify --strict sorage-v0.1.1-darwin-arm64
mkdir -p "$HOME/.local/bin"
install -m 0755 sorage-v0.1.1-darwin-arm64 "$HOME/.local/bin/sorage"
"$HOME/.local/bin/sorage" version
```

The expected version output is `sorage v0.1.1`. The adjacent manifest records the reviewed Git revision, target, binary name, signed SHA-256 digest, reproducible unsigned digest, and `ad-hoc` signature mode. This release does not claim Intel macOS, Linux, Homebrew, notarization, or Developer ID support.

## Build from source

```sh
git clone https://github.com/irootkernel/sorage.git
cd sorage
make package
mkdir -p "$HOME/.local/bin"
install -m 0755 dist/sorage "$HOME/.local/bin/sorage"
```

Ensure `$HOME/.local/bin` is on `PATH`, then confirm the installed binary:

```sh
sorage version
```

The packaged executable includes the Bun runtime, so the installed binary does not need a separate Bun installation.

## Quick start

Initialize Sorage and register two projects:

```sh
sorage init
sorage project add --name sender --slug sender --dir /path/to/sender
sorage project add --name recipient --slug recipient --dir /path/to/recipient
```

During project setup, add `.sorage/` to each project's `.gitignore` unless an existing entry already ignores it. The directory contains derived local state; the CLI does not update project ignore files automatically.

To stop a Project from sending or receiving new Handoffs, run `sorage project archive <slug>`. `sorage project unarchive <slug>` resumes new work; both commands keep existing Handoffs. If a Project directory has moved, use `sorage project rebind <slug> --from <recorded-path> --to <existing-path>` after the new directory exists. `project show <slug>` prints the recorded path, including when the old directory has vanished.

The shipped `use-sorage` skill operates on explicit requests. Ask it to check an inbox or outbox when needed; a check reports results, while processing Handoffs requires a request covering that work. Sessions and ordinary coding tasks do not trigger checks.

Send a document from the sender project:

```sh
cd /path/to/sender
sorage send --to recipient --title "Proposal review" --file ./proposal.md
```

In the recipient project, inspect the inbox and fetch the current Artifact:

```sh
cd /path/to/recipient
sorage inbox
sorage get <handoff-id>
sorage fetch <handoff-id>
```

The recipient requests a revision with a Review Note:

```sh
sorage review set <handoff-id> --text "Clarify the rollback procedure."
```

The sender updates the document and revises the same Handoff:

```sh
cd /path/to/sender
sorage revise <handoff-id> --file ./proposal.md
```

Back in the recipient project, inspect and fetch the new Revision before accepting it. Use the `revision` and `rowVersion` reported by `sorage get`:

```sh
cd /path/to/recipient
sorage get <handoff-id>
sorage fetch <handoff-id>
sorage accept <handoff-id> --expected-revision <revision> --expected-row-version <row-version>
```

Run `sorage help` or `sorage help <command>` for the complete command surface.

## Web UI and diagnostics

```sh
sorage web
sorage doctor
```

If the loopback-only daemon is not running, `sorage web` starts it before opening the local Web UI. `sorage doctor` checks the installation, Vault, database, daemon, backup, and service state relevant to the current setup.

## Data and safety

Sorage stores installation state under `~/.sorage` by default. Set `SORAGE_HOME` to use another isolated home. The Artifact Vault is managed by Sorage and must not be edited manually; move it with `sorage vault move` and verify it with `sorage vault verify`.

Deletion requires explicit user approval and retains a tombstone. `sorage uninstall --as-user --confirm` removes the installation while preserving the Vault.

## Development and contributing

Start with [docs/README.md](docs/README.md) for the architecture, specifications, decisions, operational guidance, tests, and roadmap. Read that index and [AGENTS.md](AGENTS.md) before changing the implementation.

## License

Sorage is licensed under the [MIT License](LICENSE).
