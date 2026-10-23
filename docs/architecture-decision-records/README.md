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

The daemon exists to serve the Web UI, run the scheduler, and run garbage collection, and it is introduced in milestone M2.

### Alternatives considered

- Daemon as the sole writer, as in v0.3.0 — rejected: its stated justification does not hold, and it makes the M1 CLI loop depend on the full daemon lifecycle and its network surface.
- Pure filesystem convention with no database — rejected: no transactional Row Version, no atomic fan-out, and no queryable inbox at 10,000 Handoffs.
- A shared git repository as the exchange medium — rejected: merge conflicts become a user-facing workflow, and review state has no home outside commit messages.

### Consequences

- One transaction boundary and one set of domain rules, regardless of which adapter is running.
- The M1 release ships a complete handoff loop with no network listener at all.
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

- **Status:** Accepted (distribution decision partially superseded by ADR-0023)
- **Date:** 2026-08-22
- **Amended:** 2026-09-01 — the pinned Bun version moved from `1.3.14` to `1.4.0` after the M3 MVP gate passed; the pin mechanics, storage, test runner, and distribution decisions below are unchanged, and the full verification gate including the reproducible-build check of `make package` was re-run green under the new pin.

- **Amended:** 2026-09-08 — the pinned Bun version moves from `1.4.0` to `1.4.2` to match the user's installed system runtime. The strict version gate remains in force; no product API, configuration, storage, migration, or roadmap lifecycle change is introduced. Validation uses the focused toolchain tests, `make test`, and `make package`.

### Context

v0.3.0 left the runtime, SQLite driver, test runner, and distribution mechanism entirely unspecified, while the ecosystem convention is TypeScript tested with Vitest executed through Bun and gated by a single `make test`.

Local verification showed the three-way conflict directly: Bun 1.3.14 does not provide `node:sqlite`, so a `node:sqlite` design cannot be tested under the ecosystem's own runner; `better-sqlite3` is a native `.node` addon that does not embed cleanly into a single compiled binary.

Distribution has the same constraint from the other side: a binary downloaded outside a package manager is quarantined by Gatekeeper, and an npm global install pushes a Node runtime requirement onto the user.

Sibling repositories pin their toolchain hard — podway's `Makefile:3-6` raises `$(error)` on a version mismatch — because an unpinned runtime silently changes SQLite and fsync behavior.

### Decision

The toolchain is Bun `1.4.2`, pinned in `.bun-version` at the repository root and mirrored in `package.json` `engines`, with `bun:sqlite` for storage, Vitest executed through Bun for unit, integration, and contract tests, Playwright for Web end-to-end from M2, `commander` for the CLI surface, comment-preserving `yaml` for configuration, and Vite with Preact for the Web application.

`make build` compiles with `bun build --compile` into `dist/sorage`; `make test` is the single verification gate and `make test-prepare` asserts the pinned Bun version; verification runs locally on macOS with no hosted CI service (the GitHub Actions workflow added in TASK-002 was removed by the owner's direction on 2026-08-24). ADR-0023 replaces only this decision's Homebrew distribution path and packaging metadata contract; the toolchain, build output, local verification, and ad-hoc signing choices remain in force.

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

Sorage ships `skills/use-sorage/SKILL.md` in this repository from milestone M1. As amended on 2026-09-08, broker operations start only on explicit user request (GEN-014). Inbox and outbox checks report results without processing Handoffs; processing and `inbox --wait [--timeout <s>]` require requests covering that work. Authorized work continues to completion, and later unrelated work does not resume discovery. Requested Sorage project setup ensures `.sorage/` is ignored in `.gitignore` by default without duplicating existing entries (HND-026); the CLI does not edit project ignore files automatically.

The Podway `ExternalReference` artifact slot is the named integration seam for tools that need to reference a Handoff; plan handoff, writer handoff, and documentation sync in sibling tools are adjacent concerns and explicitly out of scope.

The entity keeps the name "Handoff", and the interoperability documentation states the distinction from the other uses.

### Alternatives considered

- An `$aquarium:handoff` handler inside Aquarium — rejected: already rejected in Aquarium commit `56c297e`, and it would require changing a repository Sorage must not change (GEN-011).
- Renaming the entity to avoid the ecosystem collision — rejected: Sorage is the tool that owns this concept, and the other three uses are internal mechanisms of their own tools.
- Keeping session-start and per-task checks — rejected in the 2026-09-08 amendment: this causes repeated unsolicited broker operations during ordinary coding work.
- Treating `.git/info/exclude` as an equal setup default — rejected in the amendment: `.gitignore` records the derived-state policy for every checkout.
- Automatically editing `.gitignore` from the CLI — rejected in the amendment: the requested change belongs to agent setup guidance and requires no new CLI file mutation.

### Consequences

- The discovery loop closes inside milestone M1 with no daemon, no notifications, and no MCP.
- Adoption is a policy statement in a skill file rather than an enforced hook, which is a documented limitation. Users explicitly initiate discovery; pending items do not interrupt unrelated work.
- The 2026-09-08 amendment changes agent policy only: no CLI/API, configuration validation, storage, or migration changes. The configuration schema's `handoff.inboxMarker` description is aligned with HND-026; this documentation-only schema diff is non-breaking and changes no keys, types, defaults, or accepted values. Existing installed skills and repository instructions need a separate update before the new policy takes effect there.
- Required SOT edits cover GEN-014, HND-026, this decision, operational guidance, the configuration schema description, product context, skill acceptance, and the corresponding `TASK-039` acceptance wording. Roadmap identities, lifecycle statuses, and active pointers are unchanged; no new delivery unit is introduced for this documentation amendment.
- The optional `handoff.inboxMarker` configuration key exists as a secondary, default-off discovery aid.

## ADR-0019: Three milestones and roadmap governance

- **Status:** Accepted (release-tag naming partially superseded by ADR-0023)
- **Date:** 2026-08-22

### Context

The v0.3.0 roadmap was 105 sequential tasks in which the first end-to-end handoff appeared at task 64, or 61% of the way through, and the CLI foundation landed at task 60 after fourteen tasks had already shipped CLI commands, guaranteeing rework.

There was no MVP cut line at all — 222 MUST requirements and 3 SHOULD requirements were all in scope for one release — and the active task status was stored in three places at once, which drifts on the first edit.

A single active slot occupied by a task `In Review` also made it impossible to separate an implementation session from a review session, and review findings had nowhere to land.

### Decision

The MVP is delivered in three milestones with independent release gates: M1 CLI core, M2 daemon with local HTTP API and Web UI, and M3 Git backup, restore, scheduler, LaunchAgent, and packaging.

The roadmap allows one task `In Progress` plus one task `In Review`, uses Definition-of-Done tiers Chore, Standard, and Contract, and keeps every status pointer in a single "Active pointer" section.

The authority order has ten ranked levels — `../specs/required-specification.md`, accepted ADRs, `../architecture/README.md`, `../specs/interfaces-and-operations.md`, `../specs/security-reliability.md`, `../specs/testing-and-acceptance.md`, `../specs/traceability.md`, `../roadmap/README.md`, `../implementation-tips/README.md`, then examples and schemas — while `../product/README.md` and `../todo/future-work.md` are non-normative context.

The task table carries `Milestone`, `Requirements`, and `Design Gate impact` columns, and Epic and Task identifiers are immutable once committed.

### Alternatives considered

- A single strict active slot, as in v0.3.0 — rejected: implementation and review cannot overlap, and a review finding has no slot to occupy.
- Unrestricted parallel tasks — rejected: loses the single-writer discipline the roadmap depends on and reintroduces the status drift this decision exists to remove.

### Consequences

- The full `send → inbox → review set → revise → accept` loop is reachable by roughly task 30 of about 60.
- Each milestone has an observable release gate, and the MVP is complete only when the M3 gate passes.
- Every requirement carries a milestone, so scope is a column rather than an argument.
- Task status lives in exactly one place, which keeps status-only edits reviewable.

ADR-0023 renames the three internal milestone snapshots to `M1`, `M2`, and `M3` and separates those local historical labels from the first public product release tag. The three-milestone scope, gates, governance, and task history in this decision remain in force.

## ADR-0020: A binding requires a working tree, so a bare Git repository cannot be bound

- **Status:** Accepted
- **Date:** 2026-08-28

### Context

Section 22.1 defines the workspace root of a `git_repository` binding as the main working tree, that is the parent of the stored git common directory. The EPIC-003 cold validation accepted the residual risk that the Source of Truth never defined binding a bare repository: a bare repository's common directory is itself, it has no parent working tree, and the downgrade guard that ships with `send` (PRJ-019) would evaluate a workspace root derived from a path with no meaning. EPIC-005 must settle the semantics before the guard ships with `send`.

### Decision

A directory binding must name a working tree. `project add` and `project bind` refuse a directory that is a bare Git repository with a `CONFIG_INVALID` error naming the reason and the recovery of binding a non-bare clone, and the workspace root of every `git_repository` binding is therefore always a real directory. Section 22.1 of `../architecture/README.md` records the same rule normatively.

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

WEB-003 requires Handoff lists to support sender, recipient, state, retention, and date filters. The EPIC-007 cold validation recorded the residual that the date filter had no contract to ride on: section 19's cursor filter set named only state, sender, recipient, and the two retention toggles, so offering a date filter would have been a material change to the versioned pagination contract, and the settlement was deferred to an EPIC-009 task before the M3 release could claim WEB-003 fully met.

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

## ADR-0022: CLI version reporting uses the ecosystem compact object and `v` prefix

- **Status:** Accepted
- **Date:** 2026-09-01

### Context

Sorage's version command returned a product and protocol summary in the common CLI success envelope, while sibling ecosystem tools expose a short human identity and a compact standalone JSON object. Release automation and operator probes benefit from one predictable pair of fields, but Sorage's daemon record, HTTP DTOs, and package manifest already use the shared bare semantic version and must not acquire a presentation prefix.

Changing the JSON shape removes `ok`, `data`, `meta.requestId`, and `protocolVersion` from this command, so it is a breaking change to the versioned CLI JSON contract even though it does not change stored data or the HTTP protocol.

### Decision

`sorage version` prints exactly `sorage v<version>` followed by one newline. `sorage version --json` prints exactly the compact standalone object `{"name":"sorage","version":"v<version>"}` followed by one newline and writes no diagnostic to standard error. Both forms remain available before initialization.

The `v` prefix belongs only to these CLI presentation values. The shared runtime source and the package manifest, daemon record, health endpoint, and version endpoint continue to report the bare semantic version. The command has no runtime dependency on another ecosystem tool.

### Alternatives considered

- Keep the common success envelope and add the ecosystem fields inside `data` | consumers would still need a Sorage-specific extraction path, defeating the format alignment.
- Preserve protocol and build-tool versions in the output | those values describe separate compatibility and build concerns and make a simple product-version probe unstable.
- Prefix every version surface with `v` | this would needlessly break daemon and HTTP consumers and would mix presentation syntax into the canonical runtime value.

### Compatibility and migration

The CLI JSON change is breaking: consumers must replace reads of `data.version` with the top-level `version` field and accept its `v` prefix; consumers that need the numeric semantic version may remove that single prefix. No configuration, database, Vault, HTTP, protocol DTO, or package-data migration is required.

### Consequences

- Human and JSON version probes match the ecosystem format byte for byte.
- The version command is a documented exception to the common CLI JSON envelope.
- Daemon, HTTP, and package version contracts remain unchanged and continue to compare against the shared bare runtime version.

## ADR-0023: Public v0.1.0 identity and GitHub Release distribution

- **Status:** Accepted
- **Date:** 2026-09-02
- **Supersedes in part:** ADR-0016 distribution and package-metadata decision; ADR-0019 release-tag naming

### Context

The completed MVP used product versions `0.1.0`, `0.2.0`, and `0.3.0` as labels for three private delivery milestones. None of those snapshots was pushed or published, so exposing the finished product first as `v0.3.0` would imply two public releases that never existed. The same pre-publication history selected Homebrew, but there is no tap in scope and the first supported artifact is only Apple Silicon macOS.

The Source of Truth document version `0.4.0`, API namespace `/api/v1`, configuration schema version, database schema version, and Vault marker schema version identify independent contracts. Rebaselining the public product version must not change any of them.

### Decision

The private delivery snapshots are named `M1`, `M2`, and `M3`. Their existing commits may be retained only as local annotated tags with those exact names; they are not public product releases. The first public product version is `0.1.0`, presented as `v0.1.0` only where the CLI and Git tag contracts already require the `v` prefix.

The initial distribution channel is a GitHub Release. `make package` retains the signed `dist/sorage` source-install output and additionally produces these Apple Silicon macOS release candidates from the same signed bytes:

- `dist/sorage-v0.1.0-darwin-arm64`
- `dist/sorage-v0.1.0-darwin-arm64.sha256`
- `dist/sorage-v0.1.0-darwin-arm64.manifest.json`

The checksum file is exactly `<sha256>  <filename>` plus one newline. The manifest records `version`, `revision`, `target`, `binary`, `sha256`, `reproducibleUnsignedDigest`, and `signature`; `binary` is the asset basename and `target` is `darwin-arm64`. Publication remains a separate task after the reviewed revision, checksum, hosted Release target, and downloaded bytes agree.

### Compatibility and migration

The product-version rebaseline is breaking for consumers that compare version ordering or expect the private `0.3.0` identity. The CLI text and JSON shapes remain compatible with ADR-0022, and HTTP DTO shapes, `/api/v1`, protocol schemas, and stored-data formats do not change. No configuration, database, Vault, HTTP, or protocol migration is required.

### Alternatives considered

- Publish the first release as `v0.3.0` — rejected: it represents internal milestone labels as public release history that never occurred.
- Create and publish a Homebrew tap first — rejected: it expands the release boundary into another repository and adds an unverified distribution system before the first asset exists.
- Rename the Source of Truth, API, or storage schemas to `0.1.0` — rejected: those are independent compatibility identities, not product SemVer.

### Consequences

- Public version probes, workspace manifests, daemon surfaces, and release metadata converge on `0.1.0` without changing their data shapes.
- The first release supports only `darwin-arm64`; Intel macOS, Linux, Homebrew, notarization, and Developer ID signing remain unclaimed.
- Commit, push, tag, hosted Release creation, and verification of a fresh hosted download remain separate authorization and evidence gates in TASK-078.

## ADR-0024: Post-MVP milestone M4 and CLI Handoff detail reads

- **Status:** Accepted (amended 2026-09-10 by ADR-0025)
- **Date:** 2026-09-09
- **Amends:** ADR-0018 (skill processing sequence); ADR-0019 (milestone series after the MVP)

### Context

The M3 MVP release gate and the public `v0.1.0` identity are complete. The primary actor is still an AI session that drives Sorage through `sorage … --json` without a daemon (ADR-0001, ADR-0007). HTTP already exposes the current Review Note and the bounded metadata timeline as `GET /api/v1/handoffs/{handoffId}/review-note` and `GET /api/v1/handoffs/{handoffId}/events`, and the Web detail view renders both (WEB-004). The CLI does not: `sorage get` is metadata only, `sorage review` can set, withdraw, or remove a Note but cannot read one, and no command lists events. A sender session that sees `changes_requested` therefore cannot read the feedback it is asked to answer unless it starts the daemon and calls HTTP.

`scripts/sot-check` and the Task start checklist accept only `M1`, `M2`, and `M3`. New requirements cannot be dated `M1` without claiming they belonged to a closed gate, and dating them `M3` would reopen the MVP gate after `TASK-078`.

Folding the Note body into `sorage get` would change the existing CLI JSON envelope and would make the public Handoff representation carry content that HND-020 does not list.

### Decision

Post-MVP work uses milestone identifiers `M4` and above. `M1`, `M2`, and `M3` remain closed. Source of Truth document version `0.5.0` records this amendment; product SemVer, `/api/v1`, configuration schema `1`, database schema `1`, and Vault schema `1` stay independent.

The CLI grows two read commands that call the same application use cases as the HTTP detail surface and that record nothing:

- `sorage review show <handoff-id>` returns the current Review Note or JSON `null`.
- `sorage events <handoff-id>` returns the bounded recent metadata timeline, newest first, including for a tombstone, and never carries Artifact bytes.

`sorage get` stays metadata only. Neither command is a fetch: they do not set `firstFetchedAt` and they do not increment Row Version.

The shipped `use-sorage` skill keeps GEN-014. When Handoff processing is requested and a Review Note exists, it instructs the acting session to read that Note through `review show` before `revise`. A requested inbox or outbox check still reports only the requested box.

### Alternatives considered

- Enrich `sorage get --json` with `reviewNote` and `events` | rejected: it changes the frozen get envelope, mixes the HND-020 public representation with detail resources the HTTP API already split, and makes a metadata read pay for a 50-event timeline.
- Append the work to `EPIC-009` as further `M3` Tasks | rejected: every member Task of that Epic is terminal, and dating new requirements `M3` would reopen a passed MVP gate.
- Date the new requirements `M1` | rejected: `sot-check` would then require an `M1` citing Task, which cannot be added after `EPIC-006` closed.
- Defer the timeline command and ship only `review show` | rejected: the HTTP and Web detail surfaces already pair the two reads, the use case `readHandoffTimeline` already exists, and a second identical CLI wiring is cheaper than a later contract change.
- Teach agents to call the local HTTP API for the Note | rejected: ADR-0001 requires the CLI loop to work with no daemon, and GEN-014's skill is a CLI policy.
- Open the Note automatically on an outbox check | rejected: GEN-014 limits a check to reporting the requested box.

### Compatibility and migration

The CLI JSON change is additive and non-breaking: new commands gain new goldens, and the `sorage get` snapshot is unchanged. No configuration, database, Vault, HTTP, or protocol DTO migration applies. Installations pick up the commands by upgrading the binary. The skill file in this repository changes in the M4 skill Task; copies installed elsewhere need a separate update before agents follow the new sequence.

### Consequences

- Milestone `M4` is the first post-MVP release gate and closes after `EPIC-010`.
- `core` already implements `readReviewNote` and `readHandoffTimeline`; M4 work is CLI wiring, contract goldens, the skill sequence, and the sender journey.
- Findings that block the M4 gate append to `EPIC-010`, not to `EPIC-009`.
- ADR-0025 opens milestone `M5` after this gate closes and does not reopen `M4`.

## ADR-0025: Post-MVP milestone M5 and Web User body compose

- **Status:** Accepted
- **Date:** 2026-09-10
- **Amends:** ADR-0024 (milestone series after `M4`)

### Context

A human can already send a short request without a file through `sorage send --title <t> --body <text>`, including from an unregistered workspace when `--allow-unregistered` is supplied (HND-023, PRJ-019, UC-02). The Web compose form cannot: `POST /api/v1/handoffs/upload` requires a file part, the SPA refuses an empty file input, and the JSON `--body` path is `POST /api/v1/handoffs/import-path`, which is CLI-token-only because it carries a filesystem path (API-004).

The browser session is User-admin context (architecture §2.3, UC-04). Unregistered identity is `SHA-256(installationId + "\n" + normalizedWorkspacePath)` and exists so a later bind can inherit sender authority. A compose form has no working directory, so offering unregistered identity would invent provenance the operator did not stand in and would need a Web analogue of the downgrade guard.

`scripts/sot-check` and the Task start checklist accept only `M1` through `M4`. New Web-creation requirements cannot be dated `M2` without reopening the closed daemon-and-Web gate, and dating them `M4` would reopen `EPIC-010` after its gate closed.

The charter still excludes a ticket tracker: one Handoff, one current Artifact, one current Review Note.

### Decision

Post-MVP work after `M4` uses milestone identifier `M5` for Web User body compose. `M1` through `M4` remain closed. Source of Truth document version `0.6.0` records this amendment; product SemVer, `/api/v1`, configuration schema `1`, database schema `1`, and Vault schema `1` stay independent.

The Web compose form gains inline Markdown body text, mutually exclusive with file upload by field presence (WEB-019). The shipped form's sender is the User; this records the M2 implementation rather than adding a picker. `POST /api/v1/handoffs/upload` treats a file part and a `body` field as XOR by presence, rejects both, neither, a duplicate `body`, or a `body` that is empty after trimming, streams a present `body` to disk under `artifact.maxBytes` with the same mid-stream abort and spool cleanup as a file, and materializes it through the HND-023 Markdown Artifact rule (API-013). `allowUnregistered` stays false. The form does not offer a Project-sender picker, unregistered-workspace identity, or an `--allow-unregistered` analogue, and a file submit omits the `body` part. The body field is a compose control, not an embedded Artifact editor (WEB-017).

The resulting object remains a Handoff. No ticket entity, board, or comment thread is introduced.

### Alternatives considered

- Call the feature a ticket and add tracker semantics | rejected: the charter excludes a ticket tracker, and G-03 keeps review at one current Note.
- Send as `unregistered_workspace` from the browser, with a path field and an allow-unregistered confirmation | rejected: unregistered identity is cwd provenance; the browser has none, and faking a path would mis-attribute later outbox inheritance.
- Date the work `M4` and append it to `EPIC-010` | rejected: every member Task of that Epic is terminal, and dating new requirements `M4` would reopen a passed gate.
- Date the work `M2` and reinterpret WEB-007 as allowing a missing file | rejected: WEB-007 is an M2 file-upload requirement; stretching it is a silent material change to a closed gate.
- Add a new JSON create route for browser body-only sends | rejected for this Epic: the upload endpoint already creates Handoffs for the User; extending it with a `body` field keeps one create path. A second route remains available later if the multipart parser cannot treat a text field honestly.
- Ship a Project-sender picker on the same form | rejected for this Epic: the shipped compose path is already User-only; WEB-007 requires upload creation, not a sender picker; a picker remains unshipped residual work outside EPIC-011.
- Buffer `body` as an ordinary multipart text field | rejected: the parser already caps unseen-boundary text at 64 KiB in memory, which is a different limit from `artifact.maxBytes` and would violate NFR-005 if raised.

### Compatibility and migration

The HTTP change is additive: an existing file-only multipart upload keeps working when it omits a `body` field. A present `body` field is new. The Web compose sender remains the User; this corrects the M2 form description to match the shipped path rather than changing actor provenance. No CLI, configuration, database, Vault, or protocol DTO migration applies. Installations pick up the form by upgrading the binary that serves the Web assets.

### Consequences

- Milestone `M5` is the next post-MVP release gate and closes after `EPIC-011`.
- Findings that block the M5 gate append to `EPIC-011`, not to `EPIC-010`.
- CLI `send --body` and unregistered-workspace sends are unchanged.
- `TASK-083` is the documentation-adoption Chore; `TASK-084` implements the streamed upload XOR, the compose textarea, and the upload contract fixtures.

## ADR-0026: Project archival and atomic binding replacement in M6

- **Status:** Accepted
- **Date:** 2026-09-25
- **Amends:** ADR-0025 (post-MVP milestone series) and the Project command actor rule of CLI-019

### Context

Project retirement currently requires the explicit User flag even though Sorage is a single-user local tool and the Project slug already identifies the administrative target. Archiving blocks new recipients but lets an archived Project create new outgoing Handoffs. Moving a registered directory requires separate bind and unbind commands, which exposes an intermediate identity and leaves derived inbox markers at the old location. M5 closed after EPIC-011, so these changes belong to a new gate.

### Decision

M6 adds an atomic `project rebind <project> --from <recorded-path> --to <existing-path>` command and closes after EPIC-012. Source of Truth version 0.7.0 records the amendment; product SemVer, /api/v1, configuration schema, database schema, and Vault schema remain independent. Rebind updates one Project Binding in a single SQLite transaction, preserves the binding and Project UUIDs, validates the target under the existing binding rules, and appends `PROJECT_BINDING_REBOUND` with the old and new directory and kind. It does not move files or rewrite historical snapshots or append-only events. An unchanged normalized target is a no-op. The optional derived inbox marker is written at the new binding and a recognized old marker is removed after commit only while no current binding owns its path. The marker refresh and cleanup share `inbox-marker.lock` across processes so a concurrent Handoff update cannot recreate a retired marker after cleanup; marker failures warn without rolling back the authoritative binding.

`project archive` and `project unarchive` imply User context in the CLI and their HTTP routes, so no explicit `--as-user` or `asUser` is needed for these two operations; old explicit invocations remain accepted. They record `actorKind = user`. An archived registered Project cannot be a sender or recipient of a new Handoff, including under a concurrent archive. Existing Handoff processing and exact idempotency replay remain available.

### Alternatives considered

- Physically delete Projects and related Handoffs | rejected: Master selected archival, and PRJ-011 preserves historical identities.
- Require `--as-user` for Project archive and unarchive | rejected: it adds no authentication in a single-user installation and obscures a simple Project lifecycle command.
- Rebind as sequential `bind` then `unbind` | rejected: a failed second step leaves two identities and forces callers to coordinate marker updates.
- Move the Project directory within `rebind` | rejected: Master chose registry-only path replacement; file and Git operations belong to the caller.
- Rewrite old path snapshots and events | rejected: it would falsify historical provenance and conflict with the append-only ledger.

### Compatibility and migration

The new CLI command, Project event type, and implicit User context are additive to the wire surfaces; existing `--as-user` and `asUser` requests continue to work. The exact `PROJECT_ARCHIVED.recovery.suggestedCommand` JSON value changes and is breaking for clients that compare that text; HTTP DTO shapes remain non-breaking. Rejecting new outgoing Handoffs from an archived Project is an intentional behavior change. Retained send idempotency records written before sender-aware hashing remain replayable when the stored Handoff sender matches the current sender or the same Workspace was subsequently registered as a Project. The Project Binding row is updated in place, so no database, configuration, Vault, or protocol migration is required. Current backup snapshots reflect the new binding at their next generation; old Git commits are not rewritten.

### Consequences

- EPIC-012 contains a Source of Truth adoption Task and one Contract implementation Task, then closes the M6 gate after AJ-19.
- The Project archive and unarchive HTTP routes use User provenance regardless of request-body actor fields; other routes retain their existing actor contracts.
- `project rebind` is a CLI command over a shared application use case; it does not introduce an HTTP path-change route or a Web control.

## ADR-0027: Project Memos as a separate domain in M7

- **Status:** Accepted
- **Date:** 2026-09-26
- **Amends:** The post-MVP milestone series and the Handoff-only domain scope. Earlier Handoff lifecycle decisions and accepted historical records remain unchanged.

### Problem

The User needs to leave a project-scoped reminder before a restart or absence, find only those reminders later, and close a handled or obsolete item. A User-to-Project Handoff can carry the same text but implies directional delivery, recipient review, exact Revision acceptance, and a next actor. A Codex hook journal would instead duplicate runtime history planned in Dolgorae/Gul and would still not establish that an Epic validator actually completed.

### Decision

Adopt Project Memo as a separate domain under M7, with Source of Truth version 0.8.0. [MEM-001 to MEM-024](../specs/required-specification.md#18-project-memos) and [Project Memo contract](../specs/project-memos.md) define its behavior. A Memo belongs to a stable Project UUID; all native Memo mutations record existing User provenance, including explicitly authorized AI actions on the User's behalf. There is no sender/recipient relationship or new account system.

Use open, done, and dismissed with explicit reopen. Done records caller-declared handling, not external execution verification. Require observed row versions on existing-object mutations, preserve no-op semantics, and support exact operation-scoped idempotency. Closed content requires reopening before editing. Archived Projects allow reading and cleanup but forbid new or reopened reminders. Reads and note creation never authorize executing note text.

Implement CLI, local HTTP, Web, and the existing Sorage skill over one application layer. Store current content in a dedicated SQLite table with metadata-only events. Add backup format 2, including Memo inventory and digests, and retain format-1 reading as zero-Memo legacy input. No Memo mutation adapter ships before backup/restore support is complete. The [architecture](../architecture/README.md#25-project-memo-extension) records component boundaries; the [roadmap](../roadmap/README.md#epic-013-project-memos) allocates sequential implementation and qualification.

The shared normalized application request and DB receipt are the sole Memo replay authority. The existing HTTP idempotent wrapper hashes raw bodies and returns cached envelopes; Memo routes use the ordinary authenticated handler with its legacy idempotent flag unset or false, forwarding the key after strict bounded input validation. Execute and replay-only are separate application modes over the same request identity. CLI --replay-only and HTTP Idempotency-Mode: replay-only recover uncertain outcomes without executing on an absent/expired receipt, returning MEMO_REPLAY_UNAVAILABLE instead. Valid exact receipts return historical outcome data with replayed=true in a fresh envelope. The server Clock decides expiry; client time, unchanged Installation identity, and reauthentication do not prove receipt continuity after restore. Do not change Handoff routes, export all receipts, or add another cache/service.

Extend the browser assets actually served from apps/daemon/src/web-app.ts and reuse its safe renderer; apps/web remains a stub and no frontend migration is included. One active pending record is stored before first dispatch and gates Memo writes across same-tab navigation/reload. Unknown attempts recover through replay-only. Evidence may settle the attempt, or an explicit Abandon retry and continue confirmation may retire it while preserving a bounded passive outcome-unknown notice. Persist that local transition before unlocking; no cancellation, deletion, replacement submission, or outcome claim is implied. Expiry never silently clears the record, storage failure cannot unlock, and a late original response cannot affect a newer active attempt. Passive notices are not a submission queue or server ledger and have explicit local retention controls. Reads and other clients remain available.

Put the Memo contract explicitly in the authority order after shared security and before testing/traceability. Shared documents retain common protections and explicitly distinguish unchanged format-1/Handoff rules from Memo extensions. Format 2 fixes the closed Memo field set, canonical UTF-8 file bytes including the final LF, raw-file SHA-256 as lowercase hexadecimal, and memoDigests keys relative to snapshots/. Verify exact inventory and canonical UUID-derived paths before import, not merely parsed values; the Memo contract owns the detailed byte and path rules.

### Alternatives considered

- Continue using User-to-Project Handoffs exclusively | rejected for reminders: exact document acceptance, review, and next-actor semantics are unnecessary and obscure a simple done outcome. Existing Handoffs remain supported and are not converted.
- Add a Memo subtype or done state to Handoff | rejected: it combines incompatible lifecycle, actor, retention, and Revision rules and risks old clients.
- Add a Codex Stop-hook journal or infer state from Dolgorae/Podway | rejected: this feature records explicit User intent, not automatic progress; no ecosystem dependency or execution-status authority is needed.
- Use untracked project-local Markdown files as the authoritative store | rejected: it duplicates Project selection and loses transactional conflicts, central retrieval, and native backup coverage.
- Give each Memo an Artifact | rejected for M7: bounded text in SQLite needs no file import/materialization lifecycle. Attachments remain outside scope.
- Keep only open/done | rejected: dismissing an obsolete reminder must not imply the work was performed. In-progress, blocked, assignment, and scheduling states remain excluded.
- Add named authors or cross-project access control | rejected for M7: User provenance is sufficient under the existing single-OS-user trust model and does not invent a human/AI authentication boundary.
- Add hard deletion, body revision history, or multi-machine sync now | rejected: these require distinct retention or distribution decisions and are not needed for the restart/reminder scenario.
- Stack the legacy HTTP cache above Memo receipts | rejected: raw JSON equality differs from normalized request equality, cached responses can retain replayed=false, and two authorities disagree across daemon restart or CLI/HTTP replay.
- Move the shipped frontend into apps/web during Memo work | rejected: the current production asset owner is web-app.ts in apps/daemon; a package migration adds unrelated delivery risk.
- Leave digest encoding, hash bytes, or relative-path roots to implementations | rejected: independent exporter/verifier implementations need one byte-level contract and deterministic fixtures.
- Replace the tab's unresolved attempt on another submit, or add a pending queue | rejected: replacement loses the original key and a queue adds coordination. Explicit abandonment preserves an unknown-outcome notice before unlocking; notices are passive, not retryable submissions.
- Trust the original 24-hour timer and Installation ID across restore | rejected: restore keeps the ID and Memo data but not operational receipts; a recovery write could create a duplicate. Replay-only never executes on a miss, including the server-side expiry boundary.
- Export all receipts or change Installation identity to repair retry semantics | rejected for M7: these broaden backup/identity contracts without eliminating every missing-record case. Explicit non-executing recovery handles absence without reconstructing an outcome.
- Keep a tab write-locked forever after receipt loss | rejected: outcome uncertainty must remain visible but need not prevent unrelated new work after informed abandonment. A local notice preserves that distinction without modifying Memo lifecycle.

### Compatibility impact

New Memo CLI commands, API routes, types, event kinds, and Web views are additive. Before publication, the Memo contract also fixes replay-only CLI/header inputs and MEMO_REPLAY_UNAVAILABLE, and separates local recovery abandonment from server state. Existing Handoff state values, commands, outputs, markers, processing, and legacy HTTP replay stay unchanged. Memo-only cache bypass does not weaken authentication or request limits, and the Web extension keeps the current asset delivery path. Memo-specific required expectations and created-time pagination do not redefine Handoff behavior. M7 remains within local /api/v1; the intentionally new backup representation uses snapshot format 2. Product SemVer, configuration schema, database migration version, Vault marker version, and Source of Truth version are independent. No product release number is allocated by this decision.

### Migration impact

Append the next unused database migration after the inspected version 6; preserve existing identities, Handoff rows, and receipts. Extend backup/verify/restore before exposing Memo writes. Format-1 restore produces no Memos and nullable Memo event associations; format-2 restore validates exact Memo inventory, digests, references, and state before importing. Unknown newer snapshots fail closed. Existing Handoffs are never automatically converted or inferred as historical Memos. Operational receipts are preserved during an in-place upgrade but are outside both snapshot generations. Restore adopts the same Installation identity without rebuilding those receipts. Pending requests after restore must use replay-only and remain unknown on absence rather than executing again, whether the snapshot contains the original Memo or predates it.

Do not claim safe in-place downgrade: the existing migration runner does not establish that an old executable refuses the new database. Stop old processes and scheduled writers before upgrading, verify a pre-upgrade backup, and document rollback through a separate empty home/Vault. Post-upgrade Memos are absent from that older backup and must be separately preserved before rollback. User-requested backup contains free text; path redaction cannot remove secrets embedded in a Memo body, and Git history can retain earlier content.

### Required Source of Truth edits and roadmap impact

Add the normative Memo contract, MEM requirement group, M7 gate, AJ-20 through AJ-23, architecture/operations/security links, traceability, and the execution dossier. Keep its explicit authority position aligned in docs/README.md, governance, and AGENTS.md. Scope legacy snapshot lists and manifest-only-count statements to format 1, and bind the four integration seams and their regression checks to the existing TASK-087/TASK-088/TASK-089/TASK-091/TASK-092 owners rather than inventing new work IDs. Extend the SOT checker's explicit M7 vocabulary and behavioral fixtures as documentation-enabling infrastructure, not Memo product implementation. EPIC-013 retains its EPIC-012 dependency and contains TASK-087 through TASK-094. Preserve EPIC-012's recorded M6 acceptance and align only the roadmap's next-eligible pointer with that satisfied prerequisite; no implementation Task is started by this correction. AJ-21-B belongs to TASK-092, AJ-21-S to TASK-093, and full-journey verification to TASK-094, with no backward completion dependency. No prior accepted ADR, release result, user data, or completed work is rewritten. Every implementation Task remains controlled by the canonical roadmap.

### Consequences

Memo is an intentional scope extension of Sorage, but not a project manager. All current work remains in the Sorage repository and uses the existing process, database, and trust model. Release acceptance includes real CLI/API/browser restart, concurrency, migration, and restore evidence. The temporary dossier must be removed only after accepted Epic closeout promotes remaining durable guidance and repairs its inbound links.

### CLI error-contract clarification, 2026-09-28

Problem: TASK-090 review found that the Memo file-open requirement names filesystem exit 73, but the existing closed catalogue only supplies Vault-integrity and Artifact-corruption codes for that category. Neither describes a User-selected text file that cannot be read. The same review found inherited parser and recovery output that bypasses Memo validation or recommends Handoff-only actions.

Decision: add `MEMO_FILE_READ_FAILED` for actual Memo body-file resolution/open/read failures, with CLI exit 73 and catalogue HTTP status 500 (no HTTP file-import route). Invalid UTF-8, unsafe file types, and source conflicts remain `MEMO_INVALID_INPUT`; size overflow remains `MEMO_TOO_LARGE`. Validate supplied Memo numeric values as Memo input while retaining exit 2 for missing option arguments and other parser syntax errors. Memo-context recovery names the Memo or explicit `--project` selector; unchanged Handoff callers retain their exact prior guidance.

Alternatives considered: reusing `VAULT_INTEGRITY_ERROR` or `ARTIFACT_CORRUPTED` was rejected because a selected Memo source is neither managed Vault state nor an Artifact; using `INTERNAL_ERROR`/1 or `MEMO_INVALID_INPUT`/64 for operating-system read failures was rejected because it loses the required filesystem category; changing every command's parser or recovery was rejected because the Memo extension must preserve Handoff contracts.

Compatibility is additive and non-breaking: one new error code and Memo-only parsing/recovery behavior, with no envelope field or existing Handoff output change. No data migration is needed. The required edits are the Memo and shared error catalogues, contextual recovery implementation, and CLI contract snapshots. TASK-090 owns this clarification and its review/regression checks; no Task identity, dependency, milestone, or remaining review budget changes.

## ADR-0028: Non-mutating installation preflight in M8

- **Status:** Accepted
- **Date:** 2026-10-14
- **Amends:** ADR-0001 and ADR-0013 operational startup/intent-drain obligations, the pre-initialization command allowlist, and operational logging rules for the new M8 inspection paths only. Historical M1 through M7 acceptance is preserved.

### Problem

Aquarium needs to assess storage before a new executable opens it with a writer. Version identifies the executable, doctor uses a connection that configures WAL, and Project reads enter migration wiring. Consumer-side SQL inspection of the Memo migration and Installation identifiers duplicates private storage and upgrade rules.

### Decision

Adopt shared M8 and Source of Truth version 0.9.0. Provide the CLI-only preflight contract in [section 36](../specs/interfaces-and-operations.md#36-installation-preflight-milestone-m8), with PFL-001 through PFL-008, coherent temporary DB/WAL inspection, six states, stable checks and explicit recovery guidance. The operational database is never opened by the inspector; journals, locks, configuration, Vault and failure logs remain untouched. A moving or unreadable source cannot yield a compatible verdict. Compatibility is point-in-time and does not certify backup preparation, full Artifact integrity or future writer readiness.

Keep actual upgrade approval, old-binary backup verification and a separate restore drill outside this command. Aquarium may replace private inspection only after verifying a released interface; Sorage does not edit that repository or activate the consumer.

### Alternatives considered

- Reuse doctor | rejected: its operational connection and broader health probes do not provide the required no-write boundary.
- Keep consumer SQL and migration-name checks | rejected: they make private implementation details a cross-repository upgrade contract.
- Inspect live SQLite in ordinary read-only mode | rejected as the default design: journal/shared-memory behavior and startup wiring require a separately proved boundary, so the chosen inspector reads a validated temporary snapshot.
- Ignore WAL or assume immutable live storage | rejected: committed data may be present only in WAL, and a writer can invalidate that assumption.
- Automatically prepare or migrate after a positive result | rejected: inspection does not grant upgrade or recovery authority.

### Compatibility impact

The optional preflight command and report are additive and leave doctor and existing envelopes unchanged. M8 inspection explicitly amends INIT-011, RUN-002, RUN-009 and NFR-009; the matching architecture and security exceptions must not weaken other commands. Product version and storage schema versions remain independent of SOT 0.9.0.

### Migration impact

No database, configuration, Vault, backup or receipt migration is needed for this feature. Known older storage is assessed without migration; newer schemas are unsupported. Pre-Memo backup and restore-drill obligations remain in force. Normal writers keep their existing migration path.

### Required Source of Truth edits and roadmap impact

Register EPIC-014 and TASK-096 through TASK-100, the shared M8 gate, PFL requirements and AJ-24; align specification, interface catalog, architecture, security, operations, traceability, governance and public planned-release guidance. TASK-096 owns M8 checker support and fixtures. This approved registration changes documents only, so the existing M1-M7 checker is expected to reject M8 until that separate Task is implemented; registration is not a passed SOT or product gate.

### Consequences

Inspection logic and storage-version knowledge stay inside Sorage. Every inspection outcome, including a failure, requires source no-write evidence. Intended publication is v0.1.3 with EPIC-015, separately authorized after both Epics and the shared gate are accepted.

## ADR-0029: Non-executing send recovery and agent policy in M8

- **Status:** Accepted
- **Date:** 2026-10-14
- **Amends:** ADR-0001 and ADR-0013 startup/intent-drain obligations for replay-only inspection, and ADR-0018 shipped agent policy while retaining HND-026 requested-setup guidance. ADR-0027's Handoff non-goal remains the M7 decision; this extension adds no Handoff HTTP/Web mode.

### Problem

An uncertain send cannot safely be retried as ordinary execution: a missing, expired or restore-lost receipt can create another Handoff even with the original key. The shipped skill also describes recovery hints as next commands without explaining their authority limit, and omits several deletion, observed-version, send-recovery and installed-resource decisions identified by Aquarium's skill review.

### Decision

Add CLI send --replay-only with its original key, inputs, source and sender context, using the dedicated non-executing receipt contract in [section 37](../specs/interfaces-and-operations.md#37-send-replay-only-and-agent-policy-milestone-m8). Reuse the EPIC-014 coherent snapshot boundary. Preserve existing send hashes, sender ownership and legacy/registration compatibility. A matching eligible receipt returns the historical SendOutcome with replayed=true; absent or expired receipts return HANDOFF_REPLAY_UNAVAILABLE/75 without sending, staging, draining, migrating, logging or cleaning receipts. Recovery mode is separate from request identity.

The interface defines supported historical receipt layouts, explicit storage-refusal mappings and actual native move/restore fences. Derived inbox-marker refresh and its locks are excluded even on successful replay. The committed migration snapshot is assessed without assuming a native migration-file lock exists or certifying writer absence. Installation and configured Vault directory aliases may be stable canonical roots; linked managed state files are refused. Residue-only pre-initialization logs do not become installation authority.

GEN-016 through GEN-020 require the skill to preserve user intent, distinct native pinned-deletion decisions, observed Note/revise versions, original-key non-executing recovery, Project identity and untrusted document boundaries. Required instructions must remain accessible from a clean installed skill directory. Actual skill edits and behavioral acceptance belong to TASK-103 and TASK-104, not this registration.

### Alternatives considered

- Repeat ordinary send with the same key | rejected for unknown outcomes: receipt expiry or restore can cause a new execution.
- Limit the work to stopping on every uncertain send | rejected for this approved scope: the user selected a supported non-executing recovery interface in addition to policy changes.
- Trust a client timer or unchanged Installation identity | rejected: neither proves the retained receipt survived restore, and a late original can still complete.
- Extend every Handoff mutation and HTTP/Web recovery now | rejected: CLI send is the required seam; the other transports and operations have distinct contracts.
- Export receipts in backups or reconstruct success from a title/content match | rejected: it broadens storage semantics or invents evidence of the original result.
- Test only skill prose | rejected: packaging structure cannot establish actual authority, conflict or uncertainty decisions by an agent.

### Compatibility impact

Add an optional CLI send mode and four CLI-only errors: HANDOFF_REPLAY_UNAVAILABLE (409/75), STORAGE_SCHEMA_UNSUPPORTED (422/78), STORAGE_INTEGRITY_ERROR (409/73), and STORAGE_INSPECTION_UNAVAILABLE (503/75), as detailed in interface section 37.1. Existing send defaults, successful data fields, legacy key/hash behavior, actor ownership and receipt formats remain unchanged. TASK-101 promotes their HTTP-equivalent mappings into the implemented error matrix; no endpoint or header is added. M8 contextual recovery text preserves uncertainty and does not change ordinary execute error defaults. M7 Memo execute/replay-only behavior and its Web recovery gate remain untouched. Existing send retries without the flag retain their documented execute semantics and are not endorsed for uncertain recovery.

### Migration impact

No persistent migration or receipt rewrite is planned. Read retained historical receipt formats and legacy sender hashes without changing expiry; backup restore continues excluding receipts. A same-Installation restore can therefore leave the original send outcome unknown. Incomplete original input or unavailable inspection is a reported limitation, not permission to send again.

### Required Source of Truth edits and roadmap impact

Register EPIC-015 and TASK-101 through TASK-104 after EPIC-014. Adopt SND-001 through SND-006, GEN-016 through GEN-020, AJ-25 and AJ-26; update interfaces, architecture, security, operations, implementation guidance and traceability, with planned v0.1.3 public notes. Both Epics share M8. Preserve past skill walkthrough records as evidence for their original candidates; require an independent observer for the new frozen skill rather than counting those records again.

### Consequences

Unknown outcome remains distinct from failure and from authorization for a new operation. A later new send requires separately expressed intent. The feature does not change Handoff state, deletion semantics, Project setup authority, Memo recovery, or consumer activation. Installation, sending a response to Aquarium and publication remain separately authorized.

## ADR-0030: Agent communication channels and shared content storage in M9

- **Status:** Accepted (2026-10-18; proposed 2026-10-17)
- **Date:** 2026-10-17
- **Design owner:** TASK-105 under [EPIC-016](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage).

### Problem

Master observed a separate test pilot submit Worker/Judge messages through an Orchestrator's prompt input, allowing agent reports to be interpreted as user instructions. The proposed Aquarium integration is not yet a published release, and this observation does not establish a reproduced defect in current Aquarium or Sorage. An attributed upstream channel would let main receive reports, questions and peer-relay requests as data while retaining assignment and decision ownership.

Long agent reports also motivate a common body storage interface. Current Handoff bodies are Vault-backed Artifacts, while Memo bodies are inline SQLite text capped at 65,536 UTF-8 bytes. The requested direction gives Handoffs, Memos and Channel messages the same small-text/large-content routing policy without storing both an inline body and authoritative Vault content for one body.

### Decision

Accepted by TASK-105 with the revisions recorded in this section; the initially proposed text is preserved in the repository history. Add one Sorage communication channel per orchestration invocation, with one main and multiple registered Worker/Judge participants. Lower participants submit upstream messages through Sorage. Main reads them through a tool-result interface and decides whether to issue instructions, request clarification or relay a request. Received text and Judge verdicts grant no new execution or user authority. Main-to-agent dispatch remains consumer-owned. Keep SEC-013's same-OS-user trust limit; channel attribution is not process isolation.

Retain the channel through the invocation's Podway sessions and resumption. Store supplied public session/node/attempt and assignment context with the originating message, without introducing a Podway dependency or automatic inspection. Durable read and handling outcomes remain distinct, and neither can certify an external instruction was executed exactly once. First delivery supplies CLI operations and main-side polling/waiting; wake-up adapters and new Channel HTTP/Web screens are later work.

Introduce a common content interface backed by the existing SQLite database and managed Vault. The initial policy places text of at most 65,536 UTF-8 bytes inline, larger accepted text in the Vault, and binary content in the Vault; the total accepted-body bound for every domain is the existing `artifact.maxBytes` setting. Metadata remains in SQLite. Exactly one of inline content or a valid Vault-relative storage key is present; empty inline text counts as present where permitted. Preserve exact accepted bytes, byte size and checksum. Reuse transactional coordination and generalize existing file durability/intent recovery rather than creating an independent queue or journal service.

Three decisions were settled at acceptance beyond the proposal. First, the normalized immutable content-record registry is the adopted physical design: authoritative bodies live in immutable content records referenced by domain rows and by retained responses, because one registry gives the intent drain, garbage collection, Vault verification, backup inventory, and receipt retention a single reference-aware mechanism, while a per-domain column design would have repeated that generalization in every adopting Task and forced later-Task dependencies. Second, one coherent global snapshot format 3 replaces the per-domain manifest evolution: a single manifest covering Handoffs, Memos, Channels, and carried content avoids competing version counters that a single restore would have to reconcile. Third, the NFR-009 migration-lock wording is resolved to the transactional serialization the shipped runner actually provides, for the reasons in `Migration impact`, not because the implementation predates the rule.

Two further revisions were adopted in the TASK-105 correction pass. The inline Handoff `storageKey` revision is deliberately breaking: the field stays present in the affected DTOs and carries JSON `null` for inline text Artifacts, string-only consumers must migrate with the Handoff adoption Task, and the existing response envelope, protocol version 1, and `/api/v1` routing are kept because NFR-003 requires versioned, contract-tested public contracts without specifying a mandatory envelope or API bump per data-field change. And domain rebuild migrations follow the official SQLite generalized `ALTER TABLE` procedure on a dedicated connection rather than any defer-only drop recipe, for the mechanism recorded in `Migration impact`.

[The canonical roadmap](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage) records the Task boundaries and links their lasting outcomes, and [interface section 38](../specs/interfaces-and-operations.md#38-shared-content-and-agent-communication-channels-milestone-m9) owns the settled contracts.

### Alternatives considered

- Continue submitting lower-agent reports into main's prompt input | rejected for the proposed integration: it loses the intended distinction between a user instruction and attributed agent data.
- Reuse Project Memo as the channel | rejected: Memos have no sender/recipient delivery model and use User provenance; introducing agent routing there would change the reminder domain's meaning.
- Reuse cross-project Handoffs for every intra-project message | rejected: their per-recipient Artifact/review/acceptance lifecycle does not express channel participation, questions or processing decisions.
- Store every body only in SQLite | not selected for this scope: Master requested managed Vault storage for long bodies and a common storage policy across all three domains.
- Store every body in a separate file | not selected: small text should retain direct transactional SQLite storage under the approved direction.
- Keep complete authoritative bodies in both SQLite and the Vault | rejected: dual authority complicates integrity and violates the required exactly-one representation.
- Make Sorage inspect Podway or dispatch through Herdr | rejected: consumers own workflow state and agent execution; Sorage must remain standalone and expose public broker interfaces.
- Per-domain XOR columns instead of a normalized immutable content-record registry | rejected at acceptance: it minimizes row movement but forces the intent drain, garbage collection, Vault verification, backup inventory, and receipt retention to be generalized separately inside each adopting Task, which concentrates operational seams in later Tasks and contradicts the no-later-Task-dependency rule; the registry pays one heavier infrastructure Task instead.
- Independent per-domain snapshot manifest versions instead of one coherent global format 3 | rejected at acceptance: separate Handoff, Memo, and Channel version counters would make a single restore reconcile competing format matrices, and the M7 precedent of one manifest extension per milestone already showed the cost; one format keeps the supported legacy inventory enumerable.
- Retain the NFR-009 `run/migration.lock` whole-run file lock as the normative migration serialization | rejected at acceptance for the reasons in `Migration impact`: its documented whole-run exclusion was never what the shipped runner provided, it would not close the mixed-version hazard it appears to address, and the database write transaction already provides engine-level serialization with a precise wait-and-recheck rule.
- A defer-only drop-and-rename rebuild recipe | rejected at acceptance: rebuilding only some tables of a foreign-key component with deferred checks still fails at commit when dependents reference a dropped table, and SQLite documents `DROP TABLE` under foreign-key enforcement as an implicit `DELETE FROM` whose effects must be planned; the official generalized `ALTER TABLE` procedure on a dedicated connection is adopted instead.

- Add a nullable Channel association column and a new top-level snapshot field | not selected: typed metadata follows the existing Project-event pattern, avoids a Channel dependency in TASK-106, and supplies explicit application/snapshot association validation without another row shape.
- Omit Channel mutation events or grow legacy event allowlists automatically | rejected: omission conflicts with SEC-012/BKP-023; automatic growth violates the closed legacy format contract.

### Compatibility impact

Channel CLI behavior is additive, but existing Handoff storage/fetch and Memo size/search/replay contracts require explicit review. Preserve Handoff Artifact identity, Revision and acceptance semantics, Memo lifecycle and User provenance, and all existing sender, authentication and uncertainty boundaries. Existing Handoff/Memo HTTP/Web consumers must continue to work against the accepted migrated contract. Unchanged public behavior must not be labeled breaking solely because physical storage changes; actual wire or operational changes require explicit classification, which [interface section 38.8](../specs/interfaces-and-operations.md#388-public-contract-classification-and-format-3-serialization) now records per change rather than as a blanket claim. The inline `storageKey` revision is the one deliberately breaking data-DTO change: it is adopted under the recorded envelope decision that keeps protocol version 1 and `/api/v1`, with the mandatory consumer, parser, and golden migration owned by the Handoff adoption Task, and without claiming compatibility for string-only DTO consumers or waiving NFR-003.

The common store must not silently duplicate a Vault body into SQLite receipt payloads or discard historical response content. Inline fetch materialization must preserve the readable-file contract without creating a second authoritative body, which the checksum-addressed derived cache under `state/fetch-cache/` settles.

### Migration impact

Expect a reviewed database/shared-content and snapshot migration. Preserve existing file-backed Handoffs and inline Memos without automatic threshold-driven repacking of historical bodies. Define supported prior schemas/snapshot generations, pending-intent and receipt handling, content ownership, restore checks, retained-response references and rollback refusal. Missing or corrupt content must remain a reported integrity condition. Channel retention and backup inclusion follow the accepted contract: runtime Channel records are included in the existing Vault Git backup and restore policy through snapshot format 3, completion is not permission to erase history, and operational receipts stay excluded from restore.

The migration-lock resolution is a deliberate concurrency and safety decision, not wording cleanup. The adopted invariant is that the migration transaction itself is the serialization point: `BEGIN IMMEDIATE` takes the database write lock, holds the single-row `migration_lock` table for the migration transaction, a concurrent migrator waits on the busy timeout and then re-checks `schema_migrations` before applying anything, and a failed step rolls back to the previous schema. The file-lock alternative promised whole-run exclusion that the shipped runner never provided, and even a faithful file lock would not close the hazard it appears to address: a process started after the migrating process exits, including an older executable, would operate on the upgraded database regardless, so mixed-version safety is an operational procedure (stop old writers, daemon, and scheduled backup; keep a verified pre-upgrade backup; roll back only with the matching executable into a fresh home) rather than a lock claim. The database transaction is also the stronger guarantee for the race it does solve, because SQLite serializes the DDL at the engine level while file-lock staleness rules are heuristics. Inspection surfaces keep honoring a live legacy `run/migration.lock` file as an owner signal without claiming the runner acquires it, exactly as interface section 36.2 already states, and TASK-106 aligns the runner, doctor, and preflight wording against production fixtures.

Rebuild migrations follow the official SQLite generalized `ALTER TABLE` procedure (<https://www.sqlite.org/lang_altertable.html#otheralter>), whose documentation of `DROP TABLE` performing an implicit `DELETE FROM` under foreign-key enforcement (<https://www.sqlite.org/foreignkeys.html#fk_schemacommands>) is the reason a defer-only drop recipe was rejected: a partial component rebuild fails at commit when dependents reference a dropped table. A rebuild migration owns a dedicated, non-operational connection with foreign-key enforcement normally on; it verifies the setting, disables enforcement with `PRAGMA foreign_keys=OFF` outside any transaction and verifies that on that connection only, performs the create-copy-drop-rename work inside one `BEGIN IMMEDIATE` transaction with replacement tables referencing final canonical names, recreates every index and trigger, verifies counts and associations, and requires an empty `PRAGMA foreign_key_check` before commit. Enforcement is restored and verified outside the transaction on every exit before an operational connection is handed out; a restoration failure after commit is reported as committed work plus an unusable connection, never as a rollback; no global process setting is toggled, no operational connection runs disabled, and `writable_schema` is never used. `pending_fs_ops` declares no foreign key and is preserved as a logical dependent with its legacy `artifact_id` semantics; `idempotency_keys` sits outside every rebuild component, so retained send responses keep their exact original string metadata and request identity through upgrade. Non-SQL coordination stays out of the migration transaction and belongs to its owning surface: the Vault marker keeps its existing `schemaVersion`, the `.gitattributes` `content/**` line is re-asserted idempotently by the existing assertion surfaces, and outstanding filesystem intents from before an upgrade are drained at the next process start under the migrated schema. Concurrent operational startup follows the existing model: every process migrates under the same serialization, and post-migration writers serialize per transaction through WAL while readers see the pre-migration snapshot until commit.

The supported inventory after M9 is per build, and no universal claim is made about old executables: each executable reads exactly its own known-schema inventory, so the published v0.1.2 generation reads through migration 7, pre-Memo builds read only their own earlier ranges, and each M9 build reads versions 1 through 7 plus every M9 migration delivered at its Task, with version 8 additive from TASK-106. Snapshot formats 1 and 2 remain restorable legacy inputs beside the format-3 writer that TASK-106 introduces, each later Task adds exactly the format-3 representations its schema can faithfully import, and Vault marker versions are unchanged throughout. A database newer than the build fails closed with `STORAGE_SCHEMA_UNSUPPORTED` before operational work, offline `version` and `help` never open the database, and no automatic downgrade or threshold-based repacking exists.

The event contract keeps existing event-row and snapshot fields. Channel associations use closed typed metadata with existing ActorRef provenance; common file operations retain historical ownership in intents so obsolete content events remain restorable without body retention. TASK-106 owns the common family and format-3 validator, TASK-109 owns the Channel domain family and retained-association checks, and formats 1 and 2 retain their pre-M9 family lists. SEC-012/BKP-023 apply throughout, with the single normative catalog in [security section 10.1](../specs/security-reliability.md#101-m9-event-metadata).

### Required Source of Truth edits and roadmap impact

Executed by TASK-105 at acceptance: register EPIC-016 and TASK-105 through TASK-110 in M9 after EPIC-015 with the execution dossier linked from the roadmap and documentation indexes; adopt SHR-001 to SHR-014 and CHN-001 to CHN-011 in required-specification section 21; amend VLT-007, VLT-020, VLT-024, HND-023, MEM-004, MEM-011, MEM-018, CLI-020, and NFR-009 in place; settle interface section 38 with its error-catalog, exit-code, doctor, backup, restore, and serialization contracts; extend the `artifact.maxBytes` schema and example descriptions to all three domains; populate every EPIC-016 Requirements cell and traceability row including AJ-27 to AJ-29 and the M9 gate; and update the documentation index, governance adoption boundary, and this record. The roadmap alone records lifecycle; no product release is allocated and the intended v0.1.3 release keeps its M8-only scope.

Before this acceptance, the proposal required reconciling the required specification, accepted ADRs, architecture, interfaces/operations, Memo contract, security/reliability, testing/acceptance and traceability under their existing authority order, explicitly amending Vault-only Artifact and inline-only Memo obligations rather than allowing a lower-authority proposal to override them; TASK-105 performed that reconciliation in the same candidate.

### Consequences

Sorage gains a third broker domain and a shared body storage boundary, with additional file-reference, migration and recovery obligations. Existing SQLite transactions and Vault durability remain the implementation foundation. Reports retain source attribution but remain untrusted data; orchestration judgment and external effect reconciliation remain consumer-owned. Product implementation, independent review, consumer activation, installation, commits and publication retain their respective authorization and acceptance boundaries.

### Amendment (2026-10-20): Closed-Channel metadata eligibility and terminal no-ops

The accepted interface Section 38 text froze submissions on a closed Channel, kept reads and processing available, and fixed the handling-duplicate errors, but left the eligibility of participant registration and deactivation, assignment creation and closure, and repeated terminal operations on a closed Channel under-determined; a consumer review flagged the gap before implementation. This amendment, adopted with the TASK-109 clarification pass, settles the behavior per operation: participant registration is an open-Channel operation refused with `CHN_CLOSED` after close; deactivation of a non-main participant and assignment creation and closure remain available as main-role or User metadata operations on a closed Channel; no M9 operation deactivates the main participant in any Channel state; and a repeat of `channel close`, `participant deactivate`, or `assignment close` that passes the same existence, same-Channel, and asserted main-role-or-User role checks as its first invocation is, against already-terminal state, an unchanged no-op that preserves the first timestamps and provenance, changes no record, appends no event, and returns the current view, while the handling-duplicate refusals of interface Section 38.3 keep their explicit separate codes and are never no-ops.

Alternatives considered and rejected: a blanket ban on every closed-Channel metadata operation, broader than the per-operation definitions the sources carry and needlessly removing harmless completion and hygiene operations; treating repeated terminal operations as failures, which needlessly fails a harmless, authorized, idempotent re-request against already-terminal state; deriving response success from the no-event rule alone, which governs ledger emission rather than the response contract and by itself mandates no repeat success; and reading this behavior back into the original TASK-105 acceptance, which would erase a real under-specification instead of closing it explicitly.

Compatibility impact: no existing consumer DTO, error family, database schema, or migration changes; the newly specified response behavior, meaning closed-Channel metadata eligibility and authenticated terminal no-ops, is an explicit addition rather than a blanket none, and the `CHN_CLOSED` catalog meaning gains the closed-registration refusal that CHN-002's open-Channel registration rule already implies. Migration impact: none, because this is a documentation-only clarification with no schema, snapshot, or receipt change.

Required Source of Truth edits: the closed-Channel and no-op clauses of interface Sections 38.3 and 38.4, the `CHN_CLOSED` row alignment in interface Section 15, and this dated supplement. New or amended architecture decision: this amendment extends ADR-0030 in place and no new ADR number is introduced. Roadmap impact: none; TASK-109's deliverable, dependencies, and lifecycle are unchanged and no release allocation is made.

### Amendment (2026-10-21): Shared v0.1.3 release allocation

Master decided on 2026-10-21 to publish M8, M9 and EPIC-017 together as v0.1.3 on the v0.1.x line, superseding this record's statements that M9 allocates no release and that the intended v0.1.3 keeps M8-only scope; the allocation is adopted under [ADR-0033](#adr-0033-channel-adoption-hardening-and-the-shared-v013-release). The deliberately breaking nullable `storageKey` DTO revision and the operationally breaking schema 7-through-11 upgrade and format-3 snapshot boundary for older readers therefore ship in a patch version per interface section 38.8's classifications, and must be stated prominently in the release notes and upgrade guidance. Publication follows ADR-0033's coordination: a verified local candidate shared with Aquarium and Aquarium's confirmation that its v0.1.21 adoption is ready, because a published v0.1.x release is immediately eligible for Aquarium's global setup resolver. Version change, tag, installation, consumer notification and publication remain separately authorized.

Alternatives considered and rejected: publishing M8 alone and M9 as v0.2.0, which needs a release branch and two release cycles although it would keep M9's breaking data contract out of a patch version; and delaying any release until after v0.2.0, which postpones the preflight interface Aquarium needs. Compatibility impact: none beyond disclosing the changes section 38.8 already classifies. Migration impact: none new; the upgrade and rollback procedure of [the operations guide](../ops/README.md#m9-shared-content-upgrade-and-rollback) and the section 38.7 supported-inventory rules continue to govern the one-way schema 7-through-11 upgrade. Required Source of Truth edits: the M8 and M9 release-gate rows of the roadmap, the CHANGELOG, the release statements of required-specification section 21 and interface section 38, and this supplement. New or amended architecture decision: this amendment extends ADR-0030 in place and no new ADR number is introduced. Roadmap impact: TASK-111 records the allocation; publication timing remains a coordination point with Aquarium and no Task's lifecycle changes.

## ADR-0031: Legacy short Artifact identifiers and format-3 acceptance

- **Status:** Accepted (2026-10-18)
- **Date:** 2026-10-18
- **Scope:** TASK-106 compatibility correction under [EPIC-016](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage).

### Problem

The existing `revise` producer generated Artifact IDs as `a` plus the first eight lowercase hexadecimal characters of SHA-1 over the Handoff ID, next revision and timestamp, while `send` used the UUID generator. Architecture sections 3.3 and 3.4 described both Artifact identity fields only as UUIDs. A UUID-only format-3 validator therefore rejects ordinary existing revisions, violating SHR-014 and TASK-106's baseline backup round-trip obligation. NFR-008 specifies the format of UUIDs; it does not require every historical identifier to be a UUID.

### Decision

New revisions use the existing UUID generator, as new sends already do. Readers preserve existing Artifact IDs and their `currentArtifactId` references when they are canonical UUIDs or exactly `a` followed by eight lowercase hexadecimal characters. Only these two fields gain the legacy exception; all other UUID-typed fields, workspace and User strings, legacy intent IDs, closed record shapes, identity-derived managed keys, sizes and hashes keep their existing rules. Validate unknown input as a string before testing either form. Do not rewrite existing IDs, references, storage keys, file bytes, receipts or pending intents.

### Alternatives considered

- Relax every identifier to a safe path segment | rejected: path safety does not establish domain identity and would admit unsupported values into unrelated UUID fields.
- Rewrite old Artifact IDs during migration or restore | rejected: it changes retained identity, storage keys, receipts and filesystem promises, contrary to SHR-014.
- Keep the UUID-only reader until TASK-107 | rejected: TASK-106 must independently round-trip the supported file-backed baseline without requiring later adoption.
- Continue generating hash-prefix revision IDs | rejected: the existing UUID port supplies the required new identity without another generator or collision policy.

### Compatibility impact

The format-3 reader accepts the proven legacy form in the two Artifact identity fields. Existing DTO shapes remain unchanged by this correction; newly generated opaque Artifact IDs and their storage-key segments become UUIDs. Formats 1 and 2 retain their frozen readers. This correction does not change ADR-0030's separately classified nullable-storageKey migration.

### Migration impact

No new migration is added beyond TASK-106's additive migration 8, and no legacy row or file is repacked. Compare existing domain rows, receipt response strings and pending-intent fields immediately before and after migration; the new owner columns are null on legacy intents. Inspection without startup drain leaves those operational rows unchanged. Normal startup recovery still completes pending filesystem operations under their existing contracts. Restore preserves exported domain identity and body bytes and continues to exclude operational receipts and pending intents.

### Required Source of Truth edits and roadmap impact

Clarify the Artifact ID and current-Artifact reference types in [architecture sections 3.3 and 3.4](../architecture/README.md#33-handoff), and the format-3 acceptance rule in [interface section 38.8](../specs/interfaces-and-operations.md#388-public-contract-classification-and-format-3-serialization). NFR-008 remains unchanged. Task identities, dependency order, milestone and release allocation remain unchanged; TASK-105 is not reopened. TASK-107 must preserve both Artifact-ID forms through its rebuild, keep the corresponding format-3 acceptance rule for inline bodies, and treat the new content-record UUID as independent from an existing Artifact ID.

### Consequences

Existing revisions remain readable and restorable while new revisions conform to UUID generation. Qualification covers a populated schema-7 legacy revision through the real schema-8 upgrade and format-3 export, verification, dry-run and restore, plus native UUID-producing revisions and frozen legacy restore inputs. No historical completion events are inferred or backfilled by this identity correction.

## ADR-0032: Memo operational coherence errors in M9

- **Status:** Accepted (2026-10-19)
- **Date:** 2026-10-19
- **Scope:** TASK-108 error-contract clarification under [EPIC-016](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage)

### Problem

TASK-108's bounded Memo read and write designs need an honest, retryable refusal for operations whose view of the authoritative database cannot be kept coherent: a Memo list page assembled from bounded candidate batches must reflect one database read snapshot (MEM-011), and a Memo mutation prepared against a freshly bound Vault must not commit after a Vault move invalidated that preparation (SHR-012, SHR-014). The existing catalogue offers no exact code for these conditions: `SERVICE_PAUSED` means a conclusively held `vault-move.lock`, `CONFIG_CONFLICT` means a stale configuration revision or changed ETag, and `INTERNAL_ERROR` is a forbidden fall-through for an expected refusal.

### Decision

From M9, the existing shared code `STORAGE_INSPECTION_UNAVAILABLE` (HTTP 503, CLI exit 75) additionally covers two Memo operational conditions: a Memo list page that cannot be assembled coherently because the database kept changing across the bounded attempt budget, and a Memo write whose preparation state could not be kept coherent with the authoritative database under the same finite budget. The refusal is honest about what happened — no page was emitted and this invocation committed nothing — and per-surface recovery guidance travels in the response's existing recovery field, directing a read retry or a retry of the mutation with its original mode and inputs and the original key when one was present, never an automatic execute, a replacement key, or a claim that the write committed. The mode preserved on retry is the current invocation's mode: a replay-only recovery attempt stays replay-only across its retries and never reverts to the execute mode of an earlier unknown attempt, whose outcome remains unknown (MEM-007, [Memo contract section 9](../specs/project-memos.md#9-http-and-error-contract)). This is an additive surface use of an existing section 15 row; the response envelope, protocol version 1, `/api/v1` routing, the error enum, and every exit-code category are unchanged.

### Alternatives considered

- A new symbolic code for Memo coherence refusals | rejected: a larger public contract change than the additive reuse of an existing row whose meaning already is that a safe coherent storage view cannot be established.
- Reporting coherence exhaustion as `CONFIG_CONFLICT` or `SERVICE_PAUSED` | rejected: dishonest unless a Vault path actually changed or the lock is conclusively live, and both codes carry their own stronger contracts.
- Falling through to `INTERNAL_ERROR` | rejected: an expected, retryable refusal must not surface as an unexpected defect, and the storage guards forbid that fall-through.

### Compatibility impact

The M8 send replay-only usage of `STORAGE_INSPECTION_UNAVAILABLE` keeps its CLI-only scope, its canonical hand recovery text, and the guidance of interface section 37 unchanged; the section 15 row's recovery cell stays generic and per-surface guidance remains a response concern. Section 16 already places the code in the exit-75 temporary-conflict category. No Handoff surface, snapshot format, or DTO changes.

### Migration impact

None. This decision is a documentation-only error-contract clarification; the Memo schema-10 adoption migration, its rebuild, and every storage change remain TASK-108 implementation work under the reviewed plan.

### Required Source of Truth edits and roadmap impact

Executed with this decision: the shared-error row of [interface section 15](../specs/interfaces-and-operations.md#15-symbolic-error-codes) extends its meaning to the two M9 Memo conditions with a cross-reference from [interface section 38.2](../specs/interfaces-and-operations.md#382-input-bounds-and-classification), and [the Memo contract](../specs/project-memos.md#7-read-model-and-paging) gains the bounded coherence and recovery clarification in its sections 7, 8, and 9. Requirement identities, the roadmap registry, dependency order, milestone and release allocation, and Task lifecycle are unchanged; this clarification is not a Task completion candidate.

### Consequences

Memo reads and writes gain an honest, bounded, retryable refusal under sustained concurrent database changes, with conservative availability disclosed rather than hidden: a client may need to reissue an identical request. The finite write-attempt budget, the once-captured accepted input, and the unchanged replay-only uncertainty boundaries (MEM-007) make the refusal's guarantee precise: this invocation made no new Memo commit. The refusal does not settle any earlier outcome-unknown attempt and authorizes neither an execute fallback nor a replacement key; a retry preserves the caller's original mode and inputs, and the original key when one was present. A committed-but-unmaterialized write keeps its existing `CONTENT_MATERIALIZING` contract.

### Amendment (2026-10-20): Channel write-preparation coherence

Channel mutations need the same honest bounded-coherence refusal the Memo domain gained, but interface Section 15's M9 extension named only Memo list pages and Memo write-preparation, and silently borrowing the row for Channel, or reporting a configuration conflict without one, would be untruthful. This amendment extends the existing `STORAGE_INSPECTION_UNAVAILABLE` row to Channel list pages and Channel mutation write-preparation under the same rules: a failed page emits no partial page, the refusing invocation committed nothing, a retry preserves the current invocation's mode, the original input, and the original key when one was present, an earlier unknown outcome remains unknown with no execute fallback and no replacement key, and the refusal stays conservative, retryable, disclosed availability. A conclusively live Vault-move or restore fence keeps `SERVICE_PAUSED`; an actually changed configuration or Vault binding observed during preparation may report `CONFIG_CONFLICT`, which this decision record already accepts for a genuinely changed Vault path and which is never reserved to a literal configuration compare-and-set alone; unrelated external database churn or plain attempt exhaustion never does.

Alternatives considered and rejected: a new symbolic code, a larger public contract change than the additive reuse of an existing row; silent reuse without a Source of Truth change, which the Memo-scoped M9 extension forbids; `CONFIG_CONFLICT` for every exhaustion, dishonest absent an actual configuration or binding change because it invents a configuration compare-and-set conflict; and `SERVICE_PAUSED` for exhaustion, dishonest unless a fence is conclusively live.

Compatibility impact: an additive surface use of an existing Section 15 row, with the Memo and send-replay meanings and their historical acceptance preserved, no new error enum, ADR number, exit-code category, or DTO, and no HTTP or Web surface change. Migration impact: none, because this is a documentation-only error-contract clarification.

Required Source of Truth edits: the `STORAGE_INSPECTION_UNAVAILABLE` row clause in interface Section 15, the Channel coherence paragraph of interface Section 38, and this dated amendment. New or amended architecture decision: this amendment extends ADR-0032 in place because this record owns the error family, while ADR-0030 remains the Channel design owner. Roadmap impact: none; no Task, dependency, or lifecycle change and no release allocation is made.

### Amendment (2026-10-21): Storage-preparation contention

The existing `STORAGE_INSPECTION_UNAVAILABLE` row additionally covers, from EPIC-017 and for the Channel, Handoff, and Project CLI command families, a database open, migration, or actor-resolution failure caused by storage contention or unavailability, and a busy write-lock acquisition, classified in the shared CLI and adapter layers rather than per action. The refusal is produced only at pre-commit sites — connection open, migration, actor resolution, and the write-lock acquisition or commit of the command's own domain transaction — and asserts that the invoking command committed none of the domain changes it was asked to make; startup recovery and the migration path may already have committed earlier operations' completions or housekeeping, every step after a domain commit is post-commit work that never becomes this refusal, and no post-commit failure escapes as an untyped usage error. The refusal never covers schema-unsupported, integrity, configuration, conclusive-fence, or content-materialization conditions, which keep their existing codes; an unreadable configuration file is `CONFIG_INVALID`. A Channel command resolves its actor on its existing open-and-migrated connection. Per-surface recovery guidance travels in the response's recovery field from this refusal's first introduction.

Alternatives considered and rejected: a new symbolic code, for this record's recorded reasons; per-action catches in Channel commands, because the Handoff and Project families share the same untyped path; and extending the classification to every other command family, which keep their current contracts except the shared-adapter and shared-core corrections listed in interface section 38.10. Compatibility impact: an additive surface use of an existing Section 15 row with its meaning extended at pre-commit sites only; no new error enum, ADR number, exit-code category, or DTO, and no route, status-code inventory, or Web screen changes, while the actual response for expected write-lock contention on the daemon's Handoff and Project routes changes from `500 INTERNAL_ERROR` to the documented `503 STORAGE_INSPECTION_UNAVAILABLE`, having committed none of the requested domain changes. Migration impact: none, because this is a documentation-only error-contract clarification; implementation belongs to TASK-112 and later Tasks under [ADR-0033](#adr-0033-channel-adoption-hardening-and-the-shared-v013-release). Required Source of Truth edits: the `STORAGE_INSPECTION_UNAVAILABLE` row of interface Section 15, the shared-layer contention paragraph added after that table, SHR-015, security-reliability section 7, and this dated amendment. New or amended architecture decision: this amendment extends ADR-0032 in place because this record owns the error family. Roadmap impact: TASK-112 and TASK-113 implement under ADR-0033; no Task's lifecycle changes and no release is allocated here.

### Amendment (2026-10-22): Write-protected storage

The existing `STORAGE_INSPECTION_UNAVAILABLE` row additionally covers, for the Channel, Handoff, and Project CLI command families and the daemon routes that share their adapter classification, a write-protected installation: a database open or migration failure whose engine signature is a readonly database (`SQLITE_READONLY`, "attempt to write a readonly database") at the same enumerated pre-commit sites. The refusal's guarantee is unchanged — the invoking command committed none of the domain changes it was asked to make — and its recovery is state-accurate: after write access to the Sorage home and Vault is restored (permissions, sandbox, or read-only mount), the caller retries the identical command with its original mode, inputs, and idempotency key, and an unknown keyed Channel submission or send is inspected with `--replay-only` first, an inspection that runs without write access on a stable, readable installation; the recovery never suggests a quieter-storage retry, a fresh idempotency key, a mode switch, or an authority flag. Project surfaces, which have no replay-only mode, carry only the restore-access-then-retry-identically wording. The replay-only inspections themselves (send and Channel submit) and preflight stop misreporting a stable, readable, write-protected installation: their shared private-copy inspection makes its private database and WAL copies owner-writable, so the WAL-recovery open on the copy never requires source write access, while genuine incoherence, fences, and read denial still refuse (the TASK-119 correction of the TASK-098/109-lineage capture, ruled committed-scope by the Epic Evaluator's 2026-10-22 F-b finding).

Alternatives considered and rejected: a new symbolic code, for this record's recorded reasons; narrowing security-reliability section 17 or the replay-only contracts so a write-protected installation refuses inspection, rejected because a stable, readable source is inspectable and the M8 boundary already forbids writing the source; and a quieter-storage recovery for the write-protected state, rejected as a blind retry that cannot fix a denied write. Compatibility impact: an additive surface use of an existing Section 15 row with its meaning clarified in place; no new error enum, ADR number, exit-code category, or DTO, and no route, status-code inventory, or Web screen change, while the actual responses change as interface section 38.10 records. Migration impact: none, because this is a documentation-only error-contract clarification; implementation belongs to TASK-119 under [ADR-0033](#adr-0033-channel-adoption-hardening-and-the-shared-v013-release). Required Source of Truth edits: the `STORAGE_INSPECTION_UNAVAILABLE` row's meaning cell of interface Section 15 and its shared-layer paragraph, SHR-015, security-reliability section 7, interface section 38.4's Channel recovery sentence, and this dated amendment. New or amended architecture decision: this amendment extends ADR-0032 in place because this record owns the error family. Roadmap impact: TASK-119 implements under ADR-0033; no Task's lifecycle changes and no release is allocated here.

## ADR-0033: Channel adoption hardening and the shared v0.1.3 release

- **Status:** Accepted (2026-10-21; proposed 2026-10-21)
- **Date:** 2026-10-21
- **Design owner:** TASK-111 under [EPIC-017](../roadmap/README.md#epic-017-channel-adoption-hardening-and-v013-release-readiness).

### Problem

Aquarium plans to deliver every Executor and Evaluator report in its Epic Squad workflow to a Coordinator through Sorage Channels, with several roles submitting concurrently against one Installation. Its 2026-10-20 adoption request, confirmed by Sorage against `63291a9`, showed that the M9 Channel surface does not yet behave predictably under that load. Expected storage contention escapes as an exit-2 usage message without an envelope. Long waits end at the first retryable listing failure. Committed submissions and handling decisions can be reported as failures without their identities. Channel conflicts reuse Handoff recovery text. Unknown filter IDs wait silently to the timeout despite interface section 38.4. The shipped policy leaves a main-directed new attempt after an unknown outcome undefined, and no document lists the storage that reads and waits write. [The canonical roadmap](../roadmap/README.md#epic-017-channel-adoption-hardening-and-v013-release-readiness) records the Task boundaries and links their lasting outcomes.

Separately, ADR-0030 allocated no release to M9 and kept the intended v0.1.3 release M8-only, while Aquarium needs one published release containing M8 and M9 before it can adopt Channels and the installation preflight.

### Decision

Proposed: register EPIC-017 in M9 as the release-blocking correction Epic, and publish M8, M9 and EPIC-017 together as v0.1.3 on the v0.1.x line, as Master decided on 2026-10-21. Publication follows a verified local candidate shared with Aquarium for rehearsal and Aquarium's confirmation that its v0.1.21 adoption is ready, because a published v0.1.x release is immediately eligible for Aquarium's global setup resolver.

TASK-111 settles exact codes, fields, exit statuses and wording for these contract directions:

- Classify database open, migration and actor-resolution failures in the shared CLI and adapter layers, so that expected contention returns a typed, retryable envelope for Channel, Handoff and Project commands. The error-family choice is made under ADR-0032.
- Keep Channel waits and the Handoff `inbox --wait` loop polling across retryable listing failures until the deadline.
- Never report a committed submission or handling decision as a plain failure.
- Give Channel errors Channel-specific, state-aware recovery text.
- Enforce the not-found filter codes that interface section 38.4 already requires.
- Document the paths each Channel command writes, and state that reads and waits are non-mutating for domain records only.

For a new attempt after an unknown outcome, a new direct main-participant assignment for a new attempt is a genuinely new intent. The assigned role may submit its existing result once under a new idempotency key bound to the new `--context-attempt`. Authority comes only from the main participant through the role's own direct instruction surface; message bodies, recovery hints, replay results and changed context fields confer none. The earlier outcome stays unknown and may still commit. Main treats a message bound to a superseded attempt as stale, and a role never retries on its own initiative (CHN-006).

TASK-111 accepted this record on 2026-10-21; its Problem and Proposed-decision text records the pre-adoption state, the accepted contracts are adopted in their canonical owners, and the pre-adoption statements this record supersedes are reconciled there.

### Acceptance record (2026-10-21)

Accepted by TASK-111 with these completions, settled in the canonical owners named in `Required Source of Truth edits and roadmap impact`: the contention family is the additive `STORAGE_INSPECTION_UNAVAILABLE` extension recorded in ADR-0032's 2026-10-21 amendment, produced only at pre-commit sites, with the post-commit rule that physical completion returns the committed outcome and a warning, advisory derived-view refresh and logging, disclosure, and cleanup sinks never change the result, Project adapters read a mutation's result rows inside the committing transaction so a read failure rolls back with nothing committed, and every correction applying to the shared core serves each calling surface with no route, DTO, status-code inventory, or screen change, while the actual responses change as [interface section 38.10](../specs/interfaces-and-operations.md#3810-epic-017-public-contract-classification) records; committed Channel outcomes return success shapes carrying their identifiers — `contentActivating`, the negation of the database-observed materialized state of the message's content record when the response is produced, always false for inline content and derived read-only at replay time through a database-only content-state probe with the stored receipt format unchanged, and `bodyPreviewUnavailable` — where previously an error was returned; waits distinguish arrival, the ordinary empty timeout with `meta.timedOut: true`, and a retried failure persisting at the deadline, report no retry count, and fix the Handoff wait's known set by the first complete successful seed as the IDs whose creation time precedes the invocation instant; unknown participant and assignment filters fail immediately per interface section 38.4; the main-directed new-attempt rule and the no-fresh-key rule are normative in CHN-006 and interface section 38.6; the writable-path disclosure is security-reliability section 17; an unreadable configuration file keeps `CONFIG_INVALID` with an explicitly extended row meaning; interface section 38.10 owns the planned public-contract classification; and TASK-112 and TASK-113 each record their observed snapshot-diff classification and migration impact in a contract-record subsection of the EPIC-017 roadmap section at completion.

### Acceptance clarification (2026-10-21): unreadable configuration in replay-only inspection

Problem: SHR-015 and the interface section 15 shared-layer paragraph state that an unreadable configuration file is `CONFIG_INVALID` without limiting the rule to operational command paths, while the replay-only inspections that `send --replay-only` and `channel submit --replay-only` use deliberately report a configuration they cannot read safely as `STORAGE_INSPECTION_UNAVAILABLE` (the replay-only recovery inspection), CHN-006 and interface section 38.6 bind Channel replay-only to exactly the M8 send recovery semantics, and the adopted AJ-25 note keeps those semantics unchanged. Decision: the `CONFIG_INVALID` rule for an unreadable configuration applies to the operational command paths; replay-only inspection keeps its recovery-inspection semantics, and TASK-112 implements exactly that split. The same operational-path scope applies to the matching sentence in ADR-0032's storage-preparation contention amendment and to the corresponding sentence of this record's acceptance above; both accepted texts are left unchanged and read through this clarification. Alternatives considered: changing replay-only to `CONFIG_INVALID`, rejected because it would alter the pinned M8 recovery contract and its goldens; leaving the wording ambiguous, rejected because a later Task could read the parenthetical as covering the inspection path. Compatibility impact: none — the implemented behavior is the behavior both surfaces already have. Migration impact: none. Required Source of Truth edits: the SHR-015 clause and the interface section 15 shared-layer paragraph are clarified in place; this dated note records the clarification.

### Acceptance clarification (2026-10-21): enumerated pre-commit refusal sites

Problem: TASK-112's implementation classifies the keyed idempotency lookup's expiry-cleanup write — an autocommit `DELETE` of expired receipts that `send`, `revise`, and `delete approve` run during write preparation, before their domain transactions, and that a keyed `send` runs again after its fan-out transaction rolls back to detect a raced replay — and the startup drain's recovery and cleanup transactions as `STORAGE_INSPECTION_UNAVAILABLE` refusals under SHR-015, but the enumerated refusal sites in SHR-015, the interface section 15 shared-layer paragraph, and security-reliability section 7 read "only at pre-commit sites — connection open, migration, actor resolution, and the write-lock acquisition or commit of the command's own domain transaction", which a roadmap record cannot widen; leaving those writes unclassified would surface expected contention on covered pre-commit paths as `INTERNAL_ERROR` exit 1. Decision: the enumerations in SHR-015, interface section 15, and security-reliability section 7 name the keyed idempotency lookup's expiry-cleanup write and the startup drain's recovery and cleanup transactions among the pre-commit refusal sites, matching the TASK-112 audit of every pre-commit database write a covered command can reach; body preparation itself stages files only and writes no database row before the domain commit. Alternatives considered: leaving the expiry cleanup as `INTERNAL_ERROR`, rejected because it is an expected contention outcome on a covered pre-commit path and the refusal's no-domain-change assertion is exactly true there; moving the cleanup inside the domain transaction, rejected because it changes receipt-expiry behavior outside this Task's authority; widening only the roadmap contract record, rejected because a Task record cannot extend a Source of Truth enumeration. Compatibility impact: none — the refusal's code, exit, and no-domain-change assertion are unchanged; only the enumerated site list is completed. Migration impact: none. Required Source of Truth edits: the SHR-015 enumeration sentence, the interface section 15 shared-layer paragraph enumeration, and the security-reliability section 7 enumeration, each edited in place on one source line; this dated note records the clarification. The same scope applies to the matching enumeration in ADR-0032's 2026-10-21 storage-preparation contention amendment and to this record's own acceptance sentence "produced only at pre-commit sites"; both accepted texts stay unchanged and are read through this clarification.

### Acceptance clarification (2026-10-21): unconfirmed content state

Problem: CHN-012 and interface section 38.4 define `contentActivating` through the database-observed materialized state, TASK-113 implements the flag through a database-only content-state probe, and a probe that cannot observe a file-backed record's state is neither an observation of the unmaterialized state nor permission to report the committed outcome as a plain failure, which the accepted sentences do not settle. Decision: the flag is derived by reflecting the message's content record as the database shows it when the response is produced: false when materialized and true when unmaterialized, derived read-only at replay time from the current record state through a database-only content-state probe; always false for inline content, identified by its recorded size under SHR-002's routing threshold, without a probe; when the probe cannot observe a file-backed record's state, the committed or recorded outcome is still returned with `contentActivating: true`, meaning activation is not confirmed, and the failed observation is disclosed as a warning; the stored receipt format is unchanged. Alternatives considered and rejected: returning the probe error, because CHN-012 forbids reporting a committed outcome as a plain failure; returning false on an observation failure, because it asserts a readable, materialized state nobody observed; a third state or a new field, because it changes the closed DTO shape interface section 38.10 classified and later Tasks consume. Compatibility impact: none for the shape — the boolean field is unchanged and only its meaning on an observation failure is specified. Migration impact: none. Required Source of Truth edits: the `contentActivating` clause of CHN-012 and the `contentActivating` sentence of interface section 38.4, edited in place as this note records; roadmap impact: TASK-113 implements under ADR-0033 with this clarification, and no Task's lifecycle changes.

### Alternatives considered

- Publish M8 alone as v0.1.3 from the M8 closeout and M9 later as v0.2.0 | not selected by Master: it needs a release branch and two release cycles, although it would keep M9's breaking data contract and one-way upgrade out of a patch version.
- Publish M8 and M9 together as v0.2.0 | not selected by Master: it delays the preflight interface and requires Aquarium to change its version line before adopting either milestone.
- Publish M8 and M9 without these corrections | rejected: concurrent Coordinator waits would end early or fail as non-retryable usage errors, and committed outcomes would be reported as failures.
- Catch failures only in Channel actions | rejected: Handoff and Project commands share the same untyped path and missing contention classification, so a Channel-only catch would leave the defect elsewhere.
- Keep the strict rule that a lost report can never be resubmitted | rejected: a role could not deliver its result even after main inspected the Channel and assigned a new attempt, although a direct main-participant assignment is already a recognized source of authority.
- Let a role resubmit with a fresh key on its own after an unknown outcome | rejected: CHN-006 forbids treating an unknown outcome as permission for a blind repeat.
- Add a non-mutating read and wait path now | deferred to future work: documenting the writable paths answers the request, and skipping startup recovery needs its own safety design.
- Push messages or wake signals into the Coordinator's prompt | rejected for this release: ADR-0030 separates reports from user instructions, and automatic wake-up stays deferred under CHN-010.

### Compatibility impact

Previously untyped exit-2 failures become typed envelopes in a retryable exit category. Committed `handle` results that failed only in preview become successes, committed outcomes return success shapes carrying their identifiers — `contentActivating` for submit and `bodyPreviewUnavailable` for handle — recovery text changes, and unknown filters fail instead of waiting. TASK-111 classifies each change and its golden snapshots as breaking or non-breaking in interface section 38.10, and no existing DTO field is removed. The shared v0.1.3 release also carries ADR-0030's deliberately breaking nullable `storageKey` field in a patch version, which the release notes must state.

### Migration impact

No schema, snapshot-format, Vault-layout or receipt migration is planned for EPIC-017; TASK-111 must confirm that or justify any exception. The release inherits M9's one-way upgrade from schema 7 through 11 for v0.1.2 homes, with the old-binary backup, restore drill and absence of in-place downgrade described in [the operations guide](../ops/README.md#m9-shared-content-upgrade-and-rollback).

### Required Source of Truth edits and roadmap impact

Executed at registration: EPIC-017 and TASK-111 through TASK-116 in the roadmap with Requirements cells set to None, a temporary execution dossier and its TODO index entry, the documentation index, [the governance registration boundary](../governance/README.md#15-m9-adoption-hardening-registration-boundary), a traceability note, and a future-work candidate. To be executed by TASK-111 at acceptance: accept or revise this record; add a dated ADR-0030 amendment for the shared release; update the M8 and M9 release-gate rows and the CHANGELOG; adopt the contracts in the required specification, interface sections 13 to 16 and 38, security-reliability, testing-and-acceptance and traceability; and populate every EPIC-017 Requirements cell. TASK-115 owns the shipped skill text.

### Consequences

M9 gains a release-blocking correction Epic, and v0.1.3 becomes the first published release containing Channels and shared content. Concurrent Channel consumers receive typed, retryable results and committed identities, at the cost of reviewed contract changes and new golden snapshots. Publication timing becomes a coordination point with Aquarium. Product implementation, independent review, installation, publication and every broker operation retain their own authorization.

## ADR-0034: Sorage MCP adapter, zero-write reads and the Channel rebuild

- **Status:** Proposed (2026-10-23)
- **Date:** 2026-10-23
- **Design owner:** TASK-121 under [EPIC-018](../roadmap/README.md#epic-018-mcp-access-zero-write-reads-and-channel-rebuild).

### Problem

Agents in sandboxes cannot use Sorage. Every command, reads included, runs startup recovery, the migration path and log writes against the Sorage home, so a caller that cannot write the home cannot read or wait, and writes need the home and sometimes the Vault, which sandboxes deny. EPIC-017 classified that refusal and documented the writable paths instead of removing the limit.

The M9 Channel surface is also hard for agents to use:

- participant UUIDs and role assertions that protect nothing;
- a row version whose only succeeding value is known in advance;
- three processes per handled message;
- retained idempotency material with replay-only recovery;
- a write path that rolls back and retries on every concurrent commit;
- guidance dominated by exceptions.

Its acceptance observers ran outside sandboxes. The [execution dossier](../todo/mcp-and-channel-rebuild.md) records the confirmed findings.

On 2026-10-23 Master directed that agents send and read Handoffs, Project Memos and Channel messages from any environment, including a sandbox that cannot write anything, and that the Channel surface be rebuilt in full before the shared v0.1.3 release.

### Decision

Proposed:

- **Add `sorage mcp`.** It is a STDIO MCP server for the messaging domains, registered globally like Mulgae and Gaori. Agent harnesses launch MCP servers outside the shell sandbox, so MCP tool calls send and read from a fully read-only sandbox.
  - The server executes each tool call as a `sorage … --json` child process of the same executable and returns the CLI envelope.
  - Bodies are inline, and file arguments are confined to the call's workspace.
  - Administration and User-admin operations are not exposed.
  - This lifts ADR-0007's MCP deferral for these domains. The Handoff and Memo contracts are stable and versioned, EPIC-017 hardened the error semantics, real agent usage has been observed, and the Channel contract stabilizes with this Epic.
- **Make read commands write nothing.** They open the database read-only and perform no startup recovery, migration, cleanup or log write. Writers keep WAL sidecars persistent so that SQLite's read-only WAL access applies. Only a database whose sidecars are absent is read through a coherent in-memory copy of its complete main file.
- **Rebuild Channels.**
  - Address by globally unique Channel names, participant handles and per-Channel sequence numbers.
  - Make create, add, remove, ack and close idempotent.
  - Make post retries safe by content instead of idempotency keys, receipts and replay-only.
  - Allow posting upstream only.
  - List full bodies, with file paths for file-backed bodies.
  - Give waits an `--after` filter and a 60-second default.
  - Record User-actor provenance with handles in event metadata.
  - Replace schema 11 and the format-3 Channel representation in place.
  - Remove assignments, context options, role assertions, row-version handling, the coherence loop, the result indicators and per-error recovery overrides.
- **Add `sorage revise --body`.**
- **Ship v0.1.3 after this Epic**, together with M8, M9 and EPIC-017.

TASK-121 settles exact requirements, codes, fields, tool schemas and wording. Until TASK-121 accepts or revises this record, the current specifications, accepted decisions and the release-gate table remain authoritative.

### Alternatives considered

- Relay sandboxed writes through request files in the workspace and an always-on daemon | rejected: it needs a running broker and workspace discovery, and it cannot serve a sandbox that cannot write its workspace, which the harness-launched MCP server covers with less machinery.
- Configure each harness's sandbox to allow the Sorage home and Vault | rejected as the product path: it is per-harness configuration outside Sorage, and it widens sandbox write access beyond Sorage operations.
- Call the daemon's HTTP API from the sandboxed CLI | rejected: default sandboxes deny network access, including loopback.
- Implement the MCP server in-process on the application layer | rejected: it duplicates each command's open, migrate, drain, close and rendering lifecycle beside the CLI, and it keeps long-lived connections across Vault moves and the daemon's configuration-writer rule.
- Reconstruct the database from the main file and WAL frames by hand for zero-write reads | rejected: it reimplements SQLite's WAL format, while SQLite already supports read-only WAL access when the sidecars exist.
- Open live storage with `immutable=1` | rejected, as in ADR-0028: committed data may exist only in the WAL, and a writer can invalidate the assumption.
- Expose the current Channel surface through MCP | rejected: it freezes the surface that Master decided to replace into a second interface, contrary to ADR-0007's reasoning.
- Simplify the current Channel implementation in place | not selected by Master: the copied Memo machinery and the defensive structure would remain.
- Keep idempotency keys and replay-only for Channel posts | rejected: retry by content gives the same safety without material that the agent must retain.
- Let main post into its own Channel | rejected: main-to-agent dispatch stays consumer-owned under ADR-0030, and main's own posts would wake its waits.

### Compatibility impact

The following are replaced: the Channel CLI and JSON contract, the Channel error codes, schema 11 and the format-3 Channel representation. No published release carries them, because v0.1.2 has no Channels and the v0.1.3 candidate is unpublished. No published consumer breaks, but Aquarium's planned adoption must follow the replacement contract.

Handoff, Memo and Project read commands keep their outputs and exits but lose their side effects: they no longer run startup recovery, migration or cleanup, and write no log. `sorage mcp` and `revise --body` are additive. TASK-121 classifies every interface, golden-snapshot and skill change.

### Migration impact

- Schema 11 is replaced in place under a new migration name. A development home that applied the old schema 11 is refused rather than misread, and no real home holds it.
- The unreleased format-3 Channel representation is replaced in place, and development snapshots containing old Channel shards are refused.
- Persistent WAL sidecars stay beside the database after the last connection closes.
- The v0.1.2-to-candidate upgrade drill is rerun on the new candidate. The M9 one-way upgrade from schema 7 and the old-binary rollback procedure are otherwise unchanged.

### Required Source of Truth edits and roadmap impact

Executed at registration:

- EPIC-018 and TASK-121 through TASK-126 in the roadmap, with Requirements cells set to None;
- the [execution dossier](../todo/mcp-and-channel-rebuild.md) and its TODO index entry;
- the documentation index;
- [the governance registration boundary](../governance/README.md#16-m9-mcp-and-channel-rebuild-registration-boundary);
- a traceability note;
- the move of the MCP adapter and non-mutating Channel read candidates from future work into this Epic.

To be executed by TASK-121 at acceptance:

- accept or revise this record;
- add dated amendments to ADR-0007, ADR-0030 and ADR-0033;
- adopt the contracts in the required specification, interface sections 15, 16 and 38 and a new MCP section, security-reliability, testing-and-acceptance and traceability;
- update the M9 release-gate row and the CHANGELOG for v0.1.3;
- populate every EPIC-018 Requirements cell.

TASK-125 owns the shipped skill text.

### Consequences

Sorage messaging works from sandboxed agents: reads run directly through the CLI, and every messaging operation runs through MCP tool calls. The Channel loop shrinks to five commands, with no identifiers or recovery material beyond names, handles and sequence numbers. Sorage gains an MCP adapter whose tool schemas become a public contract maintained beside the CLI, and v0.1.3 is requalified on a new candidate. Product implementation, independent review, global MCP registration, installation, publication and every broker operation retain their own authorization.
