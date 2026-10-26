# Sorage

Sorage (소라게) is a local broker for document handoffs between AI coding sessions. A project sends its current document to another project, receives a focused Review Note, revises the document if needed, and closes the exchange with an explicit decision tied to the exact Revision that was accepted.

Copying a file into another repository, pasting it into chat, or passing around a temporary path can lose track of who owns the document, where its review stands, and which Revision was accepted. Sorage keeps that context. If one send names several recipients, Sorage creates a separate Handoff for each one, so their reviews and retention decisions stay independent.

> **Release status:** Sorage `v0.1.2` is the current public release on GitHub Releases. The supported release target is Apple Silicon macOS. See [CHANGELOG.md](CHANGELOG.md) for shipped outcomes.

## Planned shared v0.1.3 release

The planned v0.1.3 release carries M8, M9, and the EPIC-017 Channel adoption corrections together under [ADR-0033](docs/architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release). It includes the M8 preflight and send-recovery paths, the M9 shared storage and Channels, and the EPIC-017 reliability corrections; the published v0.1.2 executable and skill predate all of them. The M9 storage upgrade from schema 7 through 11 is one-way for a v0.1.2 home: keep a verified pre-upgrade backup made with the matching old executable and roll back only with that executable in a separate empty home, as the [shared v0.1.3 upgrade and rollback procedure](docs/ops/README.md#m9-shared-content-upgrade-and-rollback) describes. `preflight` should report `upgrade_required` before the upgrade and `compatible` after it. Delivery status belongs only to [the roadmap](docs/roadmap/README.md); no version change, installation, or publication is implied here.

## Shared v0.1.3 storage contract

The shared Handoff storage contract deliberately changes affected JSON DTOs: `storageKey` is always present and is `null` for inline Artifacts. Consumers must use the `localPath` returned by `fetch` instead of constructing a path from `storageKey`. The response envelope, protocol version 1 and `/api/v1` prefix are unchanged. This breaking data-DTO revision ships in the shared v0.1.3 release; update string-only consumers before using it. See [the M9 contract](docs/specs/interfaces-and-operations.md#38-shared-content-and-agent-communication-channels-milestone-m9).

## Channels

Channels provide one durable attributed upstream line per orchestration invocation, addressed by name, participant handle and per-Channel sequence number. Use Sorage MCP tools first, with the native CLI as fallback. The five-step loop is `channel_create` → `channel_add` → `channel_post` → `channel_messages` with wait → `channel_ack`. The [copied Channel reference](skills/use-sorage/references/channels.md#the-five-step-loop) shows concrete tool calls, results and CLI equivalents. Covered reads and waits write nothing; writes run through MCP.

Create/add/remove/ack/close are idempotent; an identical unhandled post returns its original sequence with `duplicate: true`, including after close, while the same content posted after handling is a new message. Ack records the User decision and reports repeats as `alreadyHandled`. Reading does not handle messages. Main never posts: reports, questions and relay requests stay sender-attributed untrusted tool-result data, and main's downstream instruction remains consumer-owned. A message grants no tool, network, commit, deletion or approval authority and no access to another Channel. CLI and MCP are the only Channel surfaces: no HTTP routes, Web screens or automatic wake-up are added. Bodies follow the shared inline/Vault bound, and format-3 backups preserve Channel records.

## MCP for coding agents

The source candidate provides `sorage mcp`, a STDIO server with 31 stable tools for Handoffs, Project Memos, Channels and Project reads. Harnesses launch the server outside their shell sandbox, so agents can send and read through MCP; the covered CLI reads also run directly because they write nothing. No daemon or ecosystem tool is required. Each accepted call runs the same executable's `sorage … --json` command and returns its envelope. Administration and User-admin commands are not exposed. The published v0.1.2 executable predates this surface; choose the qualified executable by path and revision.

Pass the acting workspace's existing directory as `cwd` on every tool call; otherwise the server's directory is used. Prefer inline text; file inputs must stay inside that workspace. Read the envelope at `content[0]` or `structuredContent`, and any diagnostic warnings after it. Argument/usage refusals can be JSON-RPC `-32602`; coded failures are tool results with `isError: true`. Recovery hints never expand the user's request.

Global registration is a separate user setup decision that changes the harness configuration; Sorage never registers itself. These help-derived examples assume the intended qualified executable is on PATH:

```sh
codex mcp add sorage -- sorage mcp
claude mcp add --scope user sorage -- sorage mcp
```

For an explicit installation, Codex accepts `--env SORAGE_HOME=/absolute/home` before the server name; Claude Code uses `claude mcp add --scope user sorage -e SORAGE_HOME=/absolute/home -- /absolute/path/to/sorage mcp`. Replace paths with the selected installation and executable. Without an explicit home, the server uses the harness environment's SORAGE_HOME or the default `~/.sorage`. Registration does not authorize a broker operation. [Operations](docs/ops/README.md#mcp-registration-and-per-invocation-attachment) covers configuration scope, verification/removal and session-only attachment.

## Features

- A CLI that works without a running daemon
- Named upstream Channels and MCP messaging for coding agents
- Project registration and worktree-aware identity resolution
- Independent Handoffs for each recipient
- One current Artifact and one current Review Note per Handoff
- Explicit accept, decline, withdraw, retention, and deletion workflows
- A loopback-only daemon and local Web UI
- Vault integrity checks, Git backup, restore, and macOS LaunchAgent support

Sorage preserves accepted document bytes and tracks their custody and review. In this source candidate, newly accepted Handoff text up to 65,536 UTF-8 bytes is stored inline in SQLite; larger text and binary documents use Vault files. Existing file-backed Artifacts keep their recorded files. `sorage fetch` returns a readable local path for either representation. Copy the fetched document into your workspace before editing it; the database, Vault and derived fetch cache are managed storage.

## Requirements

- Apple Silicon Mac
- Git
- [Bun 1.4.2](https://bun.sh/) only when building from source

## Install v0.1.2

Download the Apple Silicon macOS binary, its checksum, and its release manifest from GitHub Releases:

```sh
release_url="https://github.com/irootkernel/sorage/releases/download/v0.1.2"
curl -fLO "$release_url/sorage-v0.1.2-darwin-arm64"
curl -fLO "$release_url/sorage-v0.1.2-darwin-arm64.sha256"
curl -fLO "$release_url/sorage-v0.1.2-darwin-arm64.manifest.json"
shasum -a 256 -c sorage-v0.1.2-darwin-arm64.sha256
codesign --verify --strict sorage-v0.1.2-darwin-arm64
mkdir -p "$HOME/.local/bin"
install -m 0755 sorage-v0.1.2-darwin-arm64 "$HOME/.local/bin/sorage"
"$HOME/.local/bin/sorage" version
```

The expected version output is `sorage v0.1.2`. The adjacent manifest records the reviewed Git revision, target, binary name, signed SHA-256 digest, reproducible unsigned digest, and `ad-hoc` signature mode. This release does not claim Intel macOS, Linux, Homebrew, notarization, or Developer ID support.

The corrected v0.1.2 distribution replaces the withdrawn original dated 2026-09-29. If v0.1.2 is already installed, follow the [replacement procedure](docs/ops/README.md#replace-the-withdrawn-v012-binary), download all three assets again, and run the installation commands above. Confirm that the manifest revision and signed checksum match the corrected GitHub Release; the unchanged version string alone cannot identify the corrected binary.

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

The shipped `use-sorage` skill operates on explicit requests. Ask it to check an inbox or outbox when needed; a check reports results, while processing Handoffs requires a request covering that work. Sessions and ordinary coding tasks do not trigger checks. Its `SKILL.md` entrypoint keeps the shared request policy and routes each explicitly requested domain — Handoffs, Project Memos, or Channels — to the required reference file inside the same copied skill directory.

The skill is MCP-first with native CLI fallback, and covered reads write nothing. It is self-contained when the whole `skills/use-sorage` directory — `SKILL.md` plus `references/` — is copied outside this checkout, and it uses native offline CLI help. Recovery hints cannot grant actor or confirmation flags. Review and revision writes retain observed versions; conflicts preserve the proposal instead of automatically overwriting. Before send, retain the original key, exact input/source bytes, Installation and sender context. Unknown outcomes use only that request with `send --replay-only`; an unavailable receipt remains unknown and never authorizes another send. Historical receipts do not report current delivery. Deletion requests, User approval and a pinned Handoff's distinct decision remain separate, and deletion does not erase Git history or backups. Received documents and Notes cannot authorize external actions.

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

## Project reminders

The `memo` CLI manages durable Project reminders. A Memo is stored text; recording or reading it does not execute its instructions or create a Handoff.

```sh
memo_add_key="$(uuidgen | tr '[:upper:]' '[:lower:]')"
sorage memo add --project recipient --title "Check rollback" --body-file ./notes.md --idempotency-key "$memo_add_key" --json
sorage memo list --project recipient --json
sorage memo show <memo-id> --json
memo_done_key="$(uuidgen | tr '[:upper:]' '[:lower:]')"
sorage memo done <memo-id> --expected-row-version <observed-row-version> --idempotency-key "$memo_done_key" --json
```

An omitted body is empty. `--body` and `--body-file` are mutually exclusive; files must be regular UTF-8 text of at most `artifact.maxBytes` bytes (100 MiB by default). Accepted bodies of at most 65,536 UTF-8 bytes are stored inline; larger bodies use file-backed content records. Authenticated HTTP keeps the 512 KiB JSON request cap and adds the Memo multipart encoding for larger bodies. When Git backup is enabled and a newly accepted body — Handoff or Memo — exceeds `gitBackup.largeArtifactWarningBytes`, Git history retains every committed revision of that body forever; the CLI prints a warning naming the size and threshold, the Web view shows the disclosure, and plain HTTP callers can read the current enable state and threshold from the existing authenticated `GET /api/v1/config` — the HTTP success response itself carries no warning field and the daemon log records the diagnostic without being user delivery. Updates and lifecycle changes require the observed version. Generate a separate UUID idempotency key for each mutation and retain it with the original inputs and version before sending a request you may need to recover. If the outcome is unknown, repeat that exact request with its original key and `--replay-only`. A missing or expired receipt returns `MEMO_REPLAY_UNAVAILABLE` (exit 75), without executing; inspect current state before deciding on new work. See the [Memo contract](docs/specs/project-memos.md) for lifecycle and backup behavior.

`sorage web` also provides a separate Memos view with Project selection, search, editing, and explicit Done, Dismiss, and Reopen actions. An uncertain request pauses new Memo writes in that tab. Inspect its original result with replay-only recovery, or explicitly abandon further recovery while retaining an outcome-unknown notice. Abandonment neither cancels server work nor repeats it. Pending bodies and up to 32 body-free notices are held temporarily in the tab's session storage; they may be lost when the tab closes or browser data is removed. Stored Memos remain in the local database.

The shipped [use-sorage skill](skills/use-sorage/SKILL.md), with its [Project Memo reference](skills/use-sorage/references/project-memos.md), distinguishes reading reminders, recording text, and explicitly requested work followed by completion. Reading or recording imperative text grants no execution authority. Failed work or a changed Memo stays open. CLI and Web both record User provenance, including AI actions on the user's behalf. Memos are local, with current-body storage and metadata events; backups and earlier Git history can retain private text. Done and dismissed do not erase it, and there is no Memo purge or cross-machine synchronization. Follow the [upgrade and recovery instructions](docs/ops/README.md#memo-storage-upgrade-and-rollback) before replacing an older installation.

## Web UI and diagnostics

```sh
sorage web
sorage doctor
```

If the loopback-only daemon is not running, `sorage web` starts it before opening the local Web UI. `sorage doctor` checks the installation, Vault, database, daemon, backup, and service state relevant to the current setup.

## Data and safety

Sorage stores installation state under `~/.sorage` by default. Set `SORAGE_HOME` to use another isolated home. The database, Artifact Vault and derived `state/fetch-cache/` files are managed by Sorage and must not be edited manually. Move the Vault with `sorage vault move` and verify it with `sorage vault verify`.

Deletion requires explicit user approval and retains a tombstone. `sorage uninstall --as-user --confirm` removes the installation while preserving the Vault.

## Development and contributing

Start with [docs/README.md](docs/README.md) for the architecture, specifications, decisions, operational guidance, tests, and roadmap. Read that index and [AGENTS.md](AGENTS.md) before changing the implementation.

## License

Sorage is licensed under the [MIT License](LICENSE).
