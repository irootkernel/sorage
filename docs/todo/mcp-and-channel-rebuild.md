# MCP access, zero-write reads and Channel rebuild

This is the execution dossier for [EPIC-018](../roadmap/README.md#epic-018-mcp-access-zero-write-reads-and-channel-rebuild). The roadmap alone records lifecycle state, ordering and eligibility. [Proposed ADR-0034](../architecture-decision-records/README.md#adr-0034-sorage-mcp-adapter-zero-write-reads-and-the-channel-rebuild) records the material decision, and TASK-121 must adopt its contracts into the [required specification](../specs/required-specification.md), [interface section 38](../specs/interfaces-and-operations.md#38-shared-content-and-agent-communication-channels-milestone-m9) and the other canonical owners before product implementation; those adopted contracts, not this dossier, become normative. Until then the current specifications and accepted decisions remain authoritative. This dossier preserves the approved planning direction through delivery and is retired at Epic closeout.

## Problem and product outcome

Sorage exists so that AI agents can exchange documents and reports, yet an agent running in a sandbox cannot use it. Every command, including `inbox`, `memo list` and `channel messages`, runs startup recovery, the migration path and log writes against the Sorage home before it does anything else, so a caller that cannot write the home cannot even read. Writes need the home and sometimes the Vault, which sandboxes deny; EPIC-017 classified and documented that refusal instead of removing it.

The M9 Channel surface is also hard for agents to use. It requires participant UUIDs and role assertions that protect nothing, a row version whose only succeeding value is known in advance, three processes per handled message, retained idempotency material with replay-only recovery, and guidance dominated by exceptions. Its write path rolls back and retries on every concurrent commit, and its acceptance observers ran outside sandboxes, so the real-environment failures were never exercised.

On 2026-10-23 Master directed that agents must send and read Handoffs, Project Memos and Channel messages from any environment, including a sandbox that cannot write anything, and that the Channel surface be rebuilt with Handoff- and Memo-level simplicity before the shared v0.1.3 release. The product outcome has four parts:

- `sorage mcp`, an MCP server that the agent harness launches outside the shell sandbox, so tool calls send and read even from a fully read-only sandbox.
- Read commands that write nothing, so sandboxed shells can read and wait directly.
- A rebuilt Channel whose loop needs only a Channel name, participant handles and message sequence numbers.
- `revise --body`, so no messaging operation needs a temporary file.

## Confirmed findings

| ID | Confirmed behavior | Evidence at `0d57778` | Owner |
|---|---|---|---|
| S1 | Every command, reads included, runs `drainAtStart`, opens and migrates the database, and renders failures through a path that writes the installation log; the production migration plan takes `BEGIN IMMEDIATE` even when nothing is pending. A caller that cannot write the home therefore cannot read or wait. | `drainAtStart` calls in `apps/cli/src/main.ts`, `apps/cli/src/memo-commands.ts` and `apps/cli/src/channel-commands.ts`; `packages/adapters/src/sqlite/migrator.ts`; `logCommandFailure` in `apps/cli/src/main.ts` | TASK-122, TASK-123 |
| S2 | Write commands need write access to the home and, for file-backed bodies and recovery, to the Vault. A sandboxed agent receives only the typed write-protected refusal and the documented consequence. | `packages/adapters/src/storage-contention.ts`; [security-reliability section 17](../specs/security-reliability.md#17-m9-messaging-trust-boundary-and-writable-storage) | TASK-124 |
| C1 | Channel commands address participants by UUID and gate main-role operations with `--as-participant <uuid>` or `--as-user`. Any process can pass `--as-user`, and `channel show` exposes the main participant's UUID. | `requireMainRole` in `packages/core/src/channels.ts`; `apps/cli/src/channel-commands.ts` | TASK-123 |
| C2 | `channel handle` requires `--expected-row-version` although the only value that can succeed is known in advance, and the same already-handled state returns different codes depending on the number passed. | `processingRowVersion` handling in `packages/core/src/channels.ts` | TASK-123 |
| C3 | Handling one message takes three processes: a wait that returns previews newest first, a full read, and the handle. The default wait timeout of 300 seconds exceeds common agent tool-call limits. | `waitForChannelMessages` in `packages/core/src/channels.ts`; the `--timeout` option in `apps/cli/src/channel-commands.ts` | TASK-123 |
| C4 | Every Channel mutation runs a coherence loop that compares `PRAGMA data_version` across staging and commit. Any concurrent commit by another poster forces a rollback and retry, which later gained jittered backoff. | `runChannelMutation` in `packages/core/src/channels.ts`; `inTransaction` in `packages/adapters/src/channels.ts` | TASK-123 |
| C5 | Channel submission carries idempotency receipts, receipt-consistency checks that can fire only on stored corruption, a separate replay-only path that repeats submit validation, and unknown-outcome and new-attempt rules that the agent must apply. | `submitMessageReplayOnly` and the receipt parsers in `packages/core/src/channels.ts` | TASK-123 |
| C6 | Channel reads resolve a working-directory Project they never use, so a read or wait can fail with `AMBIGUOUS_PROJECT`. | `resolveCommandActor` in `apps/cli/src/channel-commands.ts` | TASK-123 |
| D1 | The Channel adapter copies the Memo transaction helper and much of the Memo content-commit and list machinery instead of sharing it. | `inTransaction` in `packages/adapters/src/memos.ts` and `packages/adapters/src/channels.ts` | TASK-123 |
| G1 | The shipped Channel guidance is long, exception-driven and without a worked example. The acceptance observers ran the binary outside their sandboxes, and the walkthrough was accepted per step rather than as one continuous run. | `skills/use-sorage/references/channels.md`; [the skill acceptance record](../implementation-tips/use-sorage-acceptance.md) | TASK-125 |
| R1 | `sorage revise` accepts only `--file` or `--no-change`, so revising from a read-only workspace needs a temporary file elsewhere. | `revise` options in `apps/cli/src/main.ts` | TASK-124 |

## Approved decisions

- **Messaging from any environment.** Agents send and read Handoffs, Project Memos and Channel messages whether or not their shell can write the Sorage home, the Vault or the workspace.
- **`sorage mcp`.** Add a STDIO MCP server, registered globally like Mulgae and Gaori. Agent harnesses launch MCP servers in their own process context outside the shell sandbox, so tool calls work from a fully read-only sandbox. This lifts the MCP deferral of [ADR-0007](../architecture-decision-records/README.md#adr-0007-stabilize-cli-and-api-before-mcp) for the messaging domains once the Channel surface below is rebuilt; the future-work MCP candidate moves into this Epic. An alternative proposal reviewed on 2026-10-23 supplied the MCP direction, and this dossier adopts it with the following deliberate modifications:
  - The server runs each tool call as a `sorage … --json` child process of the same executable, so the CLI stays the single behavior source and no second in-process integration exists.
  - Channel tools are built on the rebuilt Channel surface, not on the current one.
  - The read path uses SQLite's own read-only WAL access instead of hand-built WAL reconstruction.
  - Bodies are passed inline, and a file argument is accepted only inside the call's workspace (`cwd`), so the unsandboxed server cannot read a file the caller's sandbox denies.
  - Only messaging tools are exposed; administration and User-admin operations stay CLI-only.
- **Zero-write reads.** Read commands open the database read-only and perform no startup recovery, migration, cleanup or log write. Writers keep WAL sidecars persistent so SQLite's read-only WAL access always applies; only when the sidecars are absent, meaning no connection is open and the main file is complete, a coherent in-memory copy of the main file serves the read.
- **Channel rebuild.** Replace the Channel surface in full, as described in the target design below. Schema 11 and the format-3 Channel representation are replaced in place, because no published release and no real home carries them.
- **`revise --body`.** Revisions accept inline text, like `send`, `memo` and `channel post`.
- **Shared release.** v0.1.3 ships after this Epic, together with M8, M9 and EPIC-017.
- **Process.** Reviews judge behavior. A wording-only finding is fixed in the same candidate without another review or observation cycle, and no requirement or guidance grows exception clauses to cover a defect.

## Target design

### MCP tools

| Domain | Tools |
|---|---|
| Handoff | send, inbox (with wait), outbox, get, events, fetch, review read, review set, review withdraw, revise, accept, decline, withdraw |
| Project Memo | list, show, add, update, done, dismiss, reopen |
| Channel | create, add, remove, post, messages (with wait), ack, close, list, show |
| Project | list, show |

- Every tool accepts an optional `cwd`, so actor resolution matches a direct CLI run from that directory.
- Every tool returns the CLI's JSON envelope as structured content and as text, sets `isError` on a failure envelope, and carries accurate read-only and destructive annotations, so harnesses can approve reads without prompting.
- Not exposed: init, config, vault, backup and restore, uninstall, daemon, token, Project registration, pin, unpin, archive, unarchive and deletion.
- The application layer stays free of MCP types, as ADR-0007 requires.

### Zero-write read path

- **Covered commands:**
  - Handoff `inbox`, `outbox`, `get`, `events` and the review reads
  - Memo `list` and `show`
  - Project `list` and `show`
  - Channel `messages`, `list` and `show`
- **How a read opens storage:**
  - It opens with the existing read-only admission connection and checks the schema through the existing history-inspection path.
  - It never runs `drainAtStart`, migration, spool sweeps or log writes.
  - Its failures render without creating the log file.
- **Writer connections** set `SQLITE_FCNTL_PERSIST_WAL` so that `-wal` and `-shm` remain after close.
- **Sidecars-absent fallback:** it loads the main file into a read-only in-memory database and checks file identity before and after the copy. It is implemented only if the feasibility probe shows it is needed.
- **Rejected:** `immutable=1` and hand-built WAL reconstruction.

### Channel CLI

```text
sorage channel create <name> [--title <t>] [--main <handle=main>]
sorage channel add <channel> <handle> --role worker|judge
sorage channel remove <channel> <handle>
sorage channel post <channel> --from <handle> --kind report|question|relay_request [--to <handle>] [--ref <text>] (--body <t> | --body-file <p>)
sorage channel messages <channel> [--all] [--after <seq>] [--from <h>] [--kind <k>] [--limit <n>] [--wait [--timeout <s=60>] [--interval <s=2>]]
sorage channel ack <channel> <seq>... [--note <t>]
sorage channel close <channel>
sorage channel list [--state open|closed|all]
sorage channel show <channel>
```

- **Addresses.** A Channel is addressed by a globally unique name; its UUID is also accepted, and UUID-shaped names are refused. Participants are addressed by handle, and messages by their per-Channel sequence number. There are no participant UUIDs, idempotency keys, row versions or role flags.
- **Idempotent operations.**
  - `create` returns the existing open Channel with `existing: true` for the same name and main handle. It refuses a name whose Channel is closed with `CHN_CLOSED`, and refuses a different main handle.
  - `add` with the same handle and role returns the participant; `remove` and `close` repeat harmlessly.
  - `ack` reports already-handled messages as `alreadyHandled`, not as an error, and commits nothing when any sequence number is unknown.
- **Post retry by content.**
  - An unhandled message with the same Channel, sender, kind, `--to`, `--ref` and body digest is returned with `duplicate: true` instead of a new message.
  - The check runs inside the posting transaction and before the closed and removed checks, so a retry after `close` still reports the duplicate.
  - An identical post after main has already handled the original creates a new message.
- **Upstream only.** Workers and judges post. Main's instructions to agents stay on the consumer's own dispatch surface ([ADR-0030](../architecture-decision-records/README.md#adr-0030-agent-communication-channels-and-shared-content-storage-in-m9)), and a relay request names its target with `--to`.
- **Listing and waiting.**
  - `messages` returns unhandled messages oldest first with full inline bodies, a `bodyPath` to the immutable Vault file for file-backed bodies, and `bodyPending: true` for a body that is not yet activated.
  - `--wait` returns at once when a message matches. Otherwise it polls until an arrival or the timeout, reported as `meta.timedOut`.
  - `--after <seq>` restricts results to later messages.
- **Provenance.** Channel mutations record the User actor, as Memo does, with the participant handle in event metadata. No working-directory Project is resolved, and message bodies stay out of logs and events.
- **Storage.**
  - Three tables: `channels`, `channel_participants` and `channel_messages`, under schema 11 renamed `channels-v2` so that a development home holding the old schema 11 is refused.
  - Shared parts reused: the content store, event ledger, cursor codec and Memo body capture. The Memo transaction helper moves to a shared adapter module used by both domains.
  - A post re-reads the Vault binding inside its transaction only when it staged a file, instead of comparing `PRAGMA data_version`.
- **Removed.**
  - Assignments.
  - The context-session, context-node and context-attempt options, and the new-attempt rule.
  - Participant UUIDs and role assertions.
  - Row-version handling.
  - Receipts and replay-only.
  - The coherence loop and backoff.
  - `contentActivating` and `bodyPreviewUnavailable`.
  - Per-error recovery overrides.
  - The writable-storage disclosure rules.

### The five-step loop

```text
# main
sorage channel create aq-run-42 --json
sorage channel add aq-run-42 worker-1 --role worker --json
# worker-1, through the CLI or the Channel post MCP tool from a read-only sandbox
sorage channel post aq-run-42 --from worker-1 --kind report --body "Tests pass; see the linked PR." --json
# main
sorage channel messages aq-run-42 --wait --json
sorage channel ack aq-run-42 1 --json
```

## Feasibility probes

TASK-121 records these probes before it accepts ADR-0034, and revises the record if either fails:

1. The compiled executable opens a live Sorage database read-only under a sandbox that denies every write. Writer connections hold persistent WAL sidecars, and the probe also covers the case where the sidecars are absent.
2. A harness-launched MCP server performs a Sorage write while the agent's shell sandbox is read-only, using `codex exec -s read-only` with a per-invocation `-c mcp_servers.…` entry and an isolated `SORAGE_HOME`. No global configuration changes.

## Non-goals

- A workspace relay or daemon broker for sandboxed writes; the MCP server makes it unnecessary.
- Harnesses that run MCP servers inside their own sandbox, and Linux container sandboxes that cannot execute the macOS binary.
- Channel HTTP routes, Channel Web screens and automatic wake-up.
- Per-participant credentials; SEC-013 cooperative attribution remains the trust model.
- Changes to Handoff or Memo semantics beyond removing read side effects and adding `revise --body`.
- Edits to Aquarium or another consumer repository, global MCP registration on a real machine, installation, publication and broker operations.

## Ordered work and acceptance

| Owner | Deliverable and evidence |
|---|---|
| TASK-121 | Design-only Contract. Accept or revise ADR-0034 after recording both feasibility probes; add dated amendments to ADR-0007, ADR-0030 and ADR-0033; adopt the read-command exceptions to RUN-002, RUN-009 and NFR-009, the rewritten CHN requirements, the new MCP requirements and `revise --body` in the required specification; settle interface section 38, a new MCP section, sections 15 and 16, the security trust boundary that replaces section 17, and the rewritten AJ-28 and AJ-29 with a sandboxed messaging journey; update the release-gate rows and the CHANGELOG for v0.1.3; and populate every EPIC-018 Requirements cell and reverse-index row. Evidence: `bun run check:sot` and `git diff --check`; an independent contract review classifies every interface, golden-snapshot and skill change with its migration impact and confirms the in-place replacement of schema 11 and the format-3 Channel representation; a recorded reason why runtime tests do not apply. |
| TASK-122 | Implement the zero-write read path for Handoff, Memo and Project reads, persistent WAL sidecars for writers, and log-free read failure rendering. Evidence: compiled-binary tests under a sandbox that denies every write show each read command, including `inbox --wait`, succeeding with output identical to an unsandboxed run and unchanged home and Vault inventories; reads proceed while another process holds `BEGIN IMMEDIATE`; `make test` passes. |
| TASK-123 | Rebuild Channels on the accepted contract: the schema, core, adapter, CLI, format-3 representation, error and event catalogs, the shared transaction helper, and replacement tests and goldens. Evidence: concurrent posting processes with one waiter lose, duplicate and misattribute nothing; an identical post returns `duplicate: true`; Channel reads succeed in the write-denying sandbox; export and restore preserve Channels, sequence numbers and handled state; a development home with the old schema 11 is refused; Memo tests pass unchanged on the shared helper; `make test` passes. |
| TASK-124 | Implement `sorage mcp` and `revise --body`. Evidence: a process in a sandbox that denies every write and all network acts as an MCP client to a host-spawned `sorage mcp` and sends and reads Handoffs, Memos and Channel messages; tool results equal the CLI envelopes; a file argument outside the call's workspace is refused; no administration tool is listed; `revise --body` creates a Revision from inline text; `make test` passes. |
| TASK-125 | Update the shipped `use-sorage` skill and the public and operations guidance: MCP-first instructions with the CLI as fallback, no sandbox or writable-path caveats, a Channel reference built around the five-step loop, and documented global MCP registration for Codex and Claude Code. Evidence: skill resource tests and `make test`; independent observers run AJ-29 with real agents, namely a Codex worker under `codex exec -s read-only` with Sorage MCP attached per invocation, a sandboxed Claude Code worker and a main participant, completing the loop in one continuous run from the copied skill, and repeat AJ-26; a failed step is fixed by simplifying the surface or guidance. |
| TASK-126 | Requalify the v0.1.3 candidate and prepare Epic acceptance. Evidence: the complete `make test` gate, AJ-24 to AJ-29 and the sandboxed messaging journey on the exact candidate, a rerun isolated v0.1.2-to-candidate upgrade with the documented old-binary backup and restore drill and the preflight transitions, consolidated CHANGELOG and release notes, and a verified local package; lasting information is promoted and this dossier is retired. |

Each Task runs its narrowest meaningful checks before `make test` and its independent review. No Task relies on a later Task to fix its own correctness or acceptance gaps.

## Verification scenarios

- A process under `sandbox-exec` that denies every write (home, Vault, `$TMPDIR` and workspace) runs the CLI reads `inbox`, `inbox --wait`, `get`, `memo list` and `channel messages --wait` successfully, with output identical to an unsandboxed run and unchanged home and Vault inventories.
- In the same sandbox, a process acting as an MCP client to a host-spawned `sorage mcp` sends and reads a Handoff, adds and completes a Memo, and runs the Channel loop.
- `codex sandbox` under the read-only and workspace-write policies reproduces the read results.
- Several concurrent posters, some sandboxed through MCP and some unsandboxed through the CLI, with one waiter, lose, duplicate and misattribute nothing.
- Format-3 export and restore preserve Channels, participants, sequence numbers and handled state.
- AJ-29 completes with real sandboxed agents in one continuous run.
- The isolated upgrade, restore drill and preflight transitions pass, and no developer Sorage home is read or written.

## Consumer coordination

This section is context for later, separately authorized broker operations and grants none.

- Aquarium's 2026-10-20 Channel adoption request targeted the surface this Epic replaces.
- Under [ADR-0029](../architecture-decision-records/README.md#adr-0029-non-executing-send-recovery-and-agent-policy-in-m8), each of the following remains a separate authorization:
  - communicating the replacement Channel contract and the MCP adapter;
  - sharing a candidate;
  - announcing the release.
- TASK-125 documents global MCP registration for Codex and Claude Code. Registering the server on a real machine is a separate user-global setup step.

## Delivery boundaries

This Epic replaces schema 11 and the format-3 Channel representation in place and adds the `mcp` command. It adds no Channel HTTP or Web surface and no daemon feature, edits no consumer repository, and performs no broker operation. Registration allocates no product version by itself: ADR-0034 proposes the v0.1.3 allocation, which becomes canonical only when TASK-121 adopts it. Version changes, tags, publication, installation, global MCP registration, consumer activation, commits and broker operations remain separate authorized actions.

At Epic closeout, promote lasting information to its canonical owners, remove this temporary dossier and its TODO entry, and replace the roadmap's Detailed SOT link with Canonical Outcomes. Do not put lifecycle status or raw runtime identities in this dossier.
