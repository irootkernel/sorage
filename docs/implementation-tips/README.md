# Implementation Guide

## 1. Status

This document is guidance. Normative requirements and accepted decisions take precedence.

## 2. TypeScript and toolchain

Required TypeScript posture:

- Strict mode
- No implicit `any`
- Explicit public return types
- Exhaustive discriminated-union handling
- Runtime validation at every process and persistence boundary
- Locked dependencies and a pinned runtime toolchain

TypeScript types do not replace runtime validation.

The toolchain is fixed by ADR-0016 and is not a per-Task choice:

- Bun `1.4.2`, pinned in `.bun-version` at the repository root and mirrored in the `engines` field of `package.json`; `make test-prepare` asserts both and fails the build on a mismatch (NFR-017). The shipped product version has one runtime source in `packages/core/src/version.ts`; the same preparation gate rejects a workspace manifest or internal dependency declaration that drifts from it, and CLI, daemon, and packaging code consume that source directly (NFR-003, NFR-012).
- `bun:sqlite` as the only SQLite driver; it is synchronous, which is what makes the synchronous `UnitOfWork` natural.
- Vitest executed through Bun for unit, integration, and contract tests; Playwright for Web end-to-end from milestone M2.
- `commander` as the single source of the CLI surface, so help text, JSON output, and shell completion stay in agreement.
- The `yaml` package used through its Document API rather than `parse`/`stringify`, because only the document tree preserves existing comments and key order across a write (CFG-018).
- The Web control plane ships as a no-build static SPA served by the daemon under `apps/daemon/src/web-app.ts`: one HTML document, one external script, and one external stylesheet, all CSP-safe by construction. A Vite and Preact build remains a candidate if the SPA outgrows this shape; the required behavior (WEB-001 to WEB-018) is framework-independent.
- `bun build --compile` for release binaries, followed by ad-hoc codesigning and architecture-specific GitHub Release assets. `make package` compiles twice into scratch outputs that keep the exact `sorage` basename - the compiled binary embeds its own name, so the reproducibility probe must compare like with like - and fails on any digest mismatch. It signs `dist/sorage`, verifies that exact staged copy, and publishes the same signed bytes as `dist/sorage-v0.1.0-darwin-arm64` with a two-space checksum file and a manifest carrying the version, HEAD revision, target, asset basename, signed digest, reproducible unsigned digest, and signature mode. `make test-e2e` prepares the package and always runs AJ-16 against the versioned candidate through a clean isolated account; missing artifacts fail the test; a bare `make build` removes all three candidate files so unsigned output cannot retain stale release metadata.
- `make test` as the single verification gate, over the targets `test-prepare`, `test-unit`, `test-int`, `test-contract`, and `test-e2e`, in order even under `make -j`, stopping on the first failed stage; `test-e2e` prepares the package before running every journey. `make build` compiles `dist/sorage` and `make package` produces the signed source-install binary and GitHub Release candidates (NFR-016).
- Record shipped outcomes in the root [CHANGELOG.md](../../CHANGELOG.md). Keep the next planned version under `Unreleased` until that version is published; do not treat the changelog as a second status authority.
- Verification is local: the same `make` targets a developer runs are the whole gate, because this repository uses no hosted continuous-integration service.

Bun does not use libuv, so `F_FULLFSYNC` durability MUST be verified empirically in the foundation milestone rather than assumed.

The workspace is five packages, and the import rules are lint-enforced inside `make test-prepare` (NFR-014):

| Package | Contents | May import |
|---|---|---|
| `core` | Domain model, application use cases, versioned protocol DTOs | Nothing in this repository |
| `adapters` | SQLite, filesystem, git, macOS, HTTP, and `testkit` implementations of `core` ports | `core` |
| `cli` | `apps/cli`, argument parsing, output rendering, process wiring | `core`, `adapters` |
| `daemon` | `apps/daemon`, HTTP server, scheduler, garbage collection | `core`, `adapters` |
| `web` | `apps/web`, the Preact SPA | Protocol DTOs from `core` only |

The `apps/*` import rule is narrower than the table alone suggests: an app imports `core` application use cases and protocol DTOs and composes adapters at its entry point, and it never imports domain internals.

Database rows never leave `adapters`, and no package imports an ecosystem tool at build time or at run time (GEN-009, GEN-010).

## 3. Domain modeling

Prefer:

- Dedicated types for Project ID, Handoff ID, Artifact ID, Revision, and Row Version
- Discriminated unions for actor identity over `registered_project`, `unregistered_workspace`, `user`, and `system`
- Pure permission and transition functions
- Explicit command objects for use cases
- Explicit domain errors carrying symbolic codes
- Injected `Clock` and `IdGenerator`

Avoid:

- Boolean combinations representing invalid state
- Adapter exceptions escaping into the domain
- Public methods that partially apply a workflow
- SQL in HTTP handlers
- Filesystem operations in domain functions

## 4. Error handling

Use one internal error model:

```typescript
type AppError = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};
```

Map once into HTTP status, protocol error, CLI exit code, log level, and recovery hint, and never branch on human-readable error text.

The mapping from symbolic code to HTTP status is published in `../specs/interfaces-and-operations.md` and is verified by `make test-contract` (API-011).

## 5. Transactions

`UnitOfWork.run` is synchronous, and its callback contains no `await`:

```typescript
interface UnitOfWork {
  run<T>(fn: (tx: Tx) => T): T;
}

const result = unitOfWork.run((tx) => {
  const aggregate = handoffRepository.getForMutation(tx, id);
  aggregate.assertRowVersion(expectedRowVersion);
  const outcome = domainOperation(aggregate, command);
  handoffRepository.save(tx, outcome.aggregate);
  eventRepository.append(tx, outcome.events);
  return outcome.response;
});
```

Every candidate SQLite driver is synchronous, so an awaited callback would suspend mid-transaction and let statements from a second logical transaction interleave on the same connection; a lint rule forbids `await` inside the callback.

Filesystem I/O never happens inside a transaction: staging, hashing, and verification run before it, and renames and unlinks run after it.

Multi-step work uses the intent log, in four phases that never change order:

```typescript
// 1. Stage outside any transaction: copy, hash, size-check, fsync each staged file.
const staged = artifactStore.stage(sourcePath, stagingDir);

// 2. One transaction: domain change + intents + events, committed together.
const committed = unitOfWork.run((tx) => {
  const outcome = createHandoffs(tx, command, staged);   // artifacts written with materialized = 0
  intentLog.append(tx, outcome.intents);                 // one 'activate' per staged file
  eventRepository.append(tx, outcome.events);            // HANDOFF_CREATED
  return outcome;
});

// 3. Execute the committed intents: rename to storageKey, then fsync the parent directory.
artifactStore.execute(committed.intents);

// 4. One short transaction: mark materialized, delete the executed intents, append events.
unitOfWork.run((tx) => {
  artifactRepository.markMaterialized(tx, committed.artifactIds);
  intentLog.clear(tx, committed.intents);
  eventRepository.append(tx, activationEvents(committed));  // ARTIFACT_ACTIVATED
});
```

A crash between any two phases is recoverable, because phase 2 committed the intention before phase 3 acted on it; the drain at the next process start finishes the work idempotently.

Revise and deletion approval use the same shape, adding an `unlink` intent for the superseded path; the new Artifact always gets a new `artifact-id` segment, so nothing is ever overwritten in place.

## 6. Row Version

- Starts at 1.
- Increments exactly once per successful state-changing Handoff operation.
- Never increments on a read, on `fetch`, on preview, or on the events those produce (HND-025).
- An expected Row Version is the value the client currently holds, not the value it expects afterwards.
- Every mutation returns the new current value.
- It is enforced whenever an expected value is supplied, and it is always required for `accept` and `decline` (HND-014).
- A stale semantic mutation fails with `ROW_VERSION_CONFLICT` and is never silently retried.

The check and the write are one statement, and the driver's affected-row count is the verdict:

```sql
UPDATE handoffs SET rowVersion = rowVersion + 1, reviewState = ? WHERE id = ? AND rowVersion = ?;
```

The application asserts `changes === 1`; any other value means another writer moved the row first.

## 7. Revision

- Starts at 1.
- Increments only when the current Artifact hash changes.
- The same hash returns `NO_CONTENT_CHANGE` unless the caller invoked `revise --no-change --reason <text>`.
- A no-change resolution clears the Review Note and returns the Handoff to `awaiting_recipient` without changing Revision (REV-017); it is valid only from `changes_requested`, and anywhere else it fails with `NO_REVIEW_NOTE`.
- At most one no-change resolution may occur consecutively; the counter `consecutiveNoChangeResolutions` resets to 0 on a content revision, and a second consecutive attempt fails with `NO_CHANGE_LIMIT`.
- Note, pin, archive, and deletion request never change it.
- Accept records the exact current Revision in `acceptedRevision`.

## 8. Database

- Use repository interfaces; SQL lives only in `adapters`.
- Keep migrations immutable after merge, tracked in `schema_migrations`.
- Run migration at process start under `~/.sorage/run/migration.lock`, which is stale only when its recorded pid is dead.
- Open exactly one write connection per process, in WAL mode, with foreign keys enabled and an explicit `busy_timeout`, so concurrent writers queue instead of failing immediately.
- Add indexes from query requirements rather than speculatively.
- Store timestamps in UTC.
- Append events inside the same transaction as the mutation that caused them.
- Take local database snapshots with `VACUUM INTO` under `~/.sorage/state/backups/`, never by copying the live file with its WAL and SHM.
- Test the upgrade from the previous fixture; capture that fixture when the migration is written, not when the upgrade test is written.
- Do not store the API token in the database while the token file is the authority.

The finalized upgrade policy of TASK-063 covers all three versioned surfaces. The database replays the immutable migration history over the captured first-schema fixture with real v1 data and loses nothing; a failing step rolls back to the previous valid schema and start-up surfaces the thrown failure rather than serving a half-migrated database, proved in `packages/adapters/test/int/upgrade-fixture.int.test.ts`. The configuration carries `schemaVersion: 1` as its only released schema: a configuration written by an older schemaVersion would be migrated in place through the atomic store's rewrite, which retains the single `.bak` of the previous valid file, and because no schema older than 1 ever shipped the mechanism is exactly the validated rewrite path that the configuration store suite already proves byte for byte. The Vault marker never migrates: a marker whose `schemaVersion` is newer than the build fails with `VAULT_SCHEMA_UNSUPPORTED` at exit 78 and a downgrade is refused rather than attempted, because a Vault written by a newer build may contain meanings this build would silently corrupt.

## 9. Files

- Stream copies and hash while copying.
- Use unique staging names under `<Vault>/staging/<uuid>`.
- Treat `storageKey` as the sole authority for an Artifact's location, and never reconstruct a path from a Handoff id plus a file name; the `<artifact-id>` segment is what keeps two Revisions of the same file name apart.
- Sanitize stored names without changing the recorded original name.
- Follow the durability order exactly: write, `fsync(file)`, rename, `fsync(parent directory)`, then the commit that sets `materialized = 1` (VLT-022).
- Use a same-filesystem rename for activation, which is why staging lives inside the Vault.
- Mark final files read-only after import, and re-apply that mode on restore, because git does not preserve it.
- Verify path ownership against `storageKey` and the pending intents before any delete.
- Never recursively delete a path derived only from user input.

## 10. Config Service

Owns:

- Parsing through the `yaml` Document API, preserving comments and key order on every Sorage-mediated write (CFG-018)
- Schema validation against `../specs/schemas/config.schema.json`, with every declared default applied (CFG-020)
- Semantic validation
- `configRevision` maintenance
- Atomic persistence under `~/.sorage/run/config.lock`, held with `O_EXCL` and stale after 30 seconds or a dead pid
- Reload impact, including which fields require a daemon restart
- Redacted representation
- The ETag, computed as a content hash of the canonical file rather than from `configRevision`, because a manual edit does not bump the counter (CFG-019)

While the daemon is running it is the only Sorage writer of `config.yaml`, so every CLI write calls `PUT /api/v1/config` with `If-Match`. The CLI writes the file directly only when no daemon is running, and always under the lock; `POST /api/v1/runtime/reload` remains available for adopting an out-of-band manual edit.

An invalid change leaves the previous valid configuration active, and the single `.bak` copy is replaced only after the new content passes full validation.

## 11. HTTP handlers

Handlers, in order:

1. Validate the `Host` header against the allowlist, before routing and before anything else (SEC-017).
2. Authenticate the bearer token in constant time, whether it is the CLI token or a browser session token (SEC-003, SEC-020).
3. Replay the idempotency key when the endpoint accepts one, before the Row Version check and before the use case runs (API-012).
4. Validate transport input.
5. Build the actor context.
6. Call exactly one application use case.
7. Map the result to a protocol DTO.
8. Map errors through shared middleware, which also sets `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on every response (SEC-018).

Handlers contain no domain transitions and no SQL.

## 12. CLI

- Deterministic output, with no progress text on standard output in JSON mode.
- Warnings and human diagnostics on standard error.
- Full identifiers in JSON.
- Explicit flags over positional ambiguity, and no inference of a recipient from history.
- `--as <project-slug>` overrides working-directory resolution for a Project that has a binding, and `--as-user` selects User-admin context and records `actorKind = user`; a User-admin command invoked without it fails with `USER_CONTEXT_REQUIRED` (CLI-019, CLI-020).
- Call application use cases directly, in-process; the daemon is contacted only by `web` and `daemon` commands, where `DAEMON_UNAVAILABLE` is meaningful (RUN-003). A shipped app process reaches the adapters only through the command-port and infrastructure modules of the import-boundary allowlist, never the adapters index or a storage implementation module (CLI-018).
- Drain `pending_fs_ops` at process start, before executing the requested command (RUN-002).
- Implement `inbox --wait` as a poll of SQLite every `--interval` seconds, defaulting to 2, until a new inbox item appears for the resolved actor or `--timeout` seconds, defaulting to 300, elapse; a timeout exits 0 with an empty list and `meta.timedOut: true`.
- Require interactive confirmation or an explicit confirmation flag for destructive User operations, and treat `--confirm-pinned <id>` as a second, distinct confirmation that a blanket `--confirm` cannot satisfy.

## 13. Web

- Shared protocol DTOs, never database types.
- No cookies anywhere: the SPA reads the one-time secret from the URL fragment, exchanges it at `POST /api/v1/session`, keeps the session token in `sessionStorage`, and sends it in `Authorization: Bearer` (SEC-019).
- Honor the daemon's Content Security Policy: no inline event handlers, no remote origins, and no `eval`.
- Serve the SPA with a fallback route so a deep link reloads correctly, while `/api/v1` never falls back.
- Serve hashed asset filenames with immutable caching and the entry document with no caching, so an upgraded daemon never serves a stale bundle against a new API.
- Explicit server-state invalidation, and a reloadable path out of a Row Version conflict.
- No optimistic destructive success.
- Sanitized Markdown, no arbitrary file URLs, and no inline rendering of unsupported binary types.
- Accessible dialogs, focus management, and status announcements.

## 14. Git adapter

- Direct execution with argument arrays and an explicit working directory, never a constructed shell string.
- Batch-mode environment on every invocation: `GIT_TERMINAL_PROMPT=0` and SSH `BatchMode=yes`, so a missing credential fails with `GIT_AUTH_REQUIRED` instead of blocking on a prompt (BKP-025).
- A 60-second timeout and bounded captured output on every invocation.
- Stable machine-readable output where git offers it.
- Detect an in-progress git operation before starting a backup run.
- Stage exact managed pathspecs, and decide whether to commit with `git diff --cached --quiet` over those pathspecs (BKP-024).
- Push with `--atomic`, fast-forward only; never force push, rebase, merge, or resolve a conflict.
- Verify at Vault initialization and again in `backup verify` that `.gitattributes` carries the managed entries and that `core.autocrlf` is `false` in the Vault repository (BKP-022).
- Never modify global git configuration.
- Record snapshot, commit, and push phases separately in `backup_runs`.

## 15. Logging and diagnostics

Every Sorage process, CLI and daemon alike, writes structured JSON logs to `~/.sorage/logs/sorage.log` under the configured rotation, defaults the CLI level to `warn`, may redact paths, and never logs a token (RUN-009).

Every HTTP request carries a UUID request id, and the same field appears on the log lines it produces.

`doctor` returns a stable check catalog that is part of the versioned CLI JSON contract: every check has a canonical dotted `id`, a `severity` of `ok`, `warning`, or `blocking`, a `message`, and an optional `recovery`, and the exit code is 0 when no check is `blocking` (INIT-017).

```json
{
  "checks": [
    {
      "id": "vault.marker",
      "severity": "ok",
      "message": "Vault marker is valid"
    }
  ]
}
```

The catalog is owned normatively by `../specs/interfaces-and-operations.md`, and it is milestone-scoped: the M1 snapshot carries only the M1 check identifiers, and a later identifier appears when its milestone is reached.

Changing an existing identifier or its severity semantics is a contract change, because both are as stable as any other public JSON field.

## 16. Testing

Every test and every manual check points `SORAGE_HOME` at a temporary directory, and no test may touch the developer's real `~/.sorage` (INIT-015).

Use an isolated temporary home, Vault, git repository, and database per test, created and removed by the harness rather than shared between cases.

`testkit` lives in `adapters` and is owned by the foundation Epic before any test depends on it; it provides the fake `Clock` and `IdGenerator`, the fault-injection filesystem adapter that reproduces the enumerated crash points, the fault-injection git adapter, disk-full and read-only-Vault injection, bare-remote plus clone git fixtures, and the ten-thousand-Handoff seed generator.

Use the `make` targets rather than inventing parallel commands: `make test-prepare` for format, lint, typecheck, the Bun and product version assertions, and the dependency-boundary guard; `make test-unit`; `make test-int`; `make test-contract`; `make test-e2e`; and `make test` as the single gate.

Those same targets run on the developer's macOS machine, so a check that cannot run on macOS cannot be a gate.

## 17. Ecosystem integration

- Sorage is a standalone repository and builds, tests, and packages from its own root; no ecosystem tool is a source dependency of any package (GEN-009, NFR-013).
- The development workflow binds to Aquarium, Podway, Mulgae, Gaori, and Sanho in exactly one place, `AGENTS.md` at the repository root; nothing under `packages/` or `apps/` references them.
- Discovery ships as `skills/use-sorage/SKILL.md` in this repository from milestone M1, and Sorage adds no handler to Aquarium and requires no change to it (GEN-011).
- The skill follows the explicit-request policy in GEN-014: checks report results, Handoff processing and waiting require requests covering that work, and unrelated tasks never trigger discovery. Managed Vault files must never be edited directly. Requested Sorage project setup ensures `.sorage/` is ignored in `.gitignore` by default, preserving existing entries and avoiding duplicates (HND-026); the CLI does not automatically edit that file.
- The named interoperability seam is the Podway `ExternalReference` artifact slot: another tool records a Handoff UUID there and resolves it through the public `sorage` CLI or the local API, never by importing a Sorage package.
- Sorage adopts the ecosystem Markdown rules voluntarily: no hard-wrapped prose, and every relative link resolves (NFR-015).

## 18. Package selection

The runtime dependency set is fixed by ADR-0016 rather than chosen per Task:

| Package | Why this one |
|---|---|
| `bun:sqlite` | Ships with the pinned runtime, is synchronous, and embeds into a compiled binary with no native module |
| `commander` | One declaration produces help text, parsing, and shell completion, which keeps CLI-001 and CLI-015 in agreement |
| `yaml` | Its Document API is the only practical way to preserve comments and key order across a configuration write (CFG-018) |
| `vitest` | The ecosystem-standard runner, executed through Bun for unit, integration, and contract suites |
| `playwright` | Web end-to-end coverage from milestone M2, including the browser session exchange |
| `axe-core` | Accessibility checks inside `make test-e2e`, as engineering practice rather than a release gate (WEB-018) |
| `preact` with `vite` | A small SPA runtime and a build that emits static assets the daemon can serve without a Node runtime |

Any addition to this set is a material change and MUST satisfy: active maintenance, TypeScript support, a small runtime surface, deterministic behavior, a clean security history, streaming support where it handles Artifact bytes, testability, and no adapter type leaking into `core`.

## 19. Task implementation report

Every Task report includes:

```text
Task ID
Milestone
Task class
Requirements
Design Gate impact
Files and packages changed
Schema changes
Protocol changes
Snapshot diff classification
Tests added
Failure paths tested
Manual checks
Reviewer verdict
Known limitations
SOT changes
```

`Snapshot diff classification` is `breaking`, `non-breaking`, or `not applicable`, and it is mandatory for a Contract Task. `Design Gate impact` is `Not required` while no Design Gate registry is enrolled, with the reason recorded once in the roadmap header.
