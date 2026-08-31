# Architecture Decisions

## ADR-0001: Shared application core with CLI and daemon adapters; serialized writers

- **Status:** Accepted (amended 2026-08-22)
- **Date:** 2026-08-22

### Context

A CLI is needed for AI sessions and a Web UI for the local User, and the original version of this decision made a local daemon the only operational writer so that rules would not be duplicated and writers would not race.

Review found that premise wrong on both counts: the rules live exactly once in the application layer that every adapter calls, and concurrent writers are already excluded by SQLite WAL write transactions plus Row Version compare-and-set, which behave identically whether one process or five are running.

What the daemon genuinely provides is Web serving, the backup scheduler, and garbage-collection timing; requiring it for the core loop instead drags PID files, LaunchAgent installation, port conflicts, daemon discovery, bearer tokens, browser sessions, graceful drain, and restart-required configuration semantics in front of the first `send` — roughly twenty tasks and the entire remote attack surface, none of which protect data integrity.

### Decision

There is one domain and application implementation, and every adapter — CLI, HTTP, Web — enters through it.

The CLI links the application layer in-process and MUST NOT require a running daemon for any domain operation; writes from any process are serialized by SQLite write transactions together with the committed filesystem intent log of ADR-0013.

The daemon exists to serve the Web UI, run the scheduler, and run garbage collection, and it is introduced in milestone 0.2.

### Alternatives considered

- Daemon as the sole writer, as in v0.3.0 — rejected: its stated justification does not hold, and it makes the 0.1 CLI loop depend on the full daemon lifecycle and its network surface.
- Pure filesystem convention with no database — rejected: no transactional Row Version, no atomic fan-out, and no queryable inbox at 10,000 Handoffs.
- A shared git repository as the exchange medium — rejected: merge conflicts become a user-facing workflow, and review state has no home outside commit messages.

### Consequences

- One transaction boundary and one set of domain rules, regardless of which adapter is running.
- The 0.1 release ships a complete handoff loop with no network listener at all.
- Every process, not just the daemon, MUST drain the intent log at start (RUN-002).
- Cross-process exclusion for configuration, Vault move, and backup relies on `O_EXCL` lockfiles under `~/.sorage/run/`.

## ADR-0002: One recipient per Handoff with independent fan-out

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Several Projects may need the same source document, but their feedback, revisions, and acceptance decisions diverge immediately after delivery.

### Decision

One Handoff has exactly one recipient, and a multi-recipient send creates independent Handoffs correlated only by a Dispatch Group UUID.

### Alternatives considered

- One Handoff with a recipient list and group review state — rejected: a single Review Note and a single Revision counter cannot represent recipients that disagree.
- Broadcast with per-recipient read receipts only — rejected: it removes the per-recipient review and revision loop that is the point of the product.

### Consequences

- Ownership and next actor are unambiguous for every Handoff.
- Notes, Revisions, acceptance, and deletion diverge per recipient by construction.
- Initial storage is duplicated once per recipient.
- There is no group-level bulk revise.

## ADR-0003: Retain only the current Artifact natively

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Native document history would make Sorage a version-control system, which the surrounding ecosystem already provides, and it would multiply Vault size by the revision count.

### Decision

Sorage stores one current Artifact plus a Revision counter; a revision creates a new immutable Artifact, switches the reference, and unlinks the old file after the commit.

Git backup may retain older content as external history, but that history is not native Handoff history, and revisions that are created and replaced between two backup runs are not preserved anywhere.

### Alternatives considered

- Full revision history inside the Vault — rejected: duplicates Git for a workflow whose value is the current document, and grows without bound at a 100 MiB artifact limit.
- Copy-on-write snapshot per revision with retention policy — rejected: adds a retention policy, a pruning job, and a second recovery story for no MVP use case.

### Consequences

- Vault size tracks live Handoffs, not their edit count.
- Intra-day revision history is a documented data-loss property, stated in the charter and the CLI help.
- Rollback to a previous Revision is not a product feature.

## ADR-0004: Store Projects and bindings in SQLite

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Project records participate in Handoff foreign keys and in every actor resolution, so keeping them in YAML while Handoffs live in SQLite would require non-atomic dual writes on every registration.

### Decision

Project metadata and directory bindings are stored in SQLite, and `config.yaml` keeps only Installation settings.

### Alternatives considered

- Projects in `config.yaml` — rejected: dual writes with no shared transaction, and a hand-edited file can silently break Handoff references.
- A separate JSON registry file next to the database — rejected: same dual-write problem with an extra file format and no referential integrity.

### Consequences

- Project and Handoff relations are transactional and enforced by foreign keys.
- There is no YAML reconciliation step at startup.
- Project data is managed through commands and the Web UI, never by editing configuration.

## ADR-0005: Keep the operational SQLite database outside the Vault

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

The Vault is a Git working tree, and SQLite plus its WAL and SHM files are binary, constantly rewritten, and meaningless in a diff.

### Decision

The database lives under `~/.sorage/state/`, and backup exports deterministic JSON and JSONL snapshots into the Vault instead.

### Alternatives considered

- Commit the SQLite file itself — rejected: every backup rewrites a large binary blob, conflicts are unresolvable, and WAL and SHM state is not portable.
- Keep the database inside the Vault but gitignored — rejected: one careless `git add -A` publishes it, and the restore story becomes ambiguous about which copy is authoritative.

### Consequences

- Git diffs of the backup are readable and reviewable.
- Restore reconstructs the database from snapshots rather than copying it (BKP-021).
- The database needs its own local snapshot mechanism under `~/.sorage/state/backups/`.

## ADR-0006: Git backs up current state and may preserve history

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Backup runs unattended on a schedule, and an unattended process that resolves Git conflicts is a process that silently destroys data.

### Decision

Before backup, Sorage exports current snapshots and verifies current Artifacts, commits only managed paths, and pushes fast-forward only; it never force pushes, rebases, merges, resolves conflicts, or rewrites history.

### Alternatives considered

- Automated conflict resolution or force push to keep the remote green — rejected: unattended overwrite of a divergent remote is silent data loss.
- No Git integration at all — rejected: leaves the Vault with no off-machine recovery path, which is charter goal G-05.

### Consequences

- A divergent remote is a visible, manual failure rather than an invisible overwrite.
- Deleted content may remain reachable in prior commits, which deletion messaging MUST state (BKP-019).
- Snapshot, commit, and push outcomes are recorded separately in `backup_runs`.

## ADR-0007: Stabilize CLI and API before MCP

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

MCP would bind an external protocol to Handoff semantics that are still being proven, and every later change to those semantics would become a breaking change for MCP clients.

### Decision

The MVP delivers the CLI and the local HTTP API; MCP is deferred until the contracts and their real usage are stable.

### Alternatives considered

- Ship MCP inside the MVP — rejected: freezes an unproven contract and adds a third adapter to every domain change.
- MCP first with no CLI — rejected: AI sessions in this ecosystem drive tools through the shell, and a CLI is required for the discovery policy in ADR-0018.

### Consequences

- Agents integrate through `sorage ... --json` and the `use-sorage` skill in the MVP.
- The application layer stays free of MCP-specific types so the adapter can be added later without domain change.

## ADR-0008: Accepted, Declined, and Withdrawn are terminal

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

A handoff needs an end, and it needs more than one kind of end: the recipient may take the document, the recipient may refuse it, or the sender may recall it before anyone has read it.

An accepted Revision is a claim about a specific set of bytes, and that claim is worthless if the Handoff can later be edited.

### Decision

`accepted`, `declined`, and `withdrawn` are terminal review states; a terminal Handoff is immutable in Artifact content, Revision, and Review Note, and any further change uses a new Handoff, normally linked through `supersedesHandoffId`.

Retention operations — pin, unpin, archive, unarchive — and the deletion request, approve, and reject operations remain available and increment Row Version (LIFE-005, LIFE-017).

### Alternatives considered

- Allow reopening a terminal Handoff — rejected: destroys the meaning of "accepted Revision 3" and gives the audit trail no fixed point.
- Keep `accepted` as the only terminal state — rejected: leaves refusal and recall unrepresentable, which is one half of the `changes_requested` deadlock found in review.

### Consequences

- Every Handoff has a reachable end state without human intervention.
- `HANDOFF_TERMINAL` replaces the v0.3.0 `HANDOFF_CONSUMED` error code, and the event name `HANDOFF_ACCEPTED` no longer collides with it.
- Archiving is permitted only from a terminal state, which is now consistent rather than contradictory.

## ADR-0009: Copy-only Artifact import

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

The sender's file belongs to the sender's workspace, and Sorage is a custodian of a byte-exact copy, not a filesystem manager.

### Decision

The MVP imports by copy only; the source file stays in place and unmodified, and the managed copy changes only through `revise`.

### Alternatives considered

- Move the source into the Vault — rejected: destroys the sender's working file and makes a failed send unrecoverable.
- Symlink or hardlink the source — rejected: later edits in the sender's workspace would silently mutate the custodied bytes and invalidate the recorded SHA-256.

### Consequences

- The recorded SHA-256 is a stable claim about what was handed off.
- Vault size is the sum of live Artifacts, duplicated per fan-out recipient.
- Import cost is one streaming copy plus one hash pass.

## ADR-0010: Deletion requires User approval

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Any AI session running as this operating-system user can invoke the CLI, so an unapproved delete path would let one automated participant destroy another participant's evidence.

### Decision

Projects, Workspaces, and the User may request deletion; only the User approves or rejects it, approval detaches the current Artifact and Review Note and leaves a tombstone, and approving a pinned Handoff requires the distinct `--confirm-pinned <id>` argument.

### Alternatives considered

- Recipient-initiated immediate deletion — rejected: one agent could erase a handoff another agent is still working on, with no record of intent.
- No deletion at all — rejected: the Vault would accumulate obsolete and sensitive documents with no supported way to remove them.

### Consequences

- Deletion is two-phase and always leaves a tombstone plus an event.
- Pinned deletion needs two distinct confirmations, which cannot be satisfied by a single blanket `--confirm`.
- Deletion never claims to purge Git history.

## ADR-0011: Sorage is an Aquarium subtool with independent runtime identity

- **Status:** Superseded by ADR-0012
- **Date:** 2026-08-22

### Context

Sorage is maintained inside the Aquarium repository, whose existing `plugins/aquarium/` tree contains the Codex plugin and its skills. The document-handoff runtime needs a separate CLI, daemon, Web UI, local state, and release lifecycle. Mixing these boundaries would couple the Handoff domain to plugin implementation details and make later standalone or server deployment harder.

### Decision

Place all Sorage source under `tools/sorage/`. Use `Sorage` and `소라게` as product names, `sorage` as the binary, `~/.sorage/` as the local home, `SORAGE_HOME` as the test or advanced override, and `xyz.rootkernel.sorage` as the macOS service label. Roadmap governance uses global `EPIC-NNN` and `TASK-NNN` identifiers rather than a product-specific prefix.

Sorage core does not import from `plugins/aquarium/`. A future Aquarium skill adapter calls Sorage through the public CLI, local API, or application boundary and does not reimplement Handoff semantics.

### Alternatives considered

- A standalone repository from the start — rejected at the time as premature separation before any code existed; this is the alternative that ADR-0012 later adopts on evidence.
- Sorage as an `aquarium` CLI subcommand — rejected: couples the Handoff runtime to the plugin release lifecycle and to Codex plugin loading.

### Consequences

- Aquarium gains a coherent aquatic-creature subtool without turning Sorage into an `aquarium` CLI subcommand.
- Existing Aquarium plugin behavior remains isolated from Sorage implementation work.
- Sorage can be built, tested, packaged, and potentially extracted independently.
- Repository-level validation must cover both Sorage and the pre-existing Aquarium surfaces.

## ADR-0012: Standalone repository `irootkernel/sorage`

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Placing Sorage inside the Aquarium repository breaks that repository's own release process in four independently verified ways.

Its commit gate `hooks/task_commit_gate.py:202-223` classifies a whole repository as a roadmap repository when a tracked path contains `roadmap` alongside lifecycle patterns, so adding a Sorage roadmap would force every Aquarium commit, including its own release commits, through the `task-commit` handler.

Its documentation validator `tests/validate.rb:1741` checks every `**/*.md` in the repository for hard wrapping and link resolution, and the v0.3.0 Sorage document set alone produced 40 violations on day one.

Its marketplace manifest declares `sparse_paths: []`, so every plugin user would clone the full Sorage source, and its task handler rejects external roadmap paths (`task-handler/SKILL.md:16`), which means documents and code must live in the same repository.

Every sibling tool in this ecosystem is already a standalone repository that Aquarium installs as development tooling, and the working copy's remote is already `git@github-irootkernel:irootkernel/sorage.git`.

### Decision

Sorage is a standalone repository, `irootkernel/sorage`, holding both its code and its Source of Truth.

Aquarium and its sibling tools are development tooling only and are never source dependencies (GEN-009, NFR-014); Sorage requires no change to any of them.

Runtime identity is unchanged: binary `sorage`, home `~/.sorage/` with `SORAGE_HOME` override, LaunchAgent label `xyz.rootkernel.sorage`, and global `EPIC-NNN` and `TASK-NNN` identifiers.

### Alternatives considered

- Keep Sorage under `tools/sorage/` inside Aquarium, as ADR-0011 decided — rejected: the commit gate, the repository-wide Markdown validator, the non-sparse marketplace clone, and the handler's external-roadmap rule each break independently.
- Split into a documentation repository plus a code repository — rejected: the task handler requires the roadmap and the code it governs to live in one repository, and two repositories would double the identifier and traceability surface.

### Consequences

- Aquarium's release process, validation suite, and marketplace payload are untouched by Sorage work.
- Sorage owns its own `Makefile`, CI, and release gates from the repository root (NFR-013, NFR-016).
- Sorage adopts the ecosystem Markdown rules voluntarily rather than by enforcement (NFR-015).
- Interoperability moves to a shipped `use-sorage` skill instead of an in-Aquarium handler (ADR-0018).

## ADR-0013: Intent-log storage protocol and unique Artifact path slots

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

The v0.3.0 path scheme `artifacts/<handoff-id>/current/<stored-name>` produces the same destination path when a revise supplies a file with the same name, which forces an in-place overwrite, contradicts the requirement to stage a new immutable Artifact, and loses the previous content permanently in the crash window.

The v0.3.0 create protocol renamed the staged file into its final path before committing the transaction; under WAL snapshot isolation another connection's garbage collector cannot see the uncommitted row, so it may legitimately conclude the file is unreferenced and delete it, leaving a committed Handoff with no bytes and no record of what happened.

Neither Node nor Bun exposes `flock`, and `open(..., 'wx')` was verified to work, so cross-process exclusion has to be built from `O_EXCL` lockfiles; all candidate SQLite drivers are synchronous, so a transaction callback containing `await` interleaves statements from different logical transactions on one connection.

### Decision

Every Artifact is stored at `artifacts/<handoff-id>/<artifact-id>/<stored-name>` with `storageKey` as the sole path authority, so no two Artifacts can ever collide.

Create, fan-out, revise, and deletion approval commit their `pending_fs_ops` intents in the same transaction as the domain change, execute the filesystem work afterwards, and clear the intents in a second transaction; every process drains outstanding intents idempotently at start, and garbage collection runs only after the drain and only outside a grace window.

Artifact durability follows write, `fsync(file)`, rename, `fsync(parent directory)`, then the commit that sets `materialized = 1`; `UnitOfWork.run` is synchronous and lint forbids `await` inside it; filesystem I/O never happens inside a transaction.

### Alternatives considered

- Rename before commit with an in-memory reservation held by the writer — rejected: the reservation is invisible to other processes and does not survive a crash, so it only works in the single-process model ADR-0001 abandoned.
- Rename after commit with no durable log — rejected: a crash between commit and rename leaves a row pointing at a missing file with no record of intent, which is unrepairable rather than merely incomplete.

### Consequences

- All-or-nothing fan-out becomes a pure database property; the N renames afterwards are replayable.
- Recovery is deterministic: source gone and destination present means done, both gone means integrity failure, and nothing is ever fabricated.
- Reads of a Handoff whose Artifact is not yet materialized return `ARTIFACT_MATERIALIZING` instead of a missing file.
- Seven crash points must be enumerated and tested by the fault-injection filesystem adapter.

## ADR-0014: Review state machine extension

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

In v0.3.0 a Handoff in `changes_requested` could deadlock permanently: accept fails while a Note exists, the recipient may not delete the Note, the sender may not clear it without a successful revision, and an identical-content revise fails with `NO_CONTENT_CHANGE`, so a sender who correctly judges that no change is needed has no move at all.

The only documented escape, administrative Note removal, had no CLI command, no endpoint, and no event type, so it did not exist.

There was also no way to recall a handoff sent by mistake, no way to refuse one, and no way to ask a question without attaching a document, because the Handoff required a non-null current Artifact.

### Decision

The review state machine gains the terminal states `declined` and `withdrawn`, recipient withdrawal of the current Review Note whichever actor authored it, and a bounded sender no-change resolution — `revise --no-change --reason <text>`, at most one consecutive, tracked by `consecutiveNoChangeResolutions`.

Administrative removal becomes a real operation: `sorage review remove <id> --as-user --confirm`, `DELETE /api/v1/handoffs/{id}/review-note`, and the `REVIEW_NOTE_REMOVED` event.

Naming follows the new state set: `consume` becomes `accept`, `fetch` keeps its name, and Handoff and Project `restore` become `unarchive` so that `restore` names only disaster recovery.

### Alternatives considered

- Comment threads on a Handoff — rejected: charter goal G-03 keeps review semantics deliberately small at one current Note, and threads reintroduce a conversation system the ecosystem does not need here.
- An administrator-only escape hatch as the sole deadlock exit — rejected: it puts a human in the loop on every disagreement between two automated participants, which defeats the product goal.
- A nullable current Artifact so a Handoff can be question-only — rejected: it weakens the core invariant everywhere; `send --body <text>` materializes a Markdown Artifact instead.

### Consequences

- Every reachable state has a next move that does not require a human.
- The `withdrawn` transition is gated on both `firstFetchedAt` and `reviewEngagedAt` being null, so a document the recipient has already read or already reviewed cannot be silently recalled.
- Only `fetch` and the Web artifact-content endpoint set `firstFetchedAt`; `get` and the Web detail screen are pure reads that record nothing, so merely listing or inspecting a Handoff never forecloses withdrawal.
- Deletion approval requires a terminal state, so every tombstone is terminal and the tombstone rules are a strict subset of the terminal-state rules (LIFE-018).
- Terminal-state rules are uniform across three states and enforced by `HANDOFF_TERMINAL` (LIFE-017).
- The rename touches the CLI, the API, the event names, and the error codes at once, which is affordable only because no code exists yet.

## ADR-0015: Multi-binding, worktree-aware identity model

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Git worktrees are in daily use on the target machine: `git worktree list` shows one for sanho, two for gaori under `/Users/draccoon/Workspace/Orca/worktree/`, and four for podway under `/private/tmp/podway-*`.

Under the v0.3.0 constraint `UNIQUE(projectId, installationId)` a Project has exactly one binding, so every one of those worktrees resolved to an Unregistered Workspace, which may send but may not receive — the review sessions that most need to receive a handoff were structurally excluded, and each worktree produced its own fragmented outbox.

Directory moves, unbinding, and flipping the unregistered-sender policy each silently downgraded a sender's identity with no error.

### Decision

A Project may hold many bindings on one Installation; the only uniqueness constraint is `UNIQUE(installationId, directory)`.

A binding of kind `git_repository` stores the git common directory, resolved with `git rev-parse --git-common-dir`, so every worktree of a registered repository resolves to that Project; nested bindings are legal, the deepest match wins, a `git_repository` binding beats a `directory` binding when both match, and two matches of the same kind at the same depth fail with `AMBIGUOUS_PROJECT` naming both Projects.

`--as <project-slug>` overrides working-directory resolution for a Project that has a binding, an unregistered send from inside or above a registered binding fails with `SENDER_IDENTITY_DOWNGRADE` unless `--allow-unregistered` is given, and working-directory resolution is documented as provenance rather than authorization.

### Alternatives considered

- One binding per Project, as in v0.3.0 — rejected: makes worktrees and multi-checkout layouts unusable as recipients, which is the common case on this machine.
- Register each worktree as its own Project — rejected: registry churn on every temporary worktree, and the outbox and inbox of one logical project fragment across ephemeral identities.
- Path-prefix resolution with no git awareness — rejected: a worktree path shares no prefix with the main checkout, so prefix matching cannot connect them.

### Consequences

- A Project's inbox is the same from any worktree of its repository.
- Identity loss becomes a loud failure with a named error code instead of a silent downgrade.
- `FORBIDDEN_ACTOR` is documented as a workflow guardrail, not an operating-system boundary (SEC-013, SEC-021).

## ADR-0016: Bun toolchain with `bun:sqlite` and Homebrew distribution

- **Status:** Accepted
- **Date:** 2026-08-22
- **Amended:** 2026-09-01 — the pinned Bun version moved from `1.3.14` to `1.4.0` after the 0.3 MVP gate passed; the pin mechanics, storage, test runner, and distribution decisions below are unchanged, and the full verification gate including the reproducible-build check of `make package` was re-run green under the new pin.

### Context

v0.3.0 left the runtime, SQLite driver, test runner, and distribution mechanism entirely unspecified, while the ecosystem convention is TypeScript tested with Vitest executed through Bun and gated by a single `make test`.

Local verification showed the three-way conflict directly: Bun 1.3.14 does not provide `node:sqlite`, so a `node:sqlite` design cannot be tested under the ecosystem's own runner; `better-sqlite3` is a native `.node` addon that does not embed cleanly into a single compiled binary.

Distribution has the same constraint from the other side: a binary downloaded outside a package manager is quarantined by Gatekeeper, and an npm global install pushes a Node runtime requirement onto the user.

Sibling repositories pin their toolchain hard — podway's `Makefile:3-6` raises `$(error)` on a version mismatch — because an unpinned runtime silently changes SQLite and fsync behavior.

### Decision

The toolchain is Bun `1.4.0`, pinned in `.bun-version` at the repository root and mirrored in `package.json` `engines`, with `bun:sqlite` for storage, Vitest executed through Bun for unit, integration, and contract tests, Playwright for Web end-to-end from 0.2, `commander` for the CLI surface, comment-preserving `yaml` for configuration, and Vite with Preact for the Web application.

`make build` compiles with `bun build --compile` into `dist/sorage` and `make package` produces the ad-hoc signed binary and the Homebrew formula inputs; `make test` is the single verification gate and `make test-prepare` asserts the pinned Bun version; verification runs locally on macOS with no hosted CI service (the GitHub Actions workflow added in TASK-002 was removed by the owner's direction on 2026-08-24).

The workspace is five packages — `core`, `adapters`, `cli`, `daemon`, `web` — with the domain and application boundary enforced by lint rather than by package count.

### Alternatives considered

- Node with `node:sqlite` — rejected: absent from Bun 1.3.14, so the ecosystem test runner could not execute the storage layer at all.
- `better-sqlite3` — rejected: a native module conflicts with single-binary distribution and adds a build toolchain requirement for every contributor.
- npm global install as the distribution channel — rejected: requires a user-side Node runtime and still leaves Gatekeeper quarantine unsolved for the compiled path.

### Consequences

- Comment preservation in `config.yaml` becomes achievable, which is why CFG-018 now requires it instead of disclaiming it.
- `bun:sqlite` is synchronous, which is what makes the synchronous `UnitOfWork` of ADR-0013 natural rather than awkward.
- Bun does not use libuv, so `F_FULLFSYNC` durability must be verified empirically in the foundation milestone.
- Twelve planned packages collapse to five, and the dependency boundary is enforced by a lint rule in `make test-prepare`.

## ADR-0017: Browser authentication and the local network boundary

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

v0.3.0 mentioned Host and Origin validation only as advisory prose, never as a requirement, so a DNS-rebinding page could reach `GET /api/v1/handoffs/*` on the loopback daemon and read every Handoff; CORS and CSRF tokens do not stop reads.

The planned browser model was a same-origin session cookie plus a CSRF token, but a cookie is an ambient credential the browser attaches to any request it is tricked into making, and multipart upload is a simple request with no preflight.

No response carried `Content-Security-Policy`, `frame-ancestors`, or `X-Content-Type-Options`, and the configuration schema allowed binding to the name `localhost`, which can resolve off-loopback.

### Decision

The daemon validates the `Host` header against `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` on every request before routing, and rejects anything else.

Sorage uses no cookies anywhere: `sorage web` opens the browser with a one-time secret in the URL fragment, the SPA exchanges it at `POST /api/v1/session` for a session token held in `sessionStorage`, and every request carries `Authorization: Bearer`.

Every response carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`; the API token is at least 32 random bytes, stored `0600`, compared in constant time, and rotatable with `sorage token rotate`; the bind-address enum is limited to `127.0.0.1` and `::1`.

### Alternatives considered

- Cookie session plus CSRF token, as in v0.3.0 — rejected: the cookie is attached automatically by the browser, multipart uploads bypass preflight, and none of it prevents a rebinding read.
- No Web authentication because the daemon is loopback-only — rejected: DNS rebinding turns any page the User visits into a reader of every Handoff.

### Consequences

- The entire CSRF token mechanism is removed rather than hardened, because there is no ambient credential left to forge.
- A fragment secret never reaches the server in a request line and never lands in logs or history.
- The Host allowlist keeps the name `localhost` for the browser's `Host` header while the bind enum does not, and the two lists are deliberately different.

## ADR-0018: Ecosystem interoperability through a shipped `use-sorage` skill

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

Notifications, MCP, and in-Aquarium handlers are all out of scope, which left the discovery loop open: nothing gives a recipient's AI session a reason to run `sorage inbox`, so the charter's central claim that the recipient discovers work through its inbox had no trigger.

The established ecosystem pattern is that each tool ships `skills/use-<name>/` in its own repository and the shared development setup installs it, which is how the sibling tools solve exactly this problem.

A separate public handoff handler inside Aquarium is not merely unbuilt; it was explicitly rejected there, recorded in commit `56c297e` as a rejected alternative.

"Handoff" is also the fourth use of that word in this ecosystem, after plan handoff, a `handed_off` task state, and writer handoff files.

### Decision

Sorage ships `skills/use-sorage/SKILL.md` in this repository from milestone 0.1, stating the policy that a session checks `sorage inbox --json` at session start and before starting a task, supported by `inbox --wait [--timeout <s>]` for long-polling.

The Podway `ExternalReference` artifact slot is the named integration seam for tools that need to reference a Handoff; plan handoff, writer handoff, and documentation sync in sibling tools are adjacent concerns and explicitly out of scope.

The entity keeps the name "Handoff", and the interoperability documentation states the distinction from the other uses.

### Alternatives considered

- An `$aquarium:handoff` handler inside Aquarium — rejected: already rejected in Aquarium commit `56c297e`, and it would require changing a repository Sorage must not change (GEN-011).
- Renaming the entity to avoid the ecosystem collision — rejected: Sorage is the tool that owns this concept, and the other three uses are internal mechanisms of their own tools.

### Consequences

- The discovery loop closes inside milestone 0.1 with no daemon, no notifications, and no MCP.
- Adoption is a policy statement in a skill file rather than an enforced hook, which is a documented limitation.
- The optional `handoff.inboxMarker` configuration key exists as a secondary, default-off discovery aid.

## ADR-0019: Three milestones and roadmap governance

- **Status:** Accepted
- **Date:** 2026-08-22

### Context

The v0.3.0 roadmap was 105 sequential tasks in which the first end-to-end handoff appeared at task 64, or 61% of the way through, and the CLI foundation landed at task 60 after fourteen tasks had already shipped CLI commands, guaranteeing rework.

There was no MVP cut line at all — 222 MUST requirements and 3 SHOULD requirements were all in scope for one release — and the active task status was stored in three places at once, which drifts on the first edit.

A single active slot occupied by a task `In Review` also made it impossible to separate an implementation session from a review session, and review findings had nowhere to land.

### Decision

The MVP is delivered in three milestones with independent release gates: 0.1 CLI core, 0.2 daemon with local HTTP API and Web UI, and 0.3 Git backup, restore, scheduler, LaunchAgent, and packaging.

The roadmap allows one task `In Progress` plus one task `In Review`, uses Definition-of-Done tiers Chore, Standard, and Contract, and keeps every status pointer in a single "Active pointer" section.

The authority order has ten ranked levels — `required-specification.md`, accepted ADRs, `domain-and-architecture.md`, `interfaces-and-operations.md`, `security-reliability.md`, `testing-and-acceptance.md`, `traceability.md`, `roadmap.md`, `implementation-guide.md`, then examples and schemas — while `product-charter.md` and `future-work.md` are non-normative context.

The task table carries `Milestone`, `Requirements`, and `Design Gate impact` columns, and Epic and Task identifiers are immutable once committed.

### Alternatives considered

- A single strict active slot, as in v0.3.0 — rejected: implementation and review cannot overlap, and a review finding has no slot to occupy.
- Unrestricted parallel tasks — rejected: loses the single-writer discipline the roadmap depends on and reintroduces the status drift this decision exists to remove.

### Consequences

- The full `send → inbox → review set → revise → accept` loop is reachable by roughly task 30 of about 60.
- Each milestone has an observable release gate, and the MVP is complete only when the 0.3 gate passes.
- Every requirement carries a milestone, so scope is a column rather than an argument.
- Task status lives in exactly one place, which keeps status-only edits reviewable.

## ADR-0020: A binding requires a working tree, so a bare Git repository cannot be bound

- **Status:** Accepted
- **Date:** 2026-08-28

### Context

Section 22.1 defines the workspace root of a `git_repository` binding as the main working tree, that is the parent of the stored git common directory. The EPIC-003 cold validation accepted the residual risk that the Source of Truth never defined binding a bare repository: a bare repository's common directory is itself, it has no parent working tree, and the downgrade guard that ships with `send` (PRJ-019) would evaluate a workspace root derived from a path with no meaning. EPIC-005 must settle the semantics before the guard ships with `send`.

### Decision

A directory binding must name a working tree. `project add` and `project bind` refuse a directory that is a bare Git repository with a `CONFIG_INVALID` error naming the reason and the recovery of binding a non-bare clone, and the workspace root of every `git_repository` binding is therefore always a real directory. Section 22.1 of `domain-and-architecture.md` records the same rule normatively.

### Alternatives considered

- Allow bare-repository bindings and define the workspace root as the bare directory itself | a bare repository holds no working files, so a sender workspace rooted there can never source a document, while the fold of every future worktree question would still be undefined.
- Allow bare-repository bindings and leave the workspace root undefined for them | an undefined root makes the two-case downgrade guard of section 22.3 unanswerable exactly where it must decide.
- Reject at send time instead of bind time | the guard would then depend on runtime state that configuration already had, and the invalid binding would sit accepted in the registry until the first send fails.

### Consequences

- The workspace-root derivation stays total: the parent of a stored common directory is always a real working tree.
- Binding a bare repository fails with a clear configuration error instead of an undefined workspace identity at send time.
- A user who keeps documents in a bare repository's sibling checkout binds that checkout, which is the directory the working tree actually lives in.

## ADR-0021: Handoff lists filter by inclusive `updatedAt` bounds carried in the cursor contract

- **Status:** Accepted
- **Date:** 2026-08-31

### Context

WEB-003 requires Handoff lists to support sender, recipient, state, retention, and date filters. The EPIC-007 cold validation recorded the residual that the date filter had no contract to ride on: section 19's cursor filter set named only state, sender, recipient, and the two retention toggles, so offering a date filter would have been a material change to the versioned pagination contract, and the settlement was deferred to an EPIC-009 task before the 0.3 release could claim WEB-003 fully met.

### Decision

The shared cursor filter set of section 19 gains two inclusive bounds, `updatedSince` and `updatedUntil`, each an ISO-8601 UTC instant matched against `updatedAt`. The bounds are part of the cursor's filter hash, so a cursor minted under one bound set fails with `CURSOR_INVALID` under another, exactly like every other filter. The CLI exposes them as `--updated-since` and `--updated-until` on `inbox` and `outbox`, the HTTP listing accepts them as query parameters, and the Web list view offers them as URL-addressable inputs that survive a reload. A bound that is not a well-formed UTC instant, or a `since` later than its `until`, fails validation with `CONFIG_INVALID` before any listing runs.

### Alternatives considered

- Filter on `createdAt` instead of `updatedAt` | the listing's sort and cursor keyset are `updatedAt`, so a createdAt bound could exclude rows the cursor still pages through and split one logical page across both sides of the bound.
- Exclusive bounds | an exclusive upper bound silently drops the row a user watching "today" most likely means, and inclusivity matches how the state and retention filters treat their boundary values.
- A local-date shorthand like `2026-08-31` resolved against the daemon's zone | the daemon's zone is not the user's zone, and WEB-003 never promised wall-clock semantics, so the contract keeps one unambiguous instant shape.

### Consequences

- WEB-003's date filter rides the same cursor, CLI, HTTP, and Web surfaces as every other filter, with no second pagination path to maintain.
- The section 19 amendment is a reviewed, re-keying contract change: the cursor filter hash gains the two bound keys even when they are absent, so cursors minted before the change stop validating and fail `CURSOR_INVALID` after the upgrade. Cursors are short-lived pagination tokens that the contract already frees from surviving a Sorage upgrade, so the re-key rides that established boundary.
- Clients wanting a wall-clock range convert to UTC instants themselves, which keeps the server free of timezone configuration.
