# M11 Architecture Hardening and Modernization Qualification Map

This guidance document records the reproducible pre-work baselines captured in `TASK-147` against unmodified `HEAD` (`f842225`, runtime `SORAGE_VERSION = "0.1.5"`, schema `16`, global backup format `5`), the target verification matrix for `EPIC-022` through `EPIC-024`, the `SchemaSurface` `"exchange"` floor rationale, the assembled candidate evidence and limits from `TASK-163`, and the combined `EPIC-025` (`v0.1.6` release-hardening) qualification evidence from `TASK-175`. Normative requirements live in [required-specification.md](../specs/required-specification.md), [ADR-0038](../architecture-decision-records/README.md#adr-0038-m11-non-breaking-hardening-v17-index-migration-and-internal-architecture-cleanup), [ADR-0041](../architecture-decision-records/README.md#adr-0041-m11-release-hardening-and-regression-coverage), [interfaces-and-operations.md](../specs/interfaces-and-operations.md#42-m11-hardening-schema-v17-and-contract-classification) and [Gate M11](../specs/testing-and-acceptance.md#912-gate-m11-architecture-hardening-and-modernization-end-of-epic-022-epic-023-and-epic-024); delivery status lives solely in [the roadmap](../roadmap/README.md).

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

`packages/core/src/shared/known-schemas.ts` tracks per-surface minimum schema floors for every shipped domain (`operational: 1`, `preflight: 1`, `send-replay: 4`, `memo: 7`, `channel: 11`), but M10 omitted `"exchange"` from `SchemaSurface`. `TASK-152` adds `"exchange"` with `SCHEMA_SURFACE_FLOORS.exchange = 16` (`16 / exchange-notices`) rather than `13` (`exchange-foundation`) because:

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

## 6. Observed `EPIC-022` and `TASK-159` before/after qualification results

The table below records the post-implementation measurements captured in isolated temporary `SORAGE_HOME` directories on the same Apple M5 Pro / macOS `27.0.1` / Bun `1.4.2` / Node `26.7.0` environment after completing `TASK-151` through `TASK-154` (`EPIC-022`) and `TASK-159` (`EPIC-023`). The `EPIC-023` integrated gate (`TASK-167`) and the assembled M11 re-measurement were still open at the time of this record.

| Metric | Pre-work baseline (`f842225`) | Post-implementation observed | Owning task / commit | Improvement |
|---|---|---|---|---|
| Metric 1: `sorage send` (1 recipient, file) | `12` opens / `6` `BEGIN IMMEDIATE` (`4` empty migrator, `4` FK toggles) | `2` opens / `2` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles) | `9bc48b8` (`TASK-151`) | `-83.3%` opens, `-66.7%` locks, `-100%` empty migrator locks & FK toggles |
| Metric 1: `sorage revise` (file replacement) | `12` opens / `6` `BEGIN IMMEDIATE` (`4` empty migrator, `4` FK toggles) | `2` opens / `2` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles) | `9bc48b8` (`TASK-151`) | `-83.3%` opens, `-66.7%` locks, `-100%` empty migrator locks & FK toggles |
| Metric 1: `sorage doctor` | `9` opens / `0` `BEGIN IMMEDIATE` | `2` opens (`1` readonly admission + `1` shared `DoctorContext`) / `0` `BEGIN IMMEDIATE` (`8.52 ms`) | `69d9876` (`TASK-154`) | `4.5×` fewer DB opens, `0` write locks |
| Metric 2: 50-row Handoff `listPage` | `303` SQL statements (`1.294 ms`) | `1` SQL statement (`0.481 ms`, `v17` index used, zero temp B-tree) | `8aa1f80` (`TASK-152`) + `69d9876` (`TASK-154`) | `303×` fewer SQL statements, `2.7×` faster |
| Metric 3: Daemon `GET /api/v1/health` during 1.5s `git push` | `4` probes; p95 `2313.22 ms`, max `2313.22 ms` | `89` probes; median `0.62 ms`, p95 `2.49 ms`, max `22.82 ms` (concurrent Memo `POST` `5.44 ms`, `PATCH` `2.30 ms`) | `0f2ead5` (`TASK-153`) | `~101×` lower max latency; live concurrent Memo mutations |
| Metric 3: Daemon `GET /api/v1/health` during 64 MiB sweep | `31` probes; p95 `0.87 ms`, max `31.81 ms` | `5` probes; median `1.10 ms`, p95 `1.22 ms`, max `7.30 ms` (concurrent Memo `POST` `3.21 ms`, `PATCH` `1.94 ms`) | `8aa1f80` (`TASK-152`) + `0f2ead5` (`TASK-153`) | `~4.4×` lower max latency; live concurrent Memo mutations |
| Metric 4: 10 MiB Exchange `planRead` (160 × 64 KiB pages) | `1,677,721,600` bytes (`1,600 MiB`, `160×`), `623.60 ms` (median `3.732 ms`) | `20,905,984` bytes (`19.94 MiB`, `1.99×`), `18.41 ms` (median `0.073 ms`, p95 `0.183 ms`); activation re-read `0` bytes | `69d9876` (`TASK-154`) | `80.25×` less disk I/O, `33.9×` faster total, `51×` faster median page |
| Metric 5: Compiled `sorage exchange renew` cold spawn | `71.98 ms` median (`70.42–73.76 ms`), eager `@sorage/daemon` static import (`apps/cli/src/main.ts` 3,973 lines) | `68.76 ms` median (min `66.94 ms`, mean `68.91 ms`, p95/max `72.09 ms`, 1 warm-up + 10/10 cold `ok: true`); `main.ts` `52` lines; `0` static closure paths to `@sorage/daemon` from non-serve entry points (`main.ts`, `program.ts`, `internal-probes.ts`, `mcp-server.ts`); `0` daemon module evaluations on renew/probes/MCP (managed Bun + compiled embedded-bundle initializer CFG) | `TASK-159` (`EPIC-023` integrated gate open in `TASK-167`; final M11 repeat open in `TASK-163`) | `-3.22 ms` (`-4.5%`, `1.05×` faster); `@sorage/daemon` initialization eliminated from non-daemon CLI invocations |

## 7. Assembled M11 qualification observations

### 7.1 Exact source and complete automated gate

The assembled product commit is `1723cfe807726d3f7f2792615aa1990dc72390b2`, built from a detached checkout on Apple M5 Pro, macOS `27.0.1` build `26A434`, with managed Bun `1.4.2` and Node `26.7.0`. The complete `make test` ran once through the configured Gaori `test` command with its 3,600-second timeout. The child and runner both exited 0 in 207.940 seconds. The tracked worktree stayed byte-identical to that commit. The detached checkout used a local link to the existing managed toolchain.

| Gate stage | Passing files | Passing tests |
|---|---:|---:|
| Unit | 88 | 1,191 |
| Integration | 142 | 1,684 |
| Contract | 21 | 152 |
| Compiled E2E | 52 | 248 |
| Release AJ-16 | 1 | 1 |
| Total | 304 | 3,276 |

Preparation passed the managed toolchain, version, format, Web embedding, lint, typecheck, import, runtime cycle, dependency and Source of Truth checks. The ordered gate packaged once before integration and reused the signed binary for the compiled journeys and release check. It covered the applicable prior journeys through AJ-37, all 14 Web E2E suites, and both compiled tests in the [MCP sandbox suite](../../test/e2e/mcp-sandboxed-client.e2e.test.ts). The axe report found zero violations on Dashboard, Inbox, Compose, Projects, Settings and Diagnostics. The axe suite reports findings on those six routes and does not fail on the number of violations.

The candidate's signed darwin-arm64 SHA-256 is `5053d371c19f94806ff4d4aca1b5b60fe0983e2d1c540d6d1a57095a3bb8cdb1`. Its two unsigned compilations matched at `93b3a2dddf340297a4811020cf6f1ba0fec12864f435e6a196ba2829d1dbaf02`. The annotated `v0.1.5` tag object `aa5e98d47c63729536ec5643904ba893c2ec1174` resolves to release commit `878ba9d61c489d1df56ef31a62b5349946232510`. Building that authentic detached predecessor with `make deps build` produced SHA-256 `1d5f19d8ed5e40b68899399ea8b6609fa6703bb46944891435d59d943ca6f102`. Both source revisions set `SORAGE_VERSION` to `"0.1.5"`. The source revision, executable digest, and supported schema (16 for the predecessor and 17 for the candidate) distinguish the two builds.

Under [the evidence reuse rules](../governance/README.md#181-proportionate-verification-and-review), the complete gate applies to this qualification record. Subsequent edits cover the TASK-163 roadmap projection and the documentation for Master's revised metric 5 criterion. The Web source and embedded bytes match the prior independently inspected TASK-162 implementation. The compiled suite and that earlier rendered evidence cover the unchanged browser behavior. The earlier independent observation identified pre-existing narrow-screen overflow on Dashboard, Compose and Backup, recorded in [deferred feedback](../deferred-feedback/README.md#narrow-web-layout-overflow).

### 7.2 Authentic predecessor upgrade, refusal and rollback

| Step | Observed result |
|---|---|
| 1. Seed and preserve the schema-16 predecessor | The built `v0.1.5` predecessor restored a Format 1 donor generated from the frozen legacy revision fixture carrying the ADR-0031 short ID, then created synthetic Projects, Handoffs with recipient processing and comments, inline and file-backed Memos, a Channel message, Exchange collaboration data, and a connection-check notice acknowledgement. The connection-check age used the existing synthetic CLI contract fixture technique. The verified Format 5 donor contained 3 Projects, 3 Handoffs, 3 Artifacts, 2 Memos, 1 Channel, and 2 Exchanges. Its manifest SHA-256 is `4ae082fe8dd0661fcf337876fd93a928a689e0697955b2d11b12a21c19b5d488`. A separate predecessor restore and `vault verify` passed before the upgrade. |
| 2. Inspect before upgrading | The candidate's `preflight --json` returned `upgrade_required` and exit 78. The SQLite main file and WAL digests stayed identical through the inspection. |
| 3. Upgrade in place | The candidate's `backup run --as-user --json` installed migration `17 / m11-secondary-indexes-v1`. Subsequent `preflight --json` was `compatible` with exit 0, `doctor --json` reported zero blocking checks, and `backup verify` and `vault verify` passed. All 12 indexes were present. The compared domain tables, operational Exchange rows involved in the fixture, and Artifact identities including `ac9d65873` matched their pre-upgrade values. |
| 4. Reject forward access from the predecessor | On the upgraded home, predecessor `vault status --json`, `project list --json`, `memo list --json` and `doctor --json` each exited 78 with `STORAGE_SCHEMA_UNSUPPORTED`. Its `preflight --json` returned `unsupported` with exit 78. The database and WAL bytes matched before and after each command. |
| 5. Restore with the matching predecessor | A fresh separate home and Vault accepted dry-run and confirmed restore from the retained donor. The dry-run preserved the target DB and WAL bytes. `vault verify` exited 0, schema remained 16, and the retained business identities, normalized content bytes and digests, and metadata matched the source. The donor file inventory was byte-identical afterward. |
| 6. Exercise Format 1–5 and short-ID compatibility | The exact aggregate passed the [frozen snapshot characterization matrix](../../packages/adapters/test/int/snapshot-characterization.int.test.ts), including dry-run and restore for all five formats, exact content and target file modes, and positive verification. It also passed the [legacy revision tests](../../packages/adapters/test/int/legacy-revise-upgrade.int.test.ts) exercising the short ID through Formats 1, 2 and current Format 5. The signed candidate also independently ran native `backup restore --dry-run`, confirmed `backup restore`, and `vault verify` in a separate home for each of Formats 1–5. Private copies of the original frozen fixtures substituted `ac9d65873` for one Artifact ID and adjusted its references and Artifact path. Each restore retained that ID and storage key, the file SHA-256 `bd3daf8408a492559e048bb8061311085f3056001415289100548212d51ab1c5`, and mode `0444`. All five Vault verifications found zero blocking issues, and each donor remained byte-identical through the drill. |

The in-place comparison used the stored rows directly. All 16 files in the non-Git Vault inventory, including the 11 snapshot files, matched the retained predecessor donor byte for byte after the upgrade. Restore parity follows the backup contract. Restores construct new internal content-record IDs, leave bindings, operational receipts and claims empty, and preserve Exchange working-material metadata with the working bytes unavailable. The drill compared the identities and content joins the snapshot retains, including the short Artifact storage key, alongside integrity verification. The guarded old executable was the restored home's matched reader. The upgraded live home was kept separate during rollback.

### 7.3 Performance re-measurement

| TASK-147 baseline | Canonical pre-work result | Fresh assembled result |
|---|---|---|
| 1. SQLite opens and locks | `send` / `revise` / `doctor` opened 12 / 12 / 9 connections, with 6 / 6 / 0 total and 4 / 4 / 0 empty-migrator `BEGIN IMMEDIATE` locks | 2 / 2 / 2 file connections, 2 / 2 / 0 total write locks, zero empty-migrator locks and zero foreign-key-off toggles. Counted unique connections and SQL through Bun SQLite `exec`, `prepare` and `query` on successful in-process file send, file revise and diagnostic commands. |
| 2. Handoff listing SQL | 303 statements for 50 returned rows, 1.294 ms | 1 statement for 50 rows on a 60-Handoff two-Project fixture, 1.108 ms. The actual inbox projection used the recipient/updating-order index. |
| 3. Health during background work | Maximum 2,313.22 ms during the 1.5-second Git push and 31.81 ms during the 64 MiB sweep | Maximum 11.780 ms across 663 probes during the local push, and 1.769 ms across 10 probes during the 67,108,864-byte sweep. The push completed successfully in 1,890.062 ms. The sweep checked one Artifact in 34.184 ms with zero mismatches. An authenticated loopback probe ran in a separate OS process with a READY barrier. The idle maximum was 1.827 ms across 143 probes. |
| 4. Exchange paged reading | 1,677,721,600 bytes read and 623.60 ms for 160 pages of 64 KiB over 10 MiB | 20,905,984 bytes returned by 321 native file reads, about 80.25× fewer bytes than the pre-work probe. The reconstructed 10,485,760-byte payload matched exactly. The read-count instrument recorded 269.286 ms total and 1.577 ms median per page. Those timings describe the instrumented run and are not equivalent to the timed-only measurements in section 6. |
| 5. Compiled `exchange renew` cold spawn | 71.98 ms median, with daemon eagerly initialized | The signed candidate's 10 cold spawns had a 75.405 ms median after one warm-up. The comparable plain managed Bun compile measured 86.572 ms median on the candidate and 93.454 ms on a fresh `f842225` baseline in the same session. Both candidate series failed the original comparison to 71.98 ms. Both medians pass Master's revised Gate M11 cutoff of at most 1,000 ms, and all 20 timed candidate samples also fall within the cutoff. |

For the paired timing, each executable came from `bun build --compile apps/cli/src/main.ts` with the same output basename and no package re-signing. Both used the same two-Project Exchange fixture and a successful renewal as warm-up. The ten cold samples per binary alternated order with a 50 ms pause between spawns, and every renewal succeeded. The fresh baseline ranged from 75.462 to 126.347 ms and the comparable candidate from 76.222 to 140.424 ms. The signed series ranged from 71.563 to 86.119 ms. The candidate median was lower than the fresh baseline median in this session, with overlapping sample ranges. The paired samples do not establish a startup speedup, and the cause of the gap from TASK-147's recorded timing is unverified. The 71.98 ms baseline and the failed original comparison remain historical evidence. Master's [2026-11-25 criterion decision](../governance/README.md#task-163-cold-start-qualification-criterion-2026-11-25) uses the same successful median measurements with the 1,000 ms cutoff.

The packaged binary's embedded loader calls the daemon initializer only from the `daemon serve` branch. The exact aggregate also passed the [managed Bun bootstrap checks](../../apps/cli/test/int/cli-lazy-bootstrap.int.test.ts), which observe zero daemon module entries on renew, internal probes and the MCP entry. The loader evidence supports the zero-daemon-initialization criterion alongside the measured cold-spawn cutoff.

### 7.4 Schema 17 query plans

All 12 indexes appeared in 17 observed plans on the seeded `ANALYZE` corpus from the [schema 17 plan suite](../../packages/adapters/test/int/schema-v17-indexes.int.test.ts). There were no unindexed full-table scans or temporary ordering B-trees in those plans. The index walks below cover the unbounded ordering queries.

| Index | Representative observed plan |
|---|---|
| `idx_content_records_storage_key` | `SEARCH c USING INDEX idx_content_records_storage_key (storage_key>?)` |
| `idx_pending_fs_ops_op_to_path` | `SEARCH pending_fs_ops USING COVERING INDEX idx_pending_fs_ops_op_to_path (op=? AND to_path=?)` |
| `idx_project_memos_content_record` | `SEARCH project_memos USING COVERING INDEX idx_project_memos_content_record (content_record_id=?)` |
| `idx_handoffs_recipient_updated` | `SEARCH handoffs USING INDEX idx_handoffs_recipient_updated (recipient_project_id=?)` |
| `idx_handoffs_sender_updated` | `SEARCH handoffs USING INDEX idx_handoffs_sender_updated (sender_project_id=?)` |
| `idx_handoffs_updated` | `SCAN handoffs USING INDEX idx_handoffs_updated` |
| `idx_events_created` | `SCAN events USING INDEX idx_events_created` |
| `idx_exchange_claims_project` | `SEARCH exchange_claims USING COVERING INDEX idx_exchange_claims_project (project_id=?)` |
| `idx_exchange_notice_claims_project` | `SEARCH exchange_notice_claims USING COVERING INDEX idx_exchange_notice_claims_project (project_id=?)` |
| `idx_exchange_materials_content` | `SEARCH exchange_materials USING COVERING INDEX idx_exchange_materials_content (content_id=?)` |
| `idx_exchange_cleanup_items_content` | `SEARCH exchange_cleanup_items USING COVERING INDEX idx_exchange_cleanup_items_content (content_id=?)` |
| `idx_idempotency_keys_scope_expires` | `SEARCH idempotency_keys USING INDEX idx_idempotency_keys_scope_expires (scope>? AND scope<?)` |

### 7.5 Skill evidence and qualification outcome

Both shipped copies of `exchange-loop.md` were byte-identical, with SHA-256 `a2cba154c5e622d09143d685de8d2575bcae5bfbed5bd7ca9ae42f13393294ed`. Source of Truth checking covered the shipped skill source, and the complete gate included the compiled MCP sandbox tests. The [prior copied-skill observations](exchange-qualification.md#independently-copied-exchange-skills) apply to the recorded copied files, harness versions, permissions and synthetic Exchange scenarios. No new independent copied-skill run was performed for this qualification.

The complete automated gate, authentic predecessor/rollback drill, frozen restore coverage, and 12 query plans support the assembled source. Metrics 1–4 improved against the recorded baselines. The existing successful timing series and loader evidence satisfy the revised metric 5 criterion on that source. The changelog disposition is `intentional no-note`.

## 8. Combined EPIC-025 `v0.1.6` release-hardening qualification (`TASK-175`)

### 8.1 Exact combined source, packaged candidate, and complete automated gate

The combined `EPIC-025` candidate builds on `TASK-168` through `TASK-174` (`HEAD` `e424561350e42e1e02dec0719dd1ef8e7795490e`) plus one bounded commit-time containment regression fix in [projects.ts](../../packages/adapters/src/projects.ts), [projects.int.test.ts](../../packages/adapters/test/int/projects.int.test.ts), and [interfaces section 42.6.2](../specs/interfaces-and-operations.md#4262-boundary-1-root-safe-containment-vs-legacy--binding-isolation-task-169) absorbed into `TASK-175` under Master's [2026-11-27 scope approval](../governance/README.md#task-175-absent-vault-commit-time-containment-scope-approval-2026-11-27). The initial combined `make test` run caught an `ENOENT` regression on [project-eligibility.int.test.ts](../../packages/adapters/test/int/project-eligibility.int.test.ts) where direct `realpathSync` failed on a configured `vaultPath` not yet created on disk; `resolveVaultPhysicalPath` now normalizes `vaultPath` via `resolve(vaultPath)` and climbs via `lstatSync` to the longest existing ancestor before `BEGIN IMMEDIATE` while keeping dangling symlinks and non-`ENOENT` errors fail-closed. On that exact final remediated code tree on Apple M5 Pro, macOS `27.0.1` (Build `26A434`), with managed Bun `1.4.2` and Node `26.7.0`, the complete `make test` aggregate passed with exit `0` (`0` failures) in `210.570` seconds.

| Gate stage | Passing files | Passing tests |
|---|---:|---:|
| Unit | 88 | 1,215 |
| Integration | 142 | 1,699 |
| Contract | 22 | 154 |
| Compiled E2E | 52 | 250 |
| Release AJ-16 | 1 | 1 |
| Total | 305 | 3,319 |

Preparation ran read-only `bun run build:web -- --check` (`TASK-172`), toolchain, version, Biome formatting (`594` files, `0` fixes), lint (`594` files, `0` diagnostics), workspace typecheck, import boundaries, runtime cycle check (`0` cycles across `253` files), dependency boundaries, and `bun run check:sot`. The single `make package` stage produced signed `darwin-arm64` binary SHA-256 `a015e20a02563697c3bd6dd04c1b02eec7e53c7c980814abb4bb12a1c12d0355` (identical across `dist/sorage` and `dist/sorage-v0.1.5-darwin-arm64`; `shasum -a 256 -c` and `codesign --verify --strict` passed; runtime version remains `sorage v0.1.5` pending separately authorized release version bump) with matching double-build unsigned reproducibility digest `25c9bd7f777a3d1b607c99f4864b70bd0b1587bd804ebcbebc534f9b76cc19cb`. Compiled E2E passed all `52` files (`250` tests), including applicable AJ-01–AJ-37 regressions, all updated `web --json` `data.url` callers, 390px and 1280px Web layouts, `axe-core findings: []`, and compiled MCP sandbox checks; Release `AJ-16` passed in `1,596 ms`. Under [interfaces section 42.6.4](../specs/interfaces-and-operations.md#4264-boundary-3-task-175-evidence-reuse-boundary-for-task-163-drills-and-metrics) and [governance section 18.1](../governance/README.md#181-proportionate-verification-and-review), after the final documentation edits (`m11-qualification.md`, `ops/README.md`, `CHANGELOG.md`, `deferred-feedback/README.md`, `roadmap/README.md`, `governance/README.md`, and `interfaces-and-operations.md`), fresh `bun run check:sot` (`sot-check passed`) and `git diff --cached --check` (exit `0`) passed on the exact final staged tree, while all runtime code, tests, embedded Web assets, and compiled executable inputs remain byte-identical to the passing `make test` candidate.

### 8.2 Fresh Metric 1 and Metric 5 re-measurement

Per [interfaces section 42.6.4](../specs/interfaces-and-operations.md#4264-boundary-3-task-175-evidence-reuse-boundary-for-task-163-drills-and-metrics), Metric 1 (`TASK-169` and `TASK-175` modified `send`/`revise`/`doctor` binding paths) and Metric 5 (`TASK-174` modified statically reachable CLI bundle modules) were freshly re-measured on the exact combined candidate inside isolated temporary `SORAGE_HOME` directories removed in `finally` with `~/.sorage` untouched.

| Metric | Pre-work baseline (`f842225`) | `TASK-163` (`1723cfe`) | Fresh combined `EPIC-025` result |
|---|---|---|---|
| Metric 1: `sorage send` (1 recipient, file) | `12` opens / `6` `BEGIN IMMEDIATE` (`4` empty migrator, `4` FK toggles) | `2` opens / `2` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles) | `2` opens / `2` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles; `7.35 ms`, exit `0`) |
| Metric 1: `sorage revise` (file replacement) | `12` opens / `6` `BEGIN IMMEDIATE` (`4` empty migrator, `4` FK toggles) | `2` opens / `2` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles) | `2` opens / `2` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles; `6.92 ms`, exit `0`) |
| Metric 1: `sorage doctor` | `9` opens / `0` `BEGIN IMMEDIATE` | `2` opens / `0` `BEGIN IMMEDIATE` | `2` opens / `0` `BEGIN IMMEDIATE` (`0` empty migrator, `0` FK toggles; `22.90 ms`, exit `0`) |
| Metric 5: Compiled signed `sorage exchange renew` cold spawn | `71.98 ms` median, eager `@sorage/daemon` import | `75.405 ms` median (`71.563–86.119 ms`), zero daemon init | `80.213 ms` median (`1` warm-up `80.543 ms`, `10/10` cold spawns `ok: true`, min `77.308 ms`, mean `80.165 ms`, p95/max `82.852 ms`; well below `1,000 ms` Gate M11 cutoff; zero `@sorage/daemon` initialization confirmed by passing [cli-lazy-bootstrap.int.test.ts](../../apps/cli/test/int/cli-lazy-bootstrap.int.test.ts)) |

### 8.3 Diff-audited evidence reuse and explicit limits

Auditing the full file diff from `1723cfe807726d3f7f2792615aa1990dc72390b2` (`TASK-163`) through `e424561350e42e1e02dec0719dd1ef8e7795490e` plus the `TASK-175` absent-Vault ancestor fix in `packages/adapters/src/projects.ts` confirms that every non-documentation, non-test code change is strictly confined to: (1) `Makefile` `test-prepare` (`TASK-172`), (2) CLI `web`/`daemon`/`runtime`/`setup` output wiring (`TASK-174`), (3) `apps/daemon/src/upload.ts` Handoff multipart body streaming (`TASK-170`), (4) `apps/daemon/src/web/` styles, three views, and `web-assets.generated.ts` (`TASK-173`), and (5) Project/Vault root containment and legacy `/` isolation across `packages/core/src/{content/import-policy,handoff/*,project/*,vault/vault-commands}.ts` and `packages/adapters/src/{doctor-checks-bindings,handoff-command-ports,project-command-ports,projects,vault-command-ports}.ts` (`TASK-169` and `TASK-175`).

Zero changes occurred to SQLite migrations (`packages/adapters/src/sqlite/migrations.ts`), `migrator.ts`, `read-admission.ts`, `known-schemas.ts`, backup snapshot codecs/export/restore/verify, Vault marker/layout schemas, `handoff-read-store.ts` `listPage` (Metric 2), daemon async backup/push or streaming sweep paths (Metric 3), Exchange working store or `planRead` (Metric 4), or `skills/` (both copies of `exchange-loop.md` remain byte-identical at SHA-256 `a2cba154c5e622d09143d685de8d2575bcae5bfbed5bd7ca9ae42f13393294ed`). Under [interfaces section 42.6.4](../specs/interfaces-and-operations.md#4264-boundary-3-task-175-evidence-reuse-boundary-for-task-163-drills-and-metrics) and [governance section 18.1](../governance/README.md#181-proportionate-verification-and-review), section 7's `1723cfe` manual `v0.1.5` schema-16→17 upgrade, guarded predecessor refusal, Format 1–5 short-ID restore, matched-binary rollback drills, 12 schema-17 `EXPLAIN QUERY PLAN` observations, and Metrics 2–4 remain valid by domain invariance alongside the fresh automated upgrade, Format 1–5 characterization ([snapshot-characterization.int.test.ts](../../packages/adapters/test/int/snapshot-characterization.int.test.ts)), legacy short-ID ([legacy-revise-upgrade.int.test.ts](../../packages/adapters/test/int/legacy-revise-upgrade.int.test.ts)), and schema-17 index plan ([schema-v17-indexes.int.test.ts](../../packages/adapters/test/int/schema-v17-indexes.int.test.ts)) suites passing inside the combined `make test`. Explicit reuse limitation: because `EPIC-025` changes non-storage CLI, Web, upload, and Project containment code, the combined signed executable digest (`a015e20a02563697c3bd6dd04c1b02eec7e53c7c980814abb4bb12a1c12d0355`) differs from the `1723cfe` executable (`5053d371c19f94806ff4d4aca1b5b60fe0983e2d1c540d6d1a57095a3bb8cdb1`) used in section 7's manual drills, and no new manual `v0.1.5` binary drill or Metrics 2–4 benchmark was re-run on the combined binary.

### 8.4 Verification of all seven `EPIC-025` outcomes

| Finding / outcome | Owning Task(s) | Durable verification evidence |
|---|---|---|
| Root-safe Project/Vault containment & legacy `/` isolation (`VLT-016`, `VLT-017`) | `TASK-169` (+ `TASK-175` absent-Vault commit-time fallback) | Unit (`import-policy`, `project-commands`, `project-resolution`, `workspace-identity`, `vault`) and integration (`projects`, `project-eligibility`, `cli-projects`, `vault-move`, `cli-send`, `cli-revise`, `cli-doctor`) suites inside combined `make test`; [Closed findings](../deferred-feedback/README.md#root-safe-workspace-containment-in-project-resolution) |
| Streaming Handoff body validation (`API-013`) & body-only missing/empty title coverage (`WEB-019`) | `TASK-170` | [upload.ts](../../apps/daemon/src/upload.ts), `upload.unit.test.ts`, `upload.int.test.ts`, `upload-envelopes.contract.test.ts` inside combined `make test`; [Closed findings](../deferred-feedback/README.md#body-emptiness-rescan-on-the-request-callback) and [body-only upload title](../deferred-feedback/README.md#body-only-upload-with-a-missing-title) |
| Shared 50-event Handoff timeline bound & `created_at DESC, id DESC` parity (`CLI-023`, `WEB-004`) | `TASK-171` | `cli-detail-read.int.test.ts` and `domain-routes.int.test.ts` over-limit fixtures inside combined `make test`; [Closed findings](../deferred-feedback/README.md#timeline-bound-overflow-coverage) |
| Check-first stale Web embedding rejection in `make test-prepare` (`WEB-001`, `NFR-013`) | `TASK-172` | `Makefile`, `web-assets.unit.test.ts`, `make-gate.int.test.ts`, `package-failure.int.test.ts` inside combined `make test` plus isolated stale-copy drill; [Closed findings](../deferred-feedback/README.md#detecting-stale-committed-web-assets) |
| Narrow 390px Web layouts for Dashboard, Compose, and Backup (`WEB-002`, `WEB-018`, `WEB-019`, `BKP-018`) | `TASK-173` | `apps/daemon/src/web/styles.css`, `dashboard.ts`, `compose.ts`, `backup.ts`, regenerated `web-assets.generated.ts`, `web-ui-defects`, `aj18-web-compose-body`, `backup-web`, and `axe-a11y` (`axe-core findings: []`) inside combined `make test`; [Closed findings](../deferred-feedback/README.md#narrow-web-layout-overflow) |
| Single Web/Daemon CLI `--json` cutover, default human templates, `setup.ts` isolation & goldens (`RUN-006`, `RUN-012`, `CLI-001`, `CLI-002`) | `TASK-174` | [web-daemon-goldens.contract.test.ts](../../apps/cli/test/contract/web-daemon-goldens.contract.test.ts), `web-daemon-envelopes.json`, `web.unit.test.ts`, `daemon-commands.unit.test.ts`, `cli-daemon.int.test.ts`, `cli-uninstall.int.test.ts`, `aj11-daemon-lifecycle.e2e.test.ts`, and all 9 updated Web E2E consumers (`data.url`) inside combined `make test`; [Closed findings](../deferred-feedback/README.md#daemon-and-web-cli-json-envelope-alignment) |

All seven confirmed findings are closed under [Closed findings](../deferred-feedback/README.md#closed-findings), `CHANGELOG.md` and [Operations](../ops/README.md#web-and-daemon-cli-json-cutover-and-legacy-root-binding-recovery-adr-0041) are reconciled with the `web --json` `data.url` migration and root-binding recovery guidance, and version bump, installation, and publication remain separately authorized.
