# Testing and Acceptance

## 1. Tooling

The toolchain is normative, fixed by ADR-0016 in [architecture-decisions.md](architecture-decisions.md) and by NFR-016 and NFR-017 in [required-specification.md](required-specification.md); a test that cannot run under it is not a valid test.

| Layer | Tool | Milestone |
|---|---|---|
| Unit, integration, contract | Vitest executed through Bun | 0.1 |
| Command-line end to end | The compiled `sorage` binary driven from Vitest | 0.1 |
| Web end to end | Playwright | 0.2 |
| Accessibility | axe-core inside the Playwright run, SHOULD, engineering practice rather than a gate condition (WEB-018) | 0.2 |

`make` provides at least these targets, and `make test` is the single verification gate (NFR-016):

| Target | Contents |
|---|---|
| `test-prepare` | Format check, lint including the `core`-to-`adapters` import-boundary guard (NFR-014) and the rule forbidding `await` inside a `UnitOfWork.run` callback, TypeScript strict typecheck (NFR-001), the assertion that the running Bun matches `.bun-version` (NFR-017), and the product-version consistency check across the runtime source, workspace manifests, and internal dependency declarations (NFR-003, NFR-012) |
| `test-unit` | Pure domain and application tests with no filesystem and no database |
| `test-int` | SQLite, filesystem, config, Git, and platform adapters against temporary fixtures, including a run against a clean temporary `SORAGE_HOME` with no ecosystem tool installed (GEN-010) |
| `test-contract` | CLI JSON envelopes, HTTP DTOs, error bodies, exit-code categories, the symbolic-error to HTTP-status matrix (API-011), pagination cursors, the `doctor` catalog (INIT-017), and the config schema |
| `test-e2e` | Whole journeys: the compiled CLI from 0.1, and Playwright plus axe-core from 0.2 |
| `test` | All of the above in order |
| `build` | `bun build --compile` producing `dist/sorage` |
| `package` | The signed binary plus the Homebrew formula inputs |

Verification runs locally on the developer's macOS machine through `make test`; `test-prepare` asserts Bun `1.4.0` as pinned in `.bun-version` at the repository root and mirrored in the `package.json` `engines` field, so no environment can silently drift from the pin; a mismatch fails in `test-prepare` before any test executes. This repository uses no hosted continuous-integration service.

## 2. `testkit` contract

`testkit` ships inside the `adapters` package, is never imported by `core`, and is the only place a test may construct infrastructure; the import-boundary lint of `test-prepare` enforces both halves (NFR-014).

| Fixture | Contract |
|---|---|
| Temporary home | Creates a throwaway directory, exports it as `SORAGE_HOME`, and removes it afterwards, so no test can touch the developer's `~/.sorage` (INIT-015) |
| Temporary Vault | A Vault directory with a valid marker, `.gitattributes`, `.gitignore`, `artifacts/`, `snapshots/`, and `staging/`, or deliberately without one of them for negative cases |
| Temporary database | A migrated SQLite database in the temporary home, with WAL, foreign keys, and `busy_timeout` configured exactly as production |
| Git remote fixture | A bare repository plus a second clone, so a real non-fast-forward can be produced by committing in the second clone and pushing before the Vault does; no mock stands in for Git's own refusal |
| Fake `Clock` | A controllable clock with absolute set, advance, and timezone selection, enough to drive the 60-second scheduler tick across a DST transition and across a simulated sleep gap |
| Fake `IdGenerator` | Deterministic UUIDs, so snapshots and Vault paths are stable across runs |
| Fault-injection filesystem adapter | Wraps the real adapter and fails, or exits the process, at a named crash point `CP-1` through `CP-7` matching section 4, plus `disk-full` and `read-only` modes |
| Fault-injection Git adapter | Injects non-fast-forward, credential prompt, index conflict, and timeout without contacting any network |
| Seed generator | Produces 10,000 Handoffs, 1,000 Projects and Workspaces combined, and a 1,000-item inbox with deterministic ids and timestamps |
| Durability probe | A conformance test that the filesystem adapter's `fsync` reaches `F_FULLFSYNC` semantics on macOS, because Bun does not use libuv and the durability order of VLT-022 depends on it |
| Migration fixture | A captured database at the first released schema, kept in the repository from the migration's own task onward, so every later migration is exercised against real prior bytes (NFR-009) |

Every fixture is created per test and removed afterwards; a test that leaves a lockfile, a daemon, or a LaunchAgent behind is itself a defect.

## 3. Test layers

### 3.1 Unit

Review state machine over every state, operation, actor, and orthogonal field, including `declined`, `withdrawn`, Note withdrawal, and the bounded no-change resolution with `NO_CHANGE_LIMIT` on the second consecutive attempt.

Next-actor derivation, permission-matrix decisions, Revision and Row Version rules including that reads and `fetch` never increment (HND-025), slug and path validation, config validation with declared defaults, error mapping, snapshot determinism and redaction, and scheduler due-time calculation including the DST rules of BKP-026.

### 3.2 Integration

SQLite repositories, migrations against the captured fixture, transaction rollback, and the Row Version compare-and-set losing exactly once under two writers.

The filesystem Artifact store with the full intent-log protocol: intent commit, execution, completion commit, idempotent drain, `ARTIFACT_MATERIALIZING` reads, garbage collection after the drain with the `gc.graceHours` window, and the rule that no path matching a `storageKey` or a pending intent is ever removed.

Cross-process locks with `O_EXCL`, including a stale `config.lock` older than 30 seconds, a `daemon.lock` with a dead pid, and `SERVICE_PAUSED` from a second process while `vault-move.lock` is held (RUN-014).

Idempotency replay and `IDEMPOTENCY_CONFLICT`, atomic config writes with comment preservation (CFG-018) and content-hash ETag conflict (CFG-019), worktree resolution through `git rev-parse --git-common-dir` against a real worktree, nested and longest-prefix binding resolution, the `SENDER_IDENTITY_DOWNGRADE` guard, the local HTTP API, Git operations in temporary repositories, and the macOS platform adapter where a test account permits it.

### 3.3 Contract

CLI JSON envelopes and the `doctor` catalog as golden snapshots, HTTP DTOs, error bodies with symbolic code and recovery, exit-code categories, the published symbolic-error to HTTP-status matrix (API-011), ETag and Row Version conflict shapes, pagination cursors including `CURSOR_INVALID` for a cursor that does not match its filters, and `schemas/config.schema.json` against `examples/config.example.yaml`.

### 3.4 End to end

Complete journeys through the compiled binary from 0.1, and through a real browser against a real daemon from 0.2, including the Host allowlist, the fragment-secret session exchange, and the absence of any cookie.

### 3.5 Failure injection

Section 4 is the required matrix; every row is a test, and each one restarts the process, drains, and then asserts the invariant rather than asserting an internal state mid-flight.

## 4. Crash-point and failure matrix

| Case | Injection | Invariant after restart, drain, and garbage collection |
|---|---|---|
| `CP-1` | Crash after staging, before the intent commit | No Handoff, Artifact, or intent row exists; the staged file is swept from `staging/` after its age threshold; a retry with the same idempotency key succeeds and creates exactly one Handoff |
| `CP-2` | Crash after the intent commit, before the rename | Rows exist with `materialized = 0`; a read returns `ARTIFACT_MATERIALIZING` before the drain and the real Artifact after it; the SHA-256 matches the source |
| `CP-3` | Crash after the rename, before `fsync` of the parent directory | Either outcome of the rename is repaired from filesystem state; the Artifact is materialized and its checksum matches, or the Handoff is integrity-failed with `ARTIFACT_INTEGRITY_FAILED` and no file was fabricated |
| `CP-4` | Crash after `fsync`, before the completion commit | The drain sets `materialized = 1`, deletes the intents, and appends `ARTIFACT_ACTIVATED` exactly once; a second drain changes nothing |
| `CP-5` | Crash during a fan-out, between two renames | Every Handoff of the Dispatch Group exists, the group is complete, and after the drain all N Artifacts are materialized with independent `storageKey` paths |
| `CP-6` | Crash after the delete commit, before the unlink | The tombstone is authoritative with `currentArtifactId` null and no Review Note; the drain unlinks the file and appends `ARTIFACT_UNLINKED` |
| `CP-7` | Kill in the middle of a drain, then kill again during the retry | The drain is repeatable; `attempts` increases, ordering stays `createdAt`, and no intent is executed destructively twice |
| Disk full | `disk-full` mode during staging and during the rename | The operation fails with a recoverable error, no partial Artifact is ever marked materialized, and no committed Handoff is left without a repair path |
| Read-only Vault | `read-only` mode for the whole Vault | Mutations fail with recovery guidance, reads and `doctor` still work, and `vault.writable` reports blocking |
| Daemon restart mid-request, 0.2 | Stop the daemon while a multipart upload is in flight | The client sees a transport failure, the drain leaves no half-created Handoff, and a retry with the same `Idempotency-Key` produces exactly one Handoff |
| Concurrent Note and revise | Recipient `review set` and sender `revise` on the same Handoff with the same Row Version | Exactly one succeeds; the loser fails with `ROW_VERSION_CONFLICT` and the Handoff state is internally consistent, with no Note attached to a Revision that no longer exists |
| Concurrent revise and revise | Two senders revising the same Handoff with the same expected Row Version | Exactly one succeeds; the compare-and-set loser's transaction rolls back, its staged file becomes an orphan of the no-row class visible to `sorage vault verify`, and the `staging/` sweep removes it |

TASK-061 binds every non-crash-point row to a permanent automated home inside `make test`: the seven `CP` rows live in `packages/adapters/test/int/failure-injection.int.test.ts` from `TASK-035`; the disk-full rows run against a real 2 MB HFS ram disk filled to a two-block window in `packages/adapters/test/int/disk-full.int.test.ts`; the read-only-Vault row is `apps/cli/test/int/cli-readonly-vault.int.test.ts`; the daemon-restart row is `test/e2e/daemon-restart-midrequest.e2e.test.ts`, which kills a real daemon mid-upload and retries with the same `Idempotency-Key`; and both concurrent-writer rows race two real CLI processes in `apps/cli/test/int/cli-concurrent-writers.int.test.ts`.

## 5. Acceptance journeys

Journeys are numbered per milestone: AJ-01 to AJ-10 for 0.1, AJ-11 to AJ-13 for 0.2, and AJ-14 to AJ-16 for 0.3.

`Owner` names the Epic in [roadmap.md](roadmap.md) that delivers the capability the journey accepts; every journey is verified at the release gate of the milestone block it is numbered in, and every 0.1 journey is executed through the CLI surface completed in `EPIC-006`.

### AJ-01: Fresh non-interactive initialization and doctor

- **Owner:** `EPIC-002` · **Milestone:** 0.1
- **Requirements:** INIT-001, INIT-003, INIT-005, INIT-006, INIT-014, INIT-015, INIT-017, CFG-020, VLT-002, VLT-024, GEN-010

1. Start with an empty temporary `SORAGE_HOME` and no ecosystem tool installed.
2. Run `sorage init` fully non-interactively with explicit flags.
3. Verify `config.yaml`, the operational database, the Vault marker, and the directory layout, and confirm that Vault initialization wrote `.gitattributes` with `artifacts/** -text -diff`, `snapshots/** text eol=lf`, and `.sorage-vault.json text eol=lf`, and `.gitignore` with `staging/`, at milestone 0.1 (VLT-024).
4. Verify `sorage config show --json` returns exactly the schema defaults.
5. Run `sorage init` again and confirm it is idempotent and destroys nothing.
6. Run `sorage doctor --json`.

Expected: every check is `ok`, the exit code is 0, and no check reports `blocking`.

### AJ-02: Pre-initialization guidance

- **Owner:** `EPIC-002` · **Milestone:** 0.1
- **Requirements:** INIT-011, INIT-012, INIT-014, INIT-017, CLI-002, CLI-004, CLI-016

1. Start with no installation.
2. Run `sorage project list`, then repeat with `--json`.
3. Run each of `init`, `help`, `version`, `completion`, and `doctor`.
4. Inspect every entry of the pre-initialization `sorage doctor --json` catalog.

Expected: the first two fail with `NOT_INITIALIZED`, the expected config path, and `sorage init` as the suggested next command, with JSON only on standard output; the five bootstrap commands run; the pre-initialization catalog holds the 0.1 check ids only, every installation-dependent check reports `blocking` with a message stating that Sorage is not initialized and `sorage init` as its recovery, only `config.schema` names the configuration file, and the exit code is therefore non-zero.

### AJ-03: Project registration, worktree resolution, nesting, and archiving

- **Owner:** `EPIC-003` · **Milestone:** 0.1
- **Requirements:** PRJ-003 to PRJ-009, PRJ-016 to PRJ-018, PRJ-021, PRJ-022

1. Register Projects A and B with `sorage project add`.
2. Resolve from A's root and from a child directory with `sorage project resolve`.
3. Run `git worktree add` on A's repository and resolve from inside the new worktree.
4. Add a second binding to A and confirm both resolve to A.
5. Attempt to bind a worktree path of A's already-bound repository.
6. Arrange one path matched by both a `git_repository` binding and a `directory` binding, and resolve from it.
7. Create an alias that `realpath` does not collapse (a bind mount or an APFS firmlink; the test kit provides a fixture) so that two bindings of the same kind match at the same depth, resolve from it, and run `sorage doctor --json`.
8. Register a nested Project inside A's tree and confirm the deepest binding wins, and that `--as <project-slug>` overrides it.
9. Unbind A's last binding and confirm the unbound flag in `project list` and `doctor`, and `PROJECT_UNBOUND` as a recipient.
10. Create existing inbox Handoffs for B, archive B, exercise `fetch`, `review set`, `review withdraw`, `accept`, and `decline` on them, attempt a new send to B, then unarchive B.

Expected: every worktree of A resolves to A; binding a worktree path of an already-bound repository fails with `BINDING_DUPLICATE`; the `git_repository` binding wins the precedence case; the aliased tie fails with `AMBIGUOUS_PROJECT` naming both Projects and `doctor` reports `bindings.ambiguous` as a warning; the nested case is deterministic; an archived Project rejects new Handoffs with `PROJECT_ARCHIVED` while keeping `fetch`, `review set`, `review withdraw`, `accept`, and `decline` on its existing inbox.

### AJ-04: Registered Handoff loop

- **Owner:** `EPIC-006` · **Milestone:** 0.1
- **Requirements:** HND-001 to HND-006, HND-010, HND-012, HND-014, HND-024, HND-025, REV-005 to REV-009, REV-013, LIFE-001 to LIFE-005, LIFE-017, CLI-010, CLI-013

1. From A: `sorage send --to b --title <t> --file <path> --json`.
2. Verify one Handoff UUID, `revision` 1, `rowVersion` 1, state `awaiting_recipient`, next actor recipient.
3. From B: `sorage inbox --json` lists it.
4. From B: `sorage get <id> --json` returns the representation without setting `firstFetchedAt` and without appending any event.
5. From A, the sender, `sorage fetch <id> --json` returns the Artifact and leaves `firstFetchedAt` null with no event; from B: `sorage fetch <id> --json` returns Artifact metadata and a local path; `firstFetchedAt` is set, `rowVersion` is still 1, and `ARTIFACT_FETCHED_FIRST_TIME` is appended; a second `fetch` appends nothing.
6. From B: `sorage review set <id> --text <note>` moves the Handoff to `changes_requested` with `rowVersion` 2.
7. From A: `sorage revise <id> --file <changed-path> --expected-row-version 2` returns `awaiting_recipient` with `revision` 2, `rowVersion` 3, and no Review Note, appending `HANDOFF_REVISED` and `REVIEW_NOTE_RESOLVED`.
8. From an unrelated Project C, run `sorage get <id>` and `sorage fetch <id>`.
9. From B: `sorage accept <id> --expected-revision 2 --expected-row-version 3` sets `accepted`, `acceptedRevision` 2, and `acceptedAt`.
10. Attempt `sorage revise <id> --file <other>` and `sorage review set <id> --text <t>`.

Expected: the Row Version the client holds is 1, then 2, then 3 at each successive mutation; `get` never records a fetch; the non-participant reads fail with `HANDOFF_NOT_FOUND` and exit 66, so the Handoff's existence is not disclosed; both terminal attempts fail with `HANDOFF_TERMINAL` and the stored Artifact bytes are unchanged.

### AJ-05: Unregistered sender, downgrade guard, and later registration

- **Owner:** `EPIC-003` · **Milestone:** 0.1
- **Requirements:** PRJ-013 to PRJ-015, PRJ-019, PRJ-020, HND-011, CLI-017

1. From a directory that is neither a binding nor inside one, send to B and confirm a stable `workspaceKey` identity.
2. From the same path, `sorage outbox --current-workspace` finds the Handoff.
3. B sets a Review Note; the same Workspace revises; B accepts.
4. With the repository `$HOME/projects/dolgorae` bound to a Project, run `cd "$HOME/projects"`, an ancestor of that binding's workspace root, and attempt a send.
5. From a nested independent git repository inside A's bound tree, which resolves to no Project, attempt a send.
6. Repeat the ancestor send with `--allow-unregistered`.
7. From inside any worktree of A's repository, send to B.
8. Register the original Workspace directory as Project W and list its outbox as W.

Expected: steps 4 and 5 fail with `SENDER_IDENTITY_DOWNGRADE`, because the working directory is an ancestor of a binding's workspace root in one case and contained in one while resolving to no Project in the other; step 6 succeeds; step 7 resolves to A and never downgrades; after step 8 Project W has sender authority over the earlier Handoffs while their recorded `senderKind` and `senderPathSnapshot` remain historically accurate.

### AJ-06: Fan-out independence

- **Owner:** `EPIC-005` · **Milestone:** 0.1
- **Requirements:** HND-006 to HND-009, HND-019, VLT-020

1. Send one source to B, C, and D in one command.
2. Verify three UUIDs, one Dispatch Group id, and three distinct `storageKey` values with identical initial SHA-256.
3. B and C request different changes; D accepts at Revision 1.
4. Revise B and C independently, then accept B and decline C.
5. Repeat the fan-out at 100 recipients as a scale variant and verify the group is complete.

Expected: no operation on one Handoff changes another; the 100-recipient group is all-or-nothing in the database even when a crash is injected between two renames, as in `CP-5`.

### AJ-07: Declined, withdrawn, Note withdrawal, no-change bound, and administrative removal

- **Owner:** `EPIC-005` · **Milestone:** 0.1
- **Requirements:** HND-021, HND-022, REV-015, REV-016, REV-017, LIFE-017, CLI-019

1. On H1, the recipient runs `sorage decline <id> --reason <text> --expected-row-version <n>`, then the sender attempts a revise.
2. On H2, never fetched and never reviewed, the sender runs `sorage withdraw <id>`; on H3, already fetched, the sender attempts the same; on H4, carrying a Review Note, the sender attempts the same.
3. On H5, never fetched, the recipient sets a Note and then withdraws it, and the sender then attempts `sorage withdraw <id>`.
4. On H5, the recipient sets a Note and then runs `sorage review withdraw <id>`.
5. On H6, the recipient sets a Note, the sender runs `sorage revise <id> --no-change --reason <text>`, the recipient sets a Note again, and the sender repeats the no-change resolution.
6. On H6, the sender then revises with changed content and repeats the no-change resolution once more.
7. On H7, in `awaiting_recipient` with no Review Note, the sender runs `sorage revise <id> --no-change --reason <text>`.
8. On H8, run `sorage review remove <id> --confirm`, then `sorage review remove <id> --as-user --confirm`.

Expected: H1 is `declined` and the revise fails with `HANDOFF_TERMINAL`; H2 is `withdrawn`, H3 fails with `HANDOFF_ALREADY_FETCHED`, and H4 fails with `REVIEW_NOTE_PRESENT`; the H5 withdraw of step 3 also fails with `HANDOFF_ALREADY_FETCHED`, because `reviewEngagedAt` was set by the first `review set` and is never cleared even though `firstFetchedAt` is still null; step 4 returns H5 to `awaiting_recipient` with Revision unchanged and `REVIEW_NOTE_WITHDRAWN`; the second consecutive no-change resolution fails with `NO_CHANGE_LIMIT` while the one after a content revision succeeds, proving `consecutiveNoChangeResolutions` resets; H7 fails with `NO_REVIEW_NOTE`, because a no-change resolution is valid only in `changes_requested`; H8 fails with `USER_CONTEXT_REQUIRED` without the flag and, with it, returns to `awaiting_recipient` with `REVIEW_NOTE_REMOVED` recorded as `actorKind = user`.

### AJ-08: Row Version conflict, idempotency replay, and crash recovery

- **Owner:** `EPIC-005` · **Milestone:** 0.1
- **Requirements:** HND-014, HND-015, HND-025, CLI-021, API-012, VLT-021, VLT-022, RUN-002, SEC-009

1. Load one Handoff in two clients, mutate with the first, then mutate with the stale second.
2. Run `sorage send --idempotency-key <uuid>` twice with an identical request.
3. Run it a third time with the same key and a different `--file`.
4. Run `sorage revise <id> --file <changed-path> --idempotency-key <uuid>` twice with an identical request, so the second call would otherwise fail on content or on Row Version.
5. For each crash point `CP-1` through `CP-7`, inject the fault, restart the process, let the drain run, and assert the matrix invariant of section 4.
6. After every injection, run `sorage doctor --json` and `sorage vault verify`.

Expected: step 1 fails with `ROW_VERSION_CONFLICT` and leaves the newer state untouched; step 2 creates exactly one Handoff and returns the original response on replay; step 3 fails with `IDEMPOTENCY_CONFLICT`; step 4 produces exactly one Revision and returns the original response rather than `NO_CONTENT_CHANGE` or `ROW_VERSION_CONFLICT`, because replay is evaluated first; every crash point recovers to its invariant with no fabricated file and no silently lost Handoff.

### AJ-09: Vault move with injected failure

- **Owner:** `EPIC-004` · **Milestone:** 0.1
- **Requirements:** CFG-013, CFG-014, RUN-014, VLT-019, SEC-014

1. Create several Handoffs, including one with a pending Review Note.
2. Run `sorage vault move --to <new-path> --as-user` with a copy failure injected part way through.
3. While `vault-move.lock` is held, attempt a domain mutation from a second CLI process, and from the API once the daemon exists.
4. Retry the move without the injected failure.
5. Verify checksums, the marker, and `vault.path` at the new location, and run `sorage doctor`.

Expected: the failed move leaves the original Vault active and the configuration unchanged, with no `VAULT_MOVED` event; the concurrent mutation fails with `SERVICE_PAUSED` and recovery guidance; the retried move preserves every checksum and the marker's `installationId`.

### AJ-10: Two-phase deletion with the Git warning

- **Owner:** `EPIC-005` · **Milestone:** 0.1
- **Requirements:** LIFE-010 to LIFE-018, VLT-021, SEC-012, CLI-019

1. A Project requests deletion of one of its Handoffs while it is still in `awaiting_recipient`.
2. The User attempts `delete approve` on that non-terminal Handoff.
3. The User rejects the request instead, and the Handoff is retained with the decision recorded.
4. The recipient accepts the Handoff, the Project requests deletion again, and a non-User actor attempts the approval.
5. Corrupt the terminal Handoff's current Artifact, attempt approval, confirm `ARTIFACT_CORRUPTED` leaves the Handoff and request unchanged, then restore the original bytes.
6. The User pins the Handoff and approves without the pinned confirmation.
7. The User approves with `--as-user --confirm --confirm-pinned <id>`.
8. Against the resulting tombstone, attempt `fetch`, `revise`, `review set`, `accept`, and a further `delete request`, then run `get`, a listing with `--include-deleted`, `pin`, and `archive`.
9. Inspect the confirmation text, the tombstone, the Vault, and the ledger.

Expected: step 2 fails with `HANDOFF_NOT_TERMINAL`, so a deletion request may be filed in any non-deleted state while approval requires a terminal one and every tombstone is therefore terminal (LIFE-018); step 3 records `DELETION_REJECTED`; step 4 fails with `USER_CONTEXT_REQUIRED`; step 5 fails with `ARTIFACT_CORRUPTED` and makes no deletion claim; step 6 fails with `PINNED_DELETE_CONFIRMATION`; step 7 sets `deletedAt`, detaches `currentArtifactId`, removes the current Artifact row and Review Note, unlinks the file through the intent, and appends `DELETION_APPROVED` then `ARTIFACT_UNLINKED`; every content operation in step 8 fails with `HANDOFF_DELETED` while `get`, listing, pin, and archive succeed; the confirmation names title, UUID, recipient, and pin status, and states that prior Git commits may retain earlier content rather than claiming a purge (LIFE-015).

### AJ-11: Daemon lifecycle

- **Owner:** `EPIC-007` · **Milestone:** 0.2
- **Requirements:** RUN-005, RUN-006, RUN-008, RUN-013, SEC-015

1. Run `sorage daemon start`, then `sorage daemon status`.
2. Inspect `~/.sorage/run/daemon.json` for `pid`, `host`, `port`, `startedAt`, `version`, and `installationId`, and confirm it was written atomically at bind.
3. Confirm the CLI discovers the daemon through that file and verifies `installationId` through `GET /api/v1/health`.
4. Start a second daemon on the same port.
5. Stop the daemon during an in-flight request, then start it again with a `daemon.lock` whose pid is dead.
6. Change the port and confirm the change requires a controlled restart.
7. With an unrelated process holding the configured port, run `sorage doctor --json`.

Expected: step 4 fails with `PORT_IN_USE`; the stop drains and refuses new mutations before storage shutdown; the stale lock is broken by the next start; `daemon.json` never survives a clean stop; `daemon.port` reports `warning` with the recovery that names `server.port`.

### AJ-12: Web session and the local network boundary

- **Owner:** `EPIC-007` · **Milestone:** 0.2
- **Requirements:** RUN-012, SEC-017, SEC-018, SEC-019, SEC-020, SEC-001

1. With no daemon running, run `sorage web`; it starts the daemon and opens the browser at a URL whose fragment carries a one-time secret.
2. Observe the SPA exchange the secret at `POST /api/v1/session`, store the session token in `sessionStorage`, and clear the fragment.
3. Replay the same one-time secret.
4. Navigate directly to the application root with no fragment and an empty `sessionStorage`.
5. Issue `GET /api/v1/handoffs` with `Host: attacker.example`, and again with each allowlisted Host value.
6. Issue a cross-origin request from another origin, and a request with no `Authorization` header.
7. Inspect every response, including errors and static assets.
8. Rotate the token with `sorage token rotate --as-user` while the browser session is open.

Expected: the replayed secret is refused with `UNAUTHENTICATED` and HTTP 401; direct navigation renders a refusal and fetches nothing; the mismatched Host is rejected with `HOST_NOT_ALLOWED` and HTTP 421 before routing and before authentication, while all three allowlisted values are accepted; the cross-origin request fails and the request with no `Authorization` header returns `UNAUTHENTICATED`; the session invalidated by the rotation returns `TOKEN_INVALID` with HTTP 401 on its next request; every response carries the CSP, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`, and no response sets a cookie.

### AJ-13: Web administration

- **Owner:** `EPIC-007` · **Milestone:** 0.2
- **Requirements:** WEB-002 to WEB-015, WEB-017, API-003, API-005, CFG-019, LIFE-012

1. Open the dashboard and verify counts for awaiting recipient, changes requested, accepted, declined, withdrawn, pinned, archived, deleted, deletion requested, and recent updates; the backup health card appears once Git backup exists at 0.3.
2. Upload one document to three recipient Projects and verify three UUIDs and three independent Handoffs.
3. Preview a Markdown Artifact and an unsupported binary one.
4. Write a User proxy Review Note and confirm it records `authorKind = user`.
5. Revise through upload, then accept.
6. Pin and archive a terminal Handoff, then unarchive it.
7. Request a deletion, reject it, request it again, and approve it for a pinned Handoff.
8. Edit typed settings and save; confirm the YAML view is read-only.
9. Save a stale configuration copy after a CLI write.

Expected: the counts match the database; the binary Artifact offers metadata plus download without inline rendering; the pinned approval requires the distinct confirmation that `--confirm-pinned <id>` expresses on the CLI and otherwise fails with `PINNED_DELETE_CONFIRMATION`; the stale save fails with `CONFIG_CONFLICT` against the content-hash ETag and overwrites nothing.

### AJ-14: Daily Git backup

- **Owner:** `EPIC-008` · **Milestone:** 0.3
- **Requirements:** BKP-002 to BKP-006, BKP-009 to BKP-016, BKP-022 to BKP-026

1. Initialize a Vault Git repository and run `sorage backup enable --daily-at <HH:MM> --timezone <zone> --as-user`.
2. Drive the fake clock over a spring-forward day on which the scheduled local time does not exist, and over a fall-back day on which it occurs twice.
3. Drive the clock across a simulated sleep gap that spans the due time and restart the daemon.
4. Run `sorage backup run`, which needs no `--as-user`, and verify the snapshots, `snapshots/events.jsonl`, the commit, and `sorage backup status`.
5. Run it again with nothing changed.
6. Enable push to the bare-remote fixture, commit and push a divergent change from the second clone, then run the backup again.
7. Point push at a remote that demands interactive credentials.
8. Run `sorage backup verify`.

Expected: the nonexistent local time runs at the next valid instant and the repeated one at its first occurrence; the missed run is caught up once after startup; the second run makes no commit because `git diff --cached --quiet` reports no change; the divergent remote produces `GIT_BACKUP_CONFLICT` with no force, rebase, or merge attempted; the credential-demanding remote produces `GIT_AUTH_REQUIRED` inside the 60-second timeout instead of hanging; `backup verify` confirms `.gitattributes` and `core.autocrlf=false`.

### AJ-15: Clean restore drill

- **Owner:** `EPIC-008` · **Milestone:** 0.3
- **Requirements:** BKP-021, BKP-022, BKP-023, VLT-019, SEC-014, PRJ-014, PRJ-020

1. Produce a backup containing Projects, Handoffs at every review state, Review Notes, tombstones, and an unregistered-Workspace Handoff.
2. Clone the backup repository into a clean environment configured with `core.autocrlf=true`.
3. Compare every text Artifact byte for byte against the source.
4. Run `sorage backup restore --from <clone> --dry-run --as-user` in an empty installation.
5. Run it for real, then run it again against the now-populated installation.
6. Verify UUIDs, Revisions, Row Versions, review states, Review Notes, tombstones, and every checksum.
7. Confirm `installationId` was adopted from the Vault marker, resolve the unregistered outbox from its original path, and re-bind the Projects with `sorage project bind`.
8. Run `sorage doctor --json`.

Expected: the `core.autocrlf=true` clone leaves every Artifact byte-identical, proving `.gitattributes`; the dry run reports the plan and changes nothing; the real run restores the state, verifies every checksum, regenerates only the API token, and appends `VAULT_ADOPTED` and `RESTORE_COMPLETED`; the second run fails with `RESTORE_TARGET_NOT_EMPTY`; the unregistered outbox resolves because `workspaceKey` derives from the preserved `installationId`; `doctor` reports no blocking check.

### AJ-16: Packaging on a clean macOS account

- **Owner:** `EPIC-009` · **Milestone:** 0.3
- **Requirements:** GEN-002, INIT-016, RUN-007, RUN-011, NFR-012, NFR-013

1. On a freshly created macOS user account, install from the Homebrew tap.
2. Run `sorage version` and `sorage init` non-interactively, then `sorage doctor`.
3. Install the LaunchAgent, log out and back in, confirm the daemon is running and reachable, and confirm its record, health response, and version response report the same product version as `sorage version`.
4. Run every earlier journey that does not require a developer checkout.
5. Run `sorage uninstall --as-user --confirm`.
6. Inspect the account afterwards.

Expected: Gatekeeper does not quarantine the installed binary; the CLI and daemon report the package manifest's product version; the LaunchAgent bootstraps into `gui/$UID` and boots out cleanly; uninstall removes the LaunchAgent, `state`, `run`, `logs`, and `config.yaml`, leaves the Vault untouched, and prints the retained Vault path.

## 6. Success-criteria map

Charter criteria are cited by meaning as well as by number, because [product-charter.md](product-charter.md) restates them in v0.4.0 vocabulary; a criterion added or renumbered there MUST gain a row here in the same change.

| Charter criterion | Milestone | Journey |
|---|---|---|
| 1. A fresh macOS installation is initialized without manual file creation | 0.1 | AJ-01, AJ-16 |
| 2. A registered Project sends a document to another registered Project | 0.1 | AJ-04 |
| 3. The recipient discovers it through `inbox` | 0.1 | AJ-04, AJ-06 |
| 4. A single Review Note is created and atomically resolved by a revision | 0.1 | AJ-04 |
| 5. An accepted Revision cannot be silently changed | 0.1 | AJ-04, AJ-07 |
| 6. Several recipients produce independent Handoffs | 0.1 | AJ-06 |
| 7. Unregistered Workspaces send and resolve their own outbox | 0.1 | AJ-05, AJ-15 |
| 8. The Web dashboard shows every review state and retention class accurately | 0.2 | AJ-13 |
| 9. Configuration is inspected and safely edited through CLI and Web | 0.2 | AJ-01, AJ-13 |
| 10. A scheduled Git backup completes, reports status, and fails safely | 0.3 | AJ-14 |
| 11. No manual copy or move is needed in the normal workflow | 0.1 | AJ-04, AJ-06 |
| 12. Every MVP acceptance journey passes on a clean macOS user account | 0.3 | AJ-16 |
| 13. Sorage builds and tests from its own standalone repository root through `make test` | 0.1 | Section 1 `make` targets, AJ-16 |
| 14. The `use-sorage` skill closes the discovery loop | 0.1 | `TASK-039` skill validation, AJ-04, AJ-07 |
| 15. Every user-facing and machine-facing identifier uses the canonical naming system | 0.1 | AJ-02, section 3.3 contract snapshots |
| 16. A git worktree of a registered repository sends and receives as that Project | 0.1 | AJ-03 |
| 17. Declined and withdrawn Handoffs are terminal, reject content operations, and remain visible | 0.1 | AJ-07 |
| 18. Restore into a clean account reproduces every recorded checksum | 0.3 | AJ-15 |

The remaining journeys carry the v0.4.0 decisions that have no v0.3.0 criterion, and each is a release-gate condition in its own right.

| Journey | What it accepts |
|---|---|
| AJ-03 | Worktree-aware identity, many bindings per Project, and nested resolution (ADR-0015) |
| AJ-07 | Every reachable state has a next move without a human, through decline, withdraw, Note withdrawal, and the bounded no-change resolution (ADR-0014) |
| AJ-08 | The intent-log protocol survives all seven crash points, and retries are idempotent (ADR-0013) |
| AJ-09 | Vault relocation is atomic in effect and pauses the service instead of racing it |
| AJ-10 | Deletion stays two-phase, requires a terminal review state, and never overstates what it removed |
| AJ-11 | Daemon discovery, port conflict, and graceful drain |
| AJ-12 | The local network boundary and the cookie-free browser session (ADR-0017) |
| AJ-15 | The backup is actually restorable, byte for byte, on a machine that never held the original |

## 7. Scale checks and measurement

| Dimension | Size |
|---|---|
| Handoffs | 10,000 |
| Projects and Workspaces combined | 1,000 |
| Handoffs in one inbox | 1,000 |
| Artifact sizes | 0 bytes, one byte, `artifact.maxBytes`, and `artifact.maxBytes` plus one |
| Independent Handoffs in one Dispatch Group | 100 |
| Events in the ledger | The full history produced by the seeded corpus, exported to `snapshots/events.jsonl` |

Targets, from NFR-004:

- A typical Handoff detail read completes in under 250 ms.
- The first page of an inbox or outbox listing completes in under 500 ms.
- Artifact import, download, and snapshot export stream with bounded memory (NFR-005).
- Standard inbox and outbox filters use an index, asserted with `EXPLAIN QUERY PLAN` rather than by timing alone.

Measurement method: the corpus is built by the `testkit` seed generator with the fake `IdGenerator` and fake `Clock`, so it is byte-identical between runs; each measurement discards one warm-up run and reports the median and the 95th percentile of twenty runs; the test report records the hardware baseline as machine model, CPU, memory, disk type, filesystem, macOS version, and Bun version, because a target in milliseconds is meaningless without it.

An `EXPLAIN QUERY PLAN` result that shows a full table scan on a standard listing is a P2 defect regardless of the measured time; a missed millisecond target on recorded hardware is a P2 defect and does not by itself block a gate, because NFR-004 is a SHOULD while correctness is not.

TASK-062 records the baseline the numbers were measured on and keeps the proof executable: `packages/adapters/test/int/scale-checks.int.test.ts` loads the 10,000-Handoff seed, pins every inbox, outbox, and detail query to an index through `EXPLAIN QUERY PLAN` (`SEARCH ... USING INDEX idx_handoffs_inbox` and its siblings, with no `SCAN` anywhere), and asserts the budgets with one discarded warm-up and the median of twenty runs. The baseline for the committed numbers: MacBook Pro, Apple M5 Pro, 64 GB memory, macOS 26.5.2, APFS `/var/folders` temporary storage, Bun 1.3.14 toolchain with the suite executed through `make test-int`; the observed medians were 0.02 ms for the inbox first page, 0.52 ms for the workspace outbox first page, and 0.02 ms for a detail read, three orders of magnitude inside the budgets, and the exhaustive pagination proof over the whole seed lives in `packages/adapters/test/int/handoff-read.int.test.ts`.

## 8. Security checks

Section 15 of [security-reliability.md](security-reliability.md) is the normative list of security checks, and every numbered row there is a release-gate condition of the milestone that introduces its subject.

The Host allowlist, session exchange, response headers and cookie absence run inside AJ-12; SVG and HTML handling and the mid-stream size abort run inside AJ-13; `--as-user` gating and the non-participant read run inside AJ-07, AJ-10, and AJ-04, so a regression fails a journey rather than only a checklist.

TASK-060 additionally binds every row of the section 15 matrix to a permanent automated home inside `make test`, so removing a control fails its row's test rather than only a journey:

| Rows | Permanent automated home |
|---|---|
| 1 | `apps/daemon/test/unit/server.unit.test.ts` (non-loopback bind refused) |
| 2, 3, 8, 9 | `apps/daemon/test/int/server.int.test.ts` (Host allowlist, cross-origin posture, security headers) |
| 4, 6, 7 | `apps/daemon/test/int/auth.int.test.ts` with `apps/daemon/test/contract/auth.contract.test.ts` |
| 5 | `apps/daemon/test/int/auth.int.test.ts` for the `TOKEN_INVALID` rejection and rotation, with `apps/cli/test/int/cli-token-retry.int.test.ts` deterministically proving the CLI's routed read retries exactly once after a rotation while the write never retries, and `test/e2e/daemon-config.e2e.test.ts` proving the surface against the compiled binary (TASK-070) |
| 10, 11 | `apps/daemon/test/int/domain-routes.int.test.ts` (hostile content types never render inline) |
| 12 | `apps/daemon/test/int/upload.int.test.ts` |
| 13, 14 | `packages/adapters/test/int/import-safety.int.test.ts` |
| 15, 20 | `apps/cli/test/int/cli-security-matrix.int.test.ts` |
| 16 | `apps/cli/test/int/cli-user-admin-matrix.int.test.ts` |
| 17, 19, 23 | `apps/cli/test/int/cli-retention.int.test.ts` |
| 18 | `apps/cli/test/int/cli-read.int.test.ts` |
| 21 | `packages/adapters/test/int/token-store.int.test.ts` |
| 22 | `test/e2e/backup-web.e2e.test.ts` with the AJ-14 journey |

## 9. Release gates

Each milestone closes with its own gate, and a gate passes only when every condition below holds; the MVP is complete only at the 0.3 gate (GEN-013).

### 9.1 Gate 0.1, CLI release, end of `EPIC-006`

- AJ-01 to AJ-10 pass against the compiled binary on a clean temporary `SORAGE_HOME`.
- `make test` is green, including the `test-prepare` lint rules for the import boundary and for `await` inside `UnitOfWork.run`.
- Every requirement listed under milestone 0.1 in section 17 of [required-specification.md](required-specification.md) is satisfied.
- The crash-point and failure matrix of section 4 passes for every 0.1 row.
- `sorage doctor` reports no `blocking` check on a fresh installation, and the catalog matches its contract snapshot.
- CLI JSON snapshots are approved under section 9.4.
- `skills/use-sorage/SKILL.md` ships and states the inbox policy of GEN-014.
- No open P0 or P1 defect.

### 9.2 Gate 0.2, daemon and Web release, end of `EPIC-007`

- AJ-11 to AJ-13 pass, and AJ-01 to AJ-10 still pass unchanged.
- Every requirement listed under milestone 0.2 is satisfied.
- Every security check in section 15 of [security-reliability.md](security-reliability.md) passes.
- The symbolic-error to HTTP-status matrix is contract-tested (API-011).
- The axe-core check runs in `make test-e2e` and its findings are recorded; it is engineering practice, not a gate condition (WEB-018).
- HTTP DTO and error-body snapshots are approved under section 9.4.
- No open P0 or P1 defect.

### 9.3 Gate 0.3, MVP release, end of `EPIC-009`

- AJ-14 to AJ-16 pass, and every earlier journey still passes.
- Every requirement listed under milestone 0.3 is satisfied, and every deferred item is deferred by an accepted decision.
- Migration from the captured first-schema fixture passes.
- The restore drill produces byte-identical Artifacts on a machine that never held the originals.
- A clean macOS user account completes install, LaunchAgent lifecycle, and uninstall with the Vault retained.
- Scale checks are measured and recorded with the hardware baseline of section 7.
- Documentation matches implementation, and `doctor` reports no blocking check.
- No open P0 or P1 defect.

### 9.4 JSON snapshot approval

Snapshots cover CLI `--json` envelopes, HTTP DTOs, error bodies, exit-code categories, and the `doctor` check catalog; they are versioned contracts, not incidental output (NFR-003, INIT-017).

Every snapshot diff is classified in the task report as breaking or non-breaking before the gate is evaluated.

| Classification | Examples |
|---|---|
| Non-breaking | An added optional field, an added member of an open enumeration, a changed human-readable message, a reordered array whose order is documented as unspecified |
| Breaking | A removed or renamed field, a changed type or nullability, a changed symbolic error code, a changed exit-code category, a removed or renamed `doctor` check id, a removed or renamed event type |

The reviewer session that confirms the acceptance gate approves the diff, as defined in section 9 of [sot-governance.md](sot-governance.md); an unclassified diff blocks the gate, and a breaking diff additionally requires an accepted architecture decision or a specification amendment before the gate can pass.

## 10. Defect severity

| Severity | Definition | Examples |
|---|---|---|
| P0 | Data loss, unauthorized remote exposure, deletion without approval, or unrecoverable corruption | Artifact bytes differ after a restore; a Handoff readable by a rebinding page; garbage collection removing a referenced Artifact |
| P1 | Core workflow blocked, wrong recipient, broken revision semantics, unsafe Git action, or a stale write accepted | Wrong recipient caused by an identity downgrade; a Review Note surviving a revision; a force push; a mutation accepted against a stale Row Version |
| P2 | Significant feature defect with a workaround | A missed NFR-004 target on recorded hardware; a full table scan on a standard listing; a misreported `doctor` severity |
| P3 | Minor behavior, usability, or presentation defect | Wording, ordering, or formatting that misleads without changing an outcome |

P0 and P1 block every release gate.
