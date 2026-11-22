# M11 Architecture Hardening and Modernization Qualification Map

This guidance document records the reproducible pre-work baselines captured in `TASK-147` against unmodified `HEAD` (`f842225`, runtime `SORAGE_VERSION = "0.1.5"`, schema `16`, global backup format `5`), the target verification matrix for `EPIC-022` through `EPIC-024`, and the `SchemaSurface` `"exchange"` floor rationale. Normative requirements live in [required-specification.md](../specs/required-specification.md), [ADR-0038](../architecture-decision-records/README.md#adr-0038-m11-non-breaking-hardening-v17-index-migration-and-internal-architecture-cleanup), [interfaces-and-operations.md](../specs/interfaces-and-operations.md#42-m11-hardening-schema-v17-and-contract-classification) and [Gate M11](../specs/testing-and-acceptance.md#912-gate-m11-architecture-hardening-and-modernization-end-of-epic-022-epic-023-and-epic-024); delivery status lives solely in [the roadmap](../roadmap/README.md).

## 1. Baseline environment and commit metadata

Every pre-work probe ran against the unmodified checkout with `SORAGE_HOME` isolated to a fresh `/tmp/sorage-m11-*` directory removed in `finally`, leaving the developer's `~/.sorage` and repository `dist/` artifacts untouched:

| Property | Recorded value |
|---|---|
| Baseline commit | `f842225` (`SORAGE_VERSION = "0.1.5"`, schema `16`, backup format `5`, `ERROR_CODES` length `76`) |
| Measurement date | `2026-11-22` |
| Machine / CPU | Apple M5 Pro (`arm64`), 64 GiB RAM (`68,719,476,736` bytes) |
| Operating system | macOS `27.0.1` (Build `26A434`) |
| Filesystem | Local APFS (`apfs`, journaled; `/tmp` on system APFS volume, workspace on `/Volumes/RootKernel` APFS volume) |
| Managed Bun / Node | Bun `1.4.2` (`.bun-version`), Node `26.7.0` (`.node-version`) |
| Isolation & cleanup | Fresh `mktemp -d /tmp/sorage-m11-*` per probe; temporary compiled binary and temp homes removed via `trap` / `finally`, verified clean after run |

## 2. Recorded pre-work baselines (`HEAD` `f842225`)

### 2.1 Metric 1: SQLite opens and `BEGIN IMMEDIATE` write locks per CLI command (`TASK-151` target)

- **Methodology:** Initialize a fresh isolated `SORAGE_HOME` to schema `16`, register two Projects (`proj-a`, `proj-b`), and instrument `bun:sqlite` `Database.prototype.exec`, `prepare` and `query` in-process (without modifying repository source) while executing `runCli` for a single-recipient `sorage send --file`, `sorage revise --file --expected-row-version 1` and `sorage doctor --json` against the already up-to-date schema-16 database.

| Command | Exit | SQLite file opens | Total `BEGIN IMMEDIATE` | Empty migrator `BEGIN IMMEDIATE` | `PRAGMA foreign_keys = OFF` toggles |
|---|---:|---:|---:|---:|---:|
| `sorage send` (1 recipient, file) | 0 | `12` | `6` | `4` | `4` |
| `sorage revise` (file replacement) | 0 | `12` | `6` | `4` | `4` |
| `sorage doctor` | 0 | `9` | `0` | `0` | `0` |

- **Root cause confirmed:** `packages/adapters/src/sqlite/migrator.ts:152` dispatches to `migrateRebuildBatch` whenever `rebuilds.length > 0`, even when `toApply.length === 0`. Because `productionMigrationPlan()` always registers rebuilds 9 and 10, every writable port open spawns an extra rebuild connection, disables foreign keys and acquires an empty `BEGIN IMMEDIATE` write lock; combined with repeated port/config opens per command, a single `send` or `revise` opens SQLite 12 times and takes 4 empty migrator write locks, while `doctor` opens SQLite 9 separate times.

### 2.2 Metric 2: Handoff listing SQL statement count (`TASK-154` target)

- **Methodology:** Seed an isolated schema-16 database with 2 Projects and 60 Handoffs via `sorage send`, wrap `SorageSqlite.prepare`/`exec` passed to `createSqliteHandoffReadStore`, and execute `listPage({ kind: "inbox", recipientProjectId }, {}, 50, null)`.

| Measurement | Recorded value |
|---|---|
| Returned rows | `50` |
| Total SQL statements executed | `303` |
| Elapsed time (in-cache local APFS) | `1.294 ms` |
| Statement breakdown | `1` base `handoffs` query + `100` `deletion_requests` lookups (`2×` per row at `handoff-read-store.ts:212` and `:252`) + `50` `artifacts` + `50` `content_records` + `50` `review_notes` (`commentOf`) + `50` `review_notes` (`noteExists`) + `2` `projects` slug lookups |

### 2.3 Metric 3: Daemon `GET /api/v1/health` latency under slow `git push` and 64 MiB sweep (`TASK-153` target)

- **Methodology:** Configure an isolated `SORAGE_HOME` with a Git-enabled Vault, a local bare remote whose `hooks/pre-receive` sleeps `1.5` seconds (deterministic slow push with zero network dependency), and one `64 MiB` (`67,108,864` bytes) binary Artifact. Start real `serveDaemon` on an ephemeral loopback port (`127.0.0.1`) with manual `scheduleSweep`/`scheduleBackup` hooks. Run a separate OS child-process HTTP probe loop issuing authenticated `GET /api/v1/health` requests with an explicit `READY` synchronization barrier so the client timer is independent of the daemon event loop.

| Scenario | Health probes | Min (ms) | Median (ms) | p95 (ms) | Max (ms) | Background work observation |
|---|---:|---:|---:|---:|---:|---|
| Idle control | `23` | `0.25` | `0.37` | `0.73` | `0.85` | No background job running |
| During `POST /api/v1/backup/run` (1.5s remote hook) | `4` | `0.24` | `0.86` | `2313.22` | `2313.22` | Backup returned HTTP 200 in `2364.97 ms`; event loop stalled for the full synchronous `git` run |
| During 64 MiB `runSweepTick()` | `31` | `0.16` | `0.27` | `0.87` | `31.81` | Swept 1 artifact (`67,108,864` bytes, 0 mismatches) synchronously in `41.77 ms` via `readFileSync` |

### 2.4 Metric 4: Exchange `planRead` paged retrieval I/O over 10 MiB material (`TASK-154` target)

- **Methodology:** In an isolated schema-16 `SORAGE_HOME`, write one `10 MiB` (`10,485,760` bytes) binary working body through `createExchangeWorkingStore(...).write(...)`, then paginate the entire file from offset `0` to `10,485,760` in `64 KiB` (`65,536` bytes) pages via `planRead(exchangeId, contentId, offset, 65536)`.

| Measurement | Recorded value |
|---|---|
| File size / total bytes returned | `10,485,760` bytes (`10 MiB`) |
| Page size / total pages | `65,536` bytes (`64 KiB`) / `160` pages |
| Total disk bytes sequentially read & SHA-256 hashed | `1,677,721,600` bytes (`1,600 MiB`, `160×` I/O amplification) |
| Total elapsed time | `623.60 ms` |
| Per-page latency (median / p95 / max) | `3.732 ms` / `5.163 ms` / `6.930 ms` |

### 2.5 Metric 5: Cold spawn latency of compiled `sorage exchange renew` (`TASK-159` target)

- **Methodology:** Compile unmodified `HEAD` (`f842225`) into a throwaway binary `$TMP/sorage-v015-baseline` via `bun build --compile apps/cli/src/main.ts --outfile "$TMP/sorage-v015-baseline"` (verified `version` output `sorage v0.1.5`), initialize an isolated `SORAGE_HOME`, create an Exchange between `proj-a` and `proj-b`, join as `proj-a` to obtain a live `claimId`, run 1 warm-up renewal, then time 10 cold child-process spawns (`Bun.spawnSync`) of `exchange renew <exchange-id> --claim <claim-id> --json`.

| Measurement | Recorded value |
|---|---|
| Samples (after 1 warm-up) | `10` cold spawns |
| Min / median / mean (ms) | `70.42 ms` / `71.98 ms` / `71.77 ms` |
| p95 / max (ms) | `73.76 ms` / `73.76 ms` |
| Eager import confirmation | `apps/cli/src/main.ts:126` statically executes `import * as daemonModule from "@sorage/daemon"` on every CLI invocation |

## 3. `SchemaSurface` `"exchange"` floor rationale (`TASK-152`)

`packages/core/src/known-schemas.ts` tracks per-surface minimum schema floors for every shipped domain (`operational: 1`, `preflight: 1`, `send-replay: 4`, `memo: 7`, `channel: 11`), but M10 omitted `"exchange"` from `SchemaSurface`. `TASK-152` adds `"exchange"` with `SCHEMA_SURFACE_FLOORS.exchange = 16` (`16 / exchange-notices`) rather than `13` (`exchange-foundation`) because:

- `memo: 7` and `channel: 11` both reflect the first shipped schema containing that domain's complete table set (`v0.1.2` for Memo, `v0.1.3` for Channel `channels-v2`).
- Exchange first shipped in `v0.1.5` at schema `16`, and Exchange operations across collaboration, lifecycle and notice commands depend on tables introduced across migrations `13` through `16` (`exchanges`, `exchange_claims`, `exchange_transitions`, `exchange_notice_presence`, `exchange_notice_claims`, `exchange_notice_issues`); versions `13`–`15` were unreleased intermediate EPIC-021 increments.
- Zero-write covered reads (`packages/adapters/src/sqlite/read-admission.ts:226`) continue to require `appliedMaximum === knownSchemaMaximum()` and return `STORAGE_MIGRATION_REQUIRED` for any older schema.

## 4. Verification targets for downstream M11 Tasks

| Metric / check | Baseline (`HEAD` `f842225`) | Owning Task & expected improvement |
|---|---|---|
| Metric 1 (`send` / `revise` / `doctor` DB opens & empty migrator locks) | `12 / 12 / 9` opens; `4 / 4 / 0` empty migrator `BEGIN IMMEDIATE` locks | `TASK-151` (migrator short-circuit → `0` empty migrator locks and `0` `PRAGMA foreign_keys = OFF` toggles on up-to-date DBs; command-scoped DB reuse) and `TASK-154` (`DoctorContext` single DB open) |
| Metric 2 (`listPage` 50-row SQL count) | `303` statements (`1 + 6N + P`) | `TASK-154` (single `LEFT JOIN` projection → `1` statement) |
| Metric 3 (daemon `GET /api/v1/health` max latency during slow push & 64 MiB sweep) | `2313.22 ms` (push) / `31.81 ms` (sweep) | `TASK-153` (async backup/push offload and streaming sweep → health stays responsive well below the 15s browser timeout and near idle latency) |
| Metric 4 (10 MiB Exchange `planRead` in 64 KiB pages) | `1,600 MiB` disk read (`160×`), `623.60 ms` | `TASK-154` (eliminate per-page full-file re-hashing → $O(S)$ total bytes read and large latency drop) |
| Metric 5 (compiled `sorage exchange renew` cold spawn) | `71.98 ms` median, eager `@sorage/daemon` import | `TASK-159` (lazy dynamic `import()` bootstrap removing `@sorage/daemon` from non-daemon CLI paths) |
| Schema `v17` index usage & v0.1.5 upgrade/restore/rollback | Schema `16`, missing 12 secondary/FK/sort indexes | `TASK-152` (`EXPLAIN QUERY PLAN` index verification for all 12 indexes + isolated v16→v17 upgrade) and `TASK-163` (full `make test` + Format 1–5 legacy restore + matched-binary rollback) |

## 5. `TASK-147` design-only verification record

`TASK-147` is a design-only Contract Task modifying Markdown documentation only (`docs/**`). No runtime code, SQLite migration, compiled executable, `ERROR_CODES` member (remains 76) or contract golden changes in `TASK-147`; runtime product tests (`make test`) therefore do not apply to this candidate under [governance sections 9.3 and 18.1](../governance/README.md#181-proportionate-verification-and-review). Verification covers `bun run check:sot`, `git diff --check`, the two-way error-catalogue contract checks (`apps/cli/test/contract/error-rendering.contract.test.ts` and `apps/daemon/test/contract/route-surface.contract.test.ts`), and the reproducible isolated-home baseline runs recorded above.
