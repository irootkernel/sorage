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
