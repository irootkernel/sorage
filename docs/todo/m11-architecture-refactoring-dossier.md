# M11 Architecture Hardening and Modernization Dossier

This temporary dossier guides the M11 refactoring program registered across [EPIC-022](../roadmap/README.md#epic-022-m11-non-breaking-defect-fixes-hot-path-performance-and-v17-indexes), [EPIC-023](../roadmap/README.md#epic-023-m11-golden-preserving-internal-architecture-cleanup) and [EPIC-024](../roadmap/README.md#epic-024-m11-targeted-contract-modernizations-and-qualification) (`TASK-147` through `TASK-167`, intended product release `v0.1.6`). It records the verified code-level findings, rejected shortcuts, baseline measurement protocol, per-Epic SOT adoption boundaries and Task implementation checklists so an independent implementing session can execute cleanly without re-auditing the repository.

Current normative specifications and accepted decisions remain authoritative until each Epic's design-adoption Contract Task accepts or revises its owning ADR. The [roadmap](../roadmap/README.md) alone owns delivery status. When M11 closes, move lasting outcomes into their canonical owners and remove this dossier and its index entry under [the TODO lifecycle rule](README.md).

## 1. Confirmed architectural decisions

Master settled five program-level directions on 2026-11-22 after the full-codebase architecture review and an independent cross-model review of the initial draft:

- **Non-breaking-first M11 ordering (Option 1):** Deliver non-breaking defect fixes, hot-path performance improvements and additive schema-17 indexes first (`EPIC-022`), followed by golden-preserving internal structure cleanup (`EPIC-023`), followed by separately adopted Contract modernizations (`EPIC-024`). Every Epic closes in a releasable state on `main`; no Big-Bang breaking cutover blocks intermediate releases.
- **Self-handoff policy:** Sending a Handoff whose resolved sender Project equals its recipient Project is **forbidden**. `TASK-147` adopts the exact refusal contract (error code, status, exit and fan-out validation rule) in `ADR-0038` and the specifications before `TASK-149` implements it.
- **Channel and Exchange transport boundary:** Both domains remain CLI and MCP only with no Daemon HTTP or Web UI surface, reaffirming `CHN-010` and `ADR-0037` decision 2.
- **Split ADRs for distinct Contract changes:** `ADR-0038` covers non-breaking fixes, `v17` indexes, self-handoff prohibition and internal cleanup; `ADR-0039` covers unifying Daemon HTTP `Idempotency-Key` replay onto Core SQLite receipts; `ADR-0040` covers extracting Web UI assets from template strings into minimal build-time bundled `.ts`/`.css` files.
- **Clean-baseline cutover deferred to `v0.2.0` candidate:** Dropping v0.1.5 runtime compatibility (Formats 1–5, `v1`–`v16` history, `artifacts/` layout) and shipping an offline migrator is recorded in [Future Work](future-work.md#clean-baseline-cutover-and-offline-migrator-v020-candidate) rather than M11. M11 preserves v0.1.5 data compatibility, legacy Format 1–5 restore readers and `ADR-0031` short Artifact IDs.

## 2. Hard constraints and rebutted findings (do not regress)

The independent plan review verified every line reference and caught several false positives or explicit SOT/ADR constraints. Implementing sessions MUST honor all of the following guardrails:

- **Keep `Makefile` `test-prepare` formatting unchanged:** `docs/specs/testing-and-acceptance.md` requires `test-prepare` to run automatic formatting; do not replace `format` with `check:format`.
- **Keep `skills/use-sorage/SKILL.md` tool-scope count at 35:** `use-sorage` scopes to the 35 Handoff, Memo, Channel and Project tools (Exchange ships separately in `start-exchange` and `join-exchange`). Only tighten the imprecise `"published"` phrasing on line 53 so it does not imply only 35 MCP tools exist overall.
- **Keep `handoffs.ts` `idempotencyLookup` expiry cleanup unchanged in M11:** `ADR-0033` (2026-10-21 acceptance clarification on enumerated pre-commit refusal sites) explicitly rejected moving that `DELETE` inside the domain transaction. Do not alter it without a dedicated ADR amendment.
- **Do not bulk-migrate incompatible `BEGIN IMMEDIATE` blocks:** The codebase has ~35 manual transaction blocks. Fence-owner transactions (`packages/adapters/src/intent-log.ts:510,536`), `migrator.ts`, `preflight.ts` and Project repository transactions whose fence semantics differ must NOT be forced onto an unconditional `checkFence: true` helper; add explicit options and migrate only compatible sites.
- **Preserve `ADR-0036` composition boundaries:** Reuse connections and configuration within a single command composition without introducing global singletons, connection pools, DI containers or lifecycle frameworks.
- **Preserve `MCP-002` and `MCP-005`:** `ExchangeKeeper` scheduling stays in the MCP adapter and `exchange session` while lease renew and release remain same-executable CLI child processes, and no domain or storage operation moves into the MCP server process (`MCP-002`); keep all 59 MCP tool names and published schemas golden-identical when refactoring `mcp-catalogue.ts` onto `defineMcpTool()` (`MCP-005`).
- **Focus cycle elimination on the real runtime cycles:** Only `content-store.ts <-> intent-log.ts`, `project-commands.ts <-> workspace-identity.ts`, `channel-snapshot.ts <-> content-snapshot.ts` and, found by the 2026-11-24 refinement, daemon `index.ts <-> runtime.ts` are runtime import cycles; type-only (`import type`) cycles are benign and need not distort module boundaries.
- **Do not invent SQL-injection claims or chase micro-optimizations:** `terminal-commands.ts` / `retention-commands.ts` pass code-literal column names (layering smell, not injection — fix via typed domain mutation unions and `ASSIGNABLE` whitelisting); `mcp-server.ts:74` `parseTrailingEnvelope` is $O(N \cdot \text{depth})$ in practice and is low priority.

## 3. Verified defect and hotspot inventory

This section records the pre-work baseline captured at registration before `EPIC-022` began (`HEAD` `f842225`). All `EPIC-022` rows (`TASK-147`–`TASK-154`) were completed by commit `577b78d`; their entries are preserved here as historical baseline context while [section 7](#7-epic-023-execution-specification) owns current `EPIC-023` execution.

### 3.1 Confirmed defects

| Ref | Severity | Exact location | Confirmed behavior and required fix | Owning Task |
|---|---|---|---|---|
| `#1` | Contract bug | `apps/daemon/src/domain-routes.ts:1122-1127` | `archive`, `unarchive` and `deletion-reject` force `{ ...base, asUser: true }`, bypassing `retention-commands.ts:142-147` `requireUser` for `?as=<slug>` callers (violates `interfaces-and-operations.md` §9.2; note under `SEC-013` this is a contract bug rather than an OS privilege escalation). `deletion-reject` also drops `body.reason` (`retention-commands.ts:570`). Remove `asUser: true` overrides and forward `reason`. | `TASK-148` |
| `#2` | High | `apps/daemon/src/domain-routes.ts:762-766` | `POST /api/v1/handoffs/{id}/revise` sets `idempotent: true` without `idempotencyBodyLimit: uploadReplayLimit`, silently capping multipart revise uploads at 1 MiB (`server.ts:394,605`) instead of `artifact.maxBytes`. Add `idempotencyBodyLimit: uploadReplayLimit`. | `TASK-148` |
| `#10` | High | `apps/cli/src/main.ts:470-474,2701-2721,3385-3401` | Daemon-routed `config set` bypasses the `--as-user` check (unlike direct path `config-commands.ts:91`), drops `--expected-revision` and breaks human output rendering. Restore full parity with direct `config set`. | `TASK-148` |
| `#11` | Medium | `apps/daemon/src/server.ts:411-416`, `apps/daemon/src/domain-routes.ts:1339-1344` | `readJsonBody` swallows malformed JSON syntax and returns `{}`, silently dropping optional `expectedRowVersion` guards (unlike strict `readReportJsonBody`). Reject invalid JSON syntax with a typed 400/422 error. | `TASK-148` |
| `#3` | High | `packages/adapters/src/vault-command-ports.ts:723-739` | `logVaultMoved` ignores injected `options.env`/`options.userHome` and reads `process.env.SORAGE_HOME` / `homedir()` directly (masked by `vault-move.int.test.ts:38`). Use the instance's `home` and structured logger. | `TASK-149` |
| `#4` | Low (latent) | `packages/adapters/src/channels.ts:690-694` | `stageAccepted` calls `captureMemoBodyText` without `codes: CHANNEL_BODY_CAPTURE_CODES` (currently shielded by `checkChannelBodyText` in `core/channels.ts:1073-1075`). Pass `CHANNEL_BODY_CAPTURE_CODES` and replace hardcoded `65_536` in `memo-body-file.ts:171` with `CONTENT_INLINE_MAX_UTF8_BYTES`. | `TASK-149` |
| `#7` | Medium | `packages/adapters/src/config-command-ports.ts:38` | `env.EDITOR?.trim() !== ""` evaluates `undefined !== ""` as `true`, passing `undefined` to `spawnSync` instead of `"vi"`. Fix with `env.EDITOR?.trim() \|\| "vi"`. | `TASK-149` |
| `#8` | Medium | `packages/adapters/src/daemon-command-ports.ts:134` | `acquireDaemonLock` wraps release with unconditional `releaseLock` instead of returning owner-checked `acquisition.release` (`lockfile.ts:145,205`). Return `acquisition.release`. | `TASK-149` |
| `#9b` | Low | `packages/adapters/src/backup-command-ports.ts:1365-1376` | `adoptMarker` leaves `.sorage-vault.json.tmp-${process.pid}` behind on error, causing same-process retry `EEXIST` under `wx`. Clean up in `finally` (or use shared `fs-atomic.ts`). | `TASK-149` |
| `self-handoff` | Contract | `packages/core/src/handoff-commands.ts`, `handoff-read.ts:817`, `revision-commands.ts:132`, `terminal-commands.ts:51`, `retention-commands.ts:113`, `reporting-commands.ts:94` | Sending a Handoff to the same resolved Project creates ambiguous role resolution (first fetch unrecorded, withdraw blocked). `TASK-147` forbids self-handoff in SOT; `TASK-149` enforces the refusal and unifies role resolution. | `TASK-147`, `TASK-149` |
| `#5` | High | `apps/daemon/src/web-app.ts:283-305` | `renderMarkdownSafe` escapes `&`, `<`, `>` into HTML entities and then passes the string to `el(..., { text })` (`textContent`), double-escaping Markdown in browsers. Remove redundant entity escaping and update pinned source assertion `apps/daemon/test/int/domain-routes.int.test.ts:655-657`. | `TASK-150` |
| `#6` | Medium | `apps/daemon/src/web-app.ts:318,385,476,504+,853,1109-1113`, `web-memos.ts:377-398` | Unencoded URL/filter interpolation (breaks values containing `+` or `&`), broken object-identity dedup in `backupPage` (`runs.indexOf(row)` instead of `run.id`), client-side census truncation at `limit=200`/`50` without pagination/summary, and un-debounced per-keystroke Memo preview rebuild. | `TASK-150` |
| `#12a` | Low | `apps/cli/package.json:6-7` | `"main"` and `"types"` point to nonexistent `./src/index.ts` instead of `./src/main.ts`. | `TASK-167` |
| `#12d` | Low | `apps/cli/src/completion.ts:21-82` | Hidden `daemon serve` leaks into zsh completion (`send-recovery-completion-zsh.txt:122` golden must update alongside), and only `send` gets subcommand option completions. | `TASK-160` |

### 3.2 Verified performance and structural hotspots

- **Startup `migrator` write-lock storm (`TASK-151`):** `packages/adapters/src/sqlite/migrator.ts:152` checks `rebuilds.length > 0` instead of whether any pending migration is unapplied; because `productionMigrationPlan()` (`sqlite/migrations.ts:1166`) always registers rebuilds 9 and 10, every writable CLI command opens a 3rd connection, toggles `PRAGMA foreign_keys`, and acquires `BEGIN IMMEDIATE` (a single `revise` opens ~6 DB connections and 2 empty write locks). Early-return when `toApply.length === 0`, and only use `migrateRebuildBatch` when pending steps include a rebuild. Also fix redundant config reads/store builds in `handoff-command-ports.ts`, `inbox --wait` per-page storage reopens (`apps/cli/src/main.ts:1137,2973`), fan-out `inboxMarker` handle leaks (`apps/cli/src/main.ts:1085`), and missing `.close()` on Handoff/Project ports.
- **Missing secondary/FK/sort indexes (`TASK-152`, schema `v17`):** Append-only `v17` migration under `SHR-009` adding indexes on `content_records(storage_key) WHERE storage_key IS NOT NULL`, `pending_fs_ops(op, to_path)`, `project_memos(content_record_id)`, `handoffs(recipient_project_id, updated_at DESC, id DESC)`, `handoffs(sender_project_id, updated_at DESC, id DESC)`, `handoffs(updated_at DESC, id DESC)`, `events(created_at DESC, id DESC)`, `exchange_claims(project_id)`, `exchange_notice_claims(project_id)`, `exchange_materials(content_id)`, `exchange_cleanup_items(content_id)`, and `idempotency_keys(scope, expires_at)`. Also add `"exchange"` to `SchemaSurface` in `packages/core/src/known-schemas.ts:65`.
- **Daemon event-loop blocking — #1 runtime latency issue (`TASK-153`):** `apps/daemon/src/runtime.ts:154-233` runs synchronous `spawnSync("git", ...)` (up to 60s on `git push` via `git-client.ts:28`) and synchronous `readFileSync` (up to 64+ MiB via `daemon-command-ports.ts:195-208`) on the HTTP event loop, triggering browser 15s Memo timeouts (`web-memos.ts:88`). Offload backup runs asynchronously, stream sweep hashes with `createReadStream` and cached `vaultPath`/DB, skip `spoolRequestBody` whenever `Idempotency-Key` is absent (`server.ts:600`), migrate `upload.ts` to `push-sink` to delete `engine-spool` and fix `multipart-engine.ts:308` $O(N^2)$ text buffering, and cache API token mtime/stat with session pruning on rotation in `auth.ts`.
- **Exchange, read-path and diagnostics I/O (`TASK-154`):** Cut Exchange activation hashing from 5× to 1–2× via `dev:ino` check (`exchange-working-store.ts:111-146`) and eliminate `planRead` $O(S^2 / 64\text{ KiB})$ full-file re-hashing (`exchange-working-store.ts:607-629`, `exchange-sources.ts:169-180`); fold `handoff-read-store.ts:196-256` `1 + 6N` queries into one `LEFT JOIN`; switch `content-store.ts:1156-1237` `removeContentRecordInTx` to point-lookup `EXISTS`; switch `preflight.ts:974,1366` to 100-byte header read + streaming hash; combine Memo query scan + head preview into one pass and route oversized text directly through `stageBytes`; cache `DoctorContext` (single DB/config/registry, deduplicated checksum sweep, $O(B \log B)$ binding checks).
- **Internal architecture cleanup (`EPIC-023`, `TASK-155`–`TASK-160` and `TASK-165`–`TASK-167`):** Extract zero-cycle `packages/core/src/primitives/` and break every runtime cycle with a permanent `check:cycles` gate, purify `core` from SQL column names, macOS plist, Git CLI and POSIX/YAML mechanics, unify adapter atomic-write, maintenance, transaction and Git-spawn infrastructure, return leaked domain rules to `core`, split the God files, add a lazy `main.ts` bootstrap so `exchange renew` stops loading `@sorage/daemon`, unify `mcp-catalogue.ts` onto `defineMcpTool()`, flatten V5 export onto single-pass `SnapshotDomainCodec<T>` behind new characterization goldens while keeping Format 1–5 restore readers, reorganize `core` into bounded directories and add package `"exports"` maps with a separate `@sorage/adapters/testkit`. [Section 7](#7-epic-023-execution-specification) is the per-Task execution specification.
- **Targeted Contract modernizations (`EPIC-024`, `TASK-161`–`TASK-164`):** `TASK-161` adopts `ADR-0039` after a complete 6-operation Core Receipt inventory and retires `idempotencyStore` + splits `domain-routes.ts` / `http-kit.ts`; `TASK-162` adopts `ADR-0040` and extracts `web-app.ts` + `web-memos.ts` into real `.ts`/`.css` assets with minimal Bun bundling hooked into `test-prepare` and `build:cli`.

## 4. Pre-work performance baseline protocol (`TASK-147`)

Before `TASK-148` modifies any product code, `TASK-147` records reproducible baseline measurements on the unmodified v0.1.5/main binary and stores them in `docs/implementation-tips/m11-qualification.md` (or a dedicated baseline section promoted at closeout):

1. **DB opens and write locks per command:** Count SQLite opens and `BEGIN IMMEDIATE` acquisitions for a single `sorage send`, `sorage revise` and `sorage doctor` against an up-to-date schema-16 home.
2. **Handoff listing query count:** Count SQL statements executed by `handoff-read-store.ts:listPage` for a 50-Handoff page.
3. **Daemon event-loop latency under backup/sweep:** Measure `GET /api/v1/health` latency while a slow `git push` (simulated delay) and a 64 MiB artifact sweep run in the daemon.
4. **Exchange paged retrieval I/O:** Measure bytes read and elapsed time to paginate a 10 MiB Exchange material in 64 KiB pages via `planRead`.
5. **CLI `exchange renew` startup overhead:** Measure cold spawn latency of `sorage exchange renew` before and after lazy-loading `@sorage/daemon`.

`TASK-151`, `TASK-153`, `TASK-154`, `TASK-159` and `TASK-163` verify their improvements directly against these recorded baselines.

## 5. Per-Epic SOT adoption map

Each Epic's first Contract Task adopts only its own scope instead of front-loading every M11 Task's SOT edits at once (`TASK-147` completed the `ADR-0038` row below before `EPIC-022` began; `TASK-161` and `TASK-162` remain staged for `EPIC-024`):

| Adopting Task | ADR adopted | Canonical SOT files and decisions updated |
|---|---|---|
| `TASK-147` (`EPIC-022` & `EPIC-023`) | `ADR-0038` | `docs/architecture-decision-records/README.md` (accept `ADR-0038`; dated amendment to `ADR-0036` if needed for M11 scope), `docs/specs/required-specification.md` (self-handoff refusal rule + `v17` index note), `docs/specs/interfaces-and-operations.md` (self-handoff error, §9.2 retention/`reason`, strict JSON body, routed `config set` parity, schema `v17`), `docs/architecture/README.md` (self-handoff & schema `v17`), `docs/specs/testing-and-acceptance.md` (Gate M11), `docs/roadmap/README.md` (Gate M11 row + `EPIC-022`/`EPIC-023` Requirements cells), `docs/specs/traceability.md` (matching reverse index). |
| `TASK-161` (`EPIC-024`) | `ADR-0039` | `docs/architecture-decision-records/README.md` (accept `ADR-0039`; dated amendment to `ADR-0027`), `docs/specs/required-specification.md` (amend `MEM-013` legacy Handoff replay sentence), `docs/specs/interfaces-and-operations.md` (amend §17.3 replay semantics), `docs/architecture/README.md` (amend §3.9 idempotency paragraph), `docs/specs/project-memos.md` (amend line 146 legacy Handoff replay clause), `docs/roadmap/README.md` (`TASK-161` Requirements) and `docs/specs/traceability.md`. |
| `TASK-162` (`EPIC-024`) | `ADR-0040` | `docs/architecture-decision-records/README.md` (accept `ADR-0040`; dated amendments to `ADR-0016` 2026-10-28 frontend note, `ADR-0027` and `ADR-0036`), `docs/architecture/README.md` (§15 Web asset source + build embedding), `docs/specs/testing-and-acceptance.md` (§1 tooling / `test-prepare` Web asset generation), `docs/roadmap/README.md` (`TASK-162` Requirements) and `docs/specs/traceability.md`. |

## 6. Verification and review policy

All M11 Tasks execute sequentially under [governance section 7](../governance/README.md#7-active-slot-rule) and verify proportionally under [governance section 18.1](../governance/README.md#181-proportionate-verification-and-review): focused unit/integration/failure-path checks per Task, golden-unchanged assertions throughout `EPIC-023` (except the reviewed `TASK-160` completion golden updates and the new `TASK-165` characterization goldens, as [section 7.1](#71-rules-for-every-epic-023-task) defines), independent review for every Standard and Contract Task, and one complete `make test` + `bun run check:sot` + v0.1.5 upgrade/restore/rollback qualification owned by `TASK-163`.

## 7. EPIC-023 execution specification

This section is the execution checklist for the nine `EPIC-023` Tasks after the [2026-11-24 execution refinement](../governance/README.md#epic-023-execution-refinement-2026-11-24). It fixes the design decisions an implementing Task Operator would otherwise have to invent, names the oracle for every acceptance claim and lists the stop conditions. The [roadmap](../roadmap/README.md#epic-023-m11-golden-preserving-internal-architecture-cleanup) rows remain the acceptance authority; when this section disagrees with a higher-authority document, stop the Task and record the conflict instead of choosing.

Line numbers were taken at commit `577b78d` (the `EPIC-022` closeout). Earlier `EPIC-023` Tasks move code, so locate each site by its file and symbol and treat the line number only as a hint.

### 7.1 Rules for every EPIC-023 Task

**Order and Squad risk.** Tasks run strictly in this order. The risk column sets the first Squad plan and result panels: standard means the Task Evaluator plus one independent Task Operator, and elevated means the Task Evaluator plus two. No additional technical review route is selected.

| Order | Task | Squad risk | Reason |
|---|---|---|---|
| 1 | `TASK-155` | standard | Moves pure helpers and adds a check script; no persistence or lifecycle change. |
| 2 | `TASK-156` | elevated | Changes core ports for Handoff persistence, backup Git, configuration files and the LaunchAgent. |
| 3 | `TASK-157` | elevated | Touches crash safety, transactions, the Vault move fence and garbage collection. |
| 4 | `TASK-158` | elevated | Touches commit-time sender identity revalidation, Project binding rules and Exchange claims. |
| 5 | `TASK-159` | elevated | Changes CLI process bootstrap, self-invocation and the Exchange keeper child processes. |
| 6 | `TASK-160` | standard | Rebuilds MCP declarations against a byte-exact golden and adjusts completion and polling. |
| 7 | `TASK-165` | elevated | Rewrites backup snapshot export and restore validation. |
| 8 | `TASK-166` | standard | Mechanical file moves and two monolith splits inside core. |
| 9 | `TASK-167` | standard | Package manifests and check scripts; verified by the complete `make test`. |

**Behavior is frozen.** CLI, HTTP and MCP output, error codes, messages, recovery text, exit codes, database schema and snapshot bytes do not change. Never regenerate or edit an existing golden (`apps/cli/test/contract/golden/`, `packages/core/test/contract/golden/` and every other golden or fixture); a golden diff means the code is wrong. The only exceptions are the reviewed `TASK-160` completion goldens and the new goldens that `TASK-165` creates before it refactors. A new test may be added; an existing assertion may change only when it names a symbol or path that moved, with its meaning and strength unchanged.

**Moving code.** Move a symbol under its current name unless this section names a new one. Update every importer in `src` and `test` instead of leaving forwarding re-exports, except where this section keeps an alias on purpose. `packages/core/src/index.ts` must retain every pre-Task runtime export name except explicitly listed removals (`TASK-156` removes LaunchAgent mechanics, Git CLI mechanics, and the moved `config.ts` YAML/probe codec exports `probeConfigurationPath`, `parseConfigurationFile`, `loadConfiguration`, `serializeConfiguration`, `emptyConfigurationDocument` and `applyConfigurationToDocument`), and any newly added public export name must match the Task's explicitly listed additions (`TASK-155` new primitives; `TASK-156` `BackgroundServicePort`, `VaultGitRepository`, `AsyncVaultGitRepository`, `ConfigTextCodec`, `TerminalTransition`, `RetentionChange`; `TASK-158` `revalidateSenderAtCommit`, `findBindingConflict`; `TASK-159` init orchestration; `TASK-165` `SnapshotDomainCodec`). Compare before and after export-name sets with `bun -e 'const m = await import("./packages/core/src/index.ts"); console.log(Object.keys(m).sort().join("\n"))'` and diff against the Task's allowed delta. Move files with plain `mv`, never `git mv`, because staging needs Master's explicit instruction; only the Coordinator stages and commits through `task-commit`.

**Verification.** Every Task runs `make test-prepare` (it formats files, so run it before freezing a candidate), then the focused suites named in its subsection through `bun run test:unit`, `bun run test:contract`, `make test-int` and `make test-e2e` with path filters where the script accepts them. Focused checks are never reported as the full gate. `TASK-167` runs the complete `make test` (Gaori command `test`, 3,600-second timeout). Under [governance section 18.1](../governance/README.md#181-proportionate-verification-and-review), the Squad's integrated `EPIC-023` Validation reuses `TASK-167`'s `make test` evidence when the assembled candidate inputs are unchanged and re-runs `make test` if any integration correction changes code, tests or build inputs; the independent Epic Evaluator and two fresh non-authoring Task Operator integration assessments remain separately required in either case. Tests never touch the real `~/.sorage`; set `SORAGE_HOME` to a temporary directory.

**Stop conditions.** Return to the Coordinator instead of improvising when a refactor would change any observable behavior, when a fixed decision below does not fit the code you find, when a golden differs, when a new runtime cycle appears, or when a test can only pass by weakening an assertion, timeout or test selection. Record independent improvements in [deferred feedback](../deferred-feedback/README.md) rather than widening the Task.

### 7.2 TASK-155: primitives and runtime cycles

**Fixed decisions.**

- Create `packages/core/src/primitives/` with these modules and export them from `packages/core/src/index.ts`. Every existing runtime export name stays in `@sorage/core` (including `memoObject` and the `memos.ts` aliases below); the allowed new runtime exports from `packages/core/src/index.ts` are `isCanonicalUuid`, `isCanonicalUtcTimestamp`, `isPlainObject`, `remainingMs`, `sleepWithinDeadline`, `emitCompletionWarning` and `discloseLargeContent`. Each primitives module may import only `node:crypto`, `../errors` and another primitives module, without cycles. Update all `src` and `test` importers directly rather than keeping forwarding re-exports, except the two explicit `memos.ts` aliases below.
  - `identity.ts` (distinct from existing `packages/core/src/ids.ts`, which `TASK-166` moves into `primitives/ids.ts` without collision): `workspaceKey` (from `workspace-identity.ts`), `isCanonicalUuid` (the body of `isMemoUuid` in `memos.ts`, identical to `isUuidShape` in `content.ts`) and `isCanonicalUtcTimestamp` (the body of `isMemoTimestamp`). `memos.ts` keeps `isMemoUuid` and `isMemoTimestamp` as aliases because the Memo domain names them; non-Memo importers switch to the neutral names. Do not merge `isChannelUuid` (versions 1–5 only) or the case-insensitive UUID patterns in `send-recovery.ts` and `config.ts`.
  - `validation.ts`: keep the public export name `memoObject` for the exact-keys object guard (replacing `exactKeys` in `preflight.ts` and keeping `memoObject` exported for existing callers/tests), one `isPlainObject` replacing `isPlainObject` in `memo-protocol.ts` and `backup-snapshot.ts` and `isRecord` in `preflight.ts` and `send-recovery.ts`, plus `utf8ByteLength`, `sha256OfText` and `sha256OfBytes` from `content.ts`.
  - `json.ts`: `canonicalJson`, `canonicalJsonLine` and `sortKeys` from `backup-snapshot.ts`, and `parseUniqueSnapshotJson` from `memo-snapshot.ts` with its `VAULT_INTEGRITY_ERROR` code.
  - `polling.ts`: `remainingMs(deadlineMs, nowMs)` and `sleepWithinDeadline(...)`, used by `waitForChannelMessages` (`channels.ts`), `waitForExchangeActivity` (`exchange-wait.ts`) and the inbox wait in `handoff-read.ts`. The retryable-failure predicate stays a parameter because Exchange retries a narrower set.
  - `disclosures.ts`: define two shapes so retention wiring needs no unused fields — `CompletionWarningSink` (`{ completionWarning?(text: string): void }`, used by `retention-commands.ts` where `handoff-command-ports.ts` injects only `completionWarning`) and `LargeContentDisclosurePorts extends CompletionWarningSink` (`{ backupEnabled: boolean; thresholdBytes: number; largeContent(sizeBytes: number, thresholdBytes: number): void }`, used by `handoff-commands.ts`, `revision-commands.ts`, `channels.ts` and `memo-commands.ts`) — plus the throw-containing helpers `emitCompletionWarning(sink, text)` and `discloseLargeContent(ports, sizeBytes)` without changing any message text.
- Break the runtime cycles this way:
  - Core `project-commands.ts` <-> `workspace-identity.ts`: `project-commands.ts` imports `workspaceKey` from `primitives/identity.ts`.
  - Core `channel-snapshot.ts` <-> `content-snapshot.ts`: move `SnapshotBodyContent`, `ParsedBodyContent`, `parseSnapshotBodyContent` and `memoContentFilePath` from `content-snapshot.ts` into `memo-snapshot.ts`. `channel-snapshot.ts` may keep its `import type` from `content-snapshot.ts`.
  - Adapters `content-store.ts` <-> `intent-log.ts`: create `packages/adapters/src/sqlite/move-fence.ts` holding `FenceRow`, `pidIsAlive` and `liveFencePaused`, and `packages/adapters/src/fs-atomic.ts` holding `fsyncDirectory`. Move `isSafeVaultRelativePath` into `managed-paths.ts`, which imports only Node modules. Repoint `content-store.ts` and `sqlite/transaction.ts` to the new modules. `TASK-157` extends both files.
  - Daemon `index.ts` <-> `runtime.ts`: `runtime.ts` imports `createDaemonServer` from `./server` and uses `SORAGE_VERSION` from `@sorage/core` instead of `DAEMON_VERSION` from `./index`. `index.ts` keeps exporting `DAEMON_VERSION`.
- Remove `memos.ts`'s runtime import of `./content` by using the primitives. Replace `memo-protocol.ts`'s `import type { Project }` with a local structural `MemoProjectRef` (`id`, `slug`, `displayName`, `status: "active" | "archived"`).
- Add `scripts/check-cycles.ts`. Follow the style of `scripts/check-import-boundaries.ts` and parse with the pinned `typescript` package. It builds one graph over the `src` trees of all four packages, resolving relative specifiers (`.ts`, then `/index.ts`), `@sorage/<pkg>` to that package's `src/index.ts`, and `@sorage/<pkg>/src/*` subpaths (which `apps/cli` and `apps/daemon` actually import). Any unresolved relative or `@sorage/*` specifier MUST fail the check rather than being silently ignored. It ignores type-only imports and exports, including `import { type A }` where every element is type-only, and `import("x").T` type nodes. It counts `export … from`, `export * from` and real dynamic `import()` calls as runtime edges. It reports each strongly connected component and exits 1, or prints a pass line. Register `"check:cycles": "check-cycles.ts"` in the `scripts` map of `scripts/toolchain.ts`, add `"check:cycles": "/bin/sh scripts/toolchain.sh script check:cycles"` to `package.json` and run it in `make test-prepare` right after `check:import-boundaries`. Add unit tests with both a seeded two-file intra-package cycle fixture and a cross-package cycle fixture (via `@sorage/*` subpath), plus an unresolved-specifier failure fixture.
- `backup-schedule.ts`: cache the two `Intl.DateTimeFormat` constructions in `offsetOf` and `wallOf` in module-level `Map`s keyed by time zone.
- `handoff-read.ts`: in `collectFreshInboxItems` use `const fresh` with `push`. `validateBounds` returns a normalized copy (`{ ...filters, updatedSince, updatedUntil }`) and every later use of `query.filters` in `runListing` and `waitForNewInboxItems` uses that copy, so cursor identity (`filterIdentity`) and whole-second inclusivity do not change.

**Verification.** `bun run check:cycles` passes and fails on the intra-package, cross-package and unresolved-specifier fixtures. Core unit and contract suites pass, as do `apps/cli/test/int/cli-date-filter.int.test.ts`, `apps/daemon/test/int/date-filter.int.test.ts` and `apps/daemon/test/int/backup-scheduler.int.test.ts`, plus the Channel, Exchange-wait, snapshot and content-store integration suites touched by the moves. New unit tests: repeated `backup-schedule` calls across several zones, including the existing DST cases, return identical results; `validateBounds` leaves the caller's filter object unchanged.

**Documentation.** Add `check:cycles` to the `test-prepare` row in [testing-and-acceptance section 1](../specs/testing-and-acceptance.md), to the [implementation tips](../implementation-tips/README.md) package-rule and check sections and to the [toolchain guide](../implementation-tips/toolchains.md).

### 7.3 TASK-156: core purification

**Fixed decisions.**

- Typed mutations. In core, `TerminalMutationPort.applyTerminalTransition` takes `{ handoffId, expectedRowVersion, transition, at, event }`, where `transition` is `{ kind: "accept"; acceptedRevision: number } | { kind: "decline"; reason: string } | { kind: "withdraw" }`. `RetentionMutationPort.applyRetentionMutation` takes `{ handoffId, expectedRowVersion, change, at, events }`. `change` is one of these:
  - `pin`, `unpin`, `archive` or `unarchive`;
  - `{ kind: "deletion-request"; requestId; requestedByKind; requestedById; reason }`;
  - `{ kind: "deletion-approve"; removeContent; unlinkIntent?; idempotency? }`;
  - `{ kind: "deletion-reject"; resolutionNote }`.
- Adapter mapping. `createSqliteTerminalStore` and `createSqliteRetentionStore` in `packages/adapters/src/handoffs.ts` map each kind to a fixed column list with an exhaustive `switch` whose `default` returns `INTERNAL_ERROR`. Each column list is typed `readonly HandoffAssignment[]`. Keep every current side effect:
  - accept, decline and withdraw deactivate review notes;
  - deletion-request inserts the request row;
  - deletion-approve resolves the request as approved, removes content, writes the optional unlink intent and records idempotency;
  - deletion-reject resolves the request as rejected;
  - every timestamp, including `requested_at`, `resolved_at` and `created_at`, comes from `at`, which removes the `new Date()` fallbacks.

  Update `epic-remediation.int.test.ts` and `failure-injection.int.test.ts` to the new input shape. Leave `createSqliteHandoffRowStore` and `ASSIGNABLE` to `TASK-157`.
- LaunchAgent. Move all of `packages/core/src/launchagent.ts` (label, plist filename, target, escaping, rendering and install/uninstall orchestration) into `packages/adapters/src/launchagent-ports.ts`, and move its unit tests to an adapter test.
  - Core `uninstall.ts` depends on a semantic `BackgroundServicePort` with `install({ program, sorageHome })` and `uninstall()`.
  - `UninstallPorts` loses `agentsDirectory` and `uid`, which the adapter factory takes instead.
  - Init and uninstall output keep the field names `plistPath`, `wasLoaded`, `plistRemoved` and `bootstrapped`, and the label `xyz.rootkernel.sorage` (`RUN-011`).
- Git. Core keeps the managed-path policy (`MANAGED_PATHSPECS`, `isManagedVaultPath`, `unmanagedStagedPaths` and `isRuntimeTrackedPath`).
  - Move `GitRunRequest`, `GitRunOutcome`, `GitClient`, `AsyncGitClient`, `GIT_TIMEOUT_MS`, `GIT_BATCH_ENV`, `GIT_ARGS`, `gitInvocationError`, `gitStateConflict`, `classifyPushFailure` and the authentication patterns to adapters (`git-client.ts` or a new `vault-git-repository.ts`). Delete the unused `GIT_ARGS_PUSH`.
  - `backup-commands.ts` depends on a `VaultGitRepository` port, plus an `AsyncVaultGitRepository` mirror for the async run path, with these operations: `initialize(branch)` (including `core.autocrlf=false`), `autocrlf()`, `currentBranch()`, `stagedPaths()`, `trackedPaths()`, `stageManaged()`, `hasStagedManagedChanges()`, `commit(message)` and `push({ remote, branch })`.
  - Preserve the exact return semantics of both `commit(message)` and `push({ remote, branch })` in sync and async variants:
    - `commit(message)`: if `git commit` spawn fails return `err(gitInvocationError)`; if `git commit` exits non-zero return `err(gitStateConflict("commit", outcome))`; once `git commit` exits `0`, run `git rev-parse HEAD` — if `rev-parse` spawn fails return `err(gitInvocationError)`, if `rev-parse` exits `0` return `ok({ sha: stdout.trim() })`, and if `rev-parse` exits non-zero return `ok({ sha: null })` (a committed backup still succeeds with `commitSha: null`).
    - `push({ remote, branch })`: uses `git push --atomic <remote> <branch>`; spawn/timeout failure returns `err(gitInvocationError)`, non-zero exit maps through `classifyPushFailure` (`GIT_AUTH_REQUIRED` vs `GIT_BACKUP_CONFLICT`).
  - Error text stays byte-identical: `git <context> refused: <stderr or exit N>.` with `{ exitCode }`, and both push failure messages.
  - Rewrite the backup Git, push and run unit tests to use semantic fakes covering all three `commit` HEAD-lookup outcomes and both push failure classifications.
- Configuration. Core keeps `Configuration`, defaults, `validateConfiguration`, `expandConfigurationPath`, `ConfigurationPathProbe`, `configurationPathState` and the `CONFIG_ACCESS_REPAIR` and `CONFIG_PATH_REPAIR` constants unchanged.
  - Move `probeConfigurationPath` and every `yaml` `Document` and `parseDocument` use (`parseConfigurationFile`, `loadConfiguration`, `serializeConfiguration`, `emptyConfigurationDocument`, `applyConfigurationToDocument`) to an adapters configuration codec beside `config-store.ts`.
  - Expose `probeConfigurationPath` to `apps/cli/src/main.ts` (`existingConfiguration`) through `config-command-ports.ts` (or `init-ports.ts`), both already in `APP_ADAPTERS_ALLOWLIST["@sorage/cli"]`, so `check:import-boundaries` stays green.
  - `config-commands.ts` parses text through an injected `ConfigTextCodec` (`parse(text)`) or equivalent store method, keeping the `yaml: <messages>` error detail.
  - Replace the `node:path` `join` in `config.ts` with string concatenation, remove `yaml` from `packages/core/package.json` and run `make deps-lock` so `bun.lock` stays consistent with `bun install --frozen-lockfile` in `make test-prepare`.
  - Move the comment-preservation round-trip tests to adapters (`CFG-018`).
- Clock. `ChannelWaitOptions` gains `clock: Clock` (from `ids.ts`), and `waitForChannelMessages` computes the remaining time from `options.clock.now()`. `apps/cli/src/channel-commands.ts` passes a `SystemClock`. The real-sleep case in `channels-wait.unit.test.ts` switches to a fake clock advanced by `sleepMs`.
- Portable path check. In `exchange-collaboration-snapshot.ts`, `root` must start with `/` and `relativePath` must not; drop the `node:path` import. Add tests for a non-absolute root and an absolute relative path.

**Purity greps (must print nothing).**

```sh
grep -rnwE 'review_state|accepted_revision|accepted_at|declined_at|decline_reason|withdrawn_at|archived_at|deleted_at|updated_at|current_artifact_id|row_version|first_fetched_at|review_engaged_at|consecutive_no_change_resolutions' packages/core/src | grep -vE ':[0-9]+:[[:space:]]*(\*|/\*|//)'
grep -rnE '\b(SELECT|INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM)\b' packages/core/src
grep -rnE '<\?xml|<plist|<!DOCTYPE|<dict>|<true/>|launchctl|\bbootout\b|gui/|RunAtLoad|ProgramArguments' packages/core/src
grep -rnE 'args:[[:space:]]*\[|GIT_ARGS|\brunGit\b|\["(add|commit|push|init|config|diff)"|"(symbolic-ref|rev-parse|ls-files|--cached|--atomic|--name-only|--quiet|--local|--get|--short)"|user\.(name|email)=' packages/core/src
grep -rnE 'Date\.now\(\)|performance\.now\(\)' packages/core/src
grep -rnE 'new Date\(\)' packages/core/src | grep -v 'src/ids.ts'
grep -rnE 'from "(yaml|node:(path|fs|os|child_process))"|NodeJS\.ErrnoException|"E(NOENT|LOOP|ACCES)"' packages/core/src
```

Snake-case domain enum values (`registered_project`, `awaiting_recipient`, `changes_requested` and similar) are not columns and are not matched by these greps. `SystemClock` in `ids.ts` is the legitimate wall-clock source.

**Verification.** `make test-prepare` (including `bun install --frozen-lockfile`), core unit and contract suites. Adapter integration suites for terminal and retention transitions, backup run, push and verify, configuration store, LaunchAgent, Channel wait and Exchange commands. CLI integration suites for `config`, `init`, `uninstall` and `doctor`. `test/e2e/vault-open-guidance.e2e.test.ts`.

### 7.4 TASK-157: adapter infrastructure

**Fixed decisions.**

- `fs-atomic.ts` exports `fsyncDirectory`, `writeFileAtomic(path, bytes, options)`, `copyFileHashed(source, destination, options)` and `placeExclusive(path, bytes, options)`.
  - Options make each site's current behavior explicit: temporary name (`uuid` or `pid`), file `fsync` on or off, directory `fsync` (`required`, `best-effort` or `none`), creation and final mode, `O_NOFOLLOW`, and for copies `exclusive-direct` or `temp-rename`.
  - `placeExclusive(path, bytes, options)` (unifying `placeChannelContentFile` in `backup-command-ports.ts` and `placeMemoContentFile` in `memos.ts`) MUST preserve every durability invariant: `O_EXCL | O_NOFOLLOW` creation at `0644`, `fchmod` to `0444`, file `fsync`, ancestor directory `fsync` of **every directory from the target's parent up to `syncAncestorsTo` (`managedRoot`)**, post-placement read-back verification of exact byte length and SHA-256 before returning success, cleanup of **only the file created by this call** on error (never unlinking a pre-existing file on `EEXIST`), and domain-specific error mapping preserved per caller.
  - Migrate these sites and keep each one's behavior: `vault.ts` `writeExact`, `token-store.ts`, `inbox-marker-ports.ts`, `daemon-command-ports.ts` `atomicWrite`, `backup-command-ports.ts` `adoptMarker` and `streamCopy`, `vault-command-ports.ts` `streamCopy` and `writeMoveScratchMarker`, `content-store.ts` `materializeFetchCacheFile`, `placeChannelContentFile` and `placeMemoContentFile`, and `exchange-stage-owners.ts`.
  - Keep `config-store.ts` `swapIn` (its `.bak` sequence), `writeSnapshotTree` (a directory swap) and `lockfile.ts` `writeExclusive` (hard-link publication) as they are.
- `maintenance.ts` exports:
  - `runStartupMaintenance(db, options)`: intent drain, content cleanup, GC only when every live-key read succeeded, then the fetch-cache sweep. Its options include `classify` for error mapping and `liveStorageKeys` as a caller-supplied function.
  - `acquireVaultMoveLock(home, clock)`.
  - `recordedContentKeys(db)`.

  The Vault caller keeps its materialized-only, table-checked storage-key query and contention classification. The backup caller keeps its unfiltered query.
- `openAdapterContext(options)` is command-local (`ADR-0036`, zero caching across calls), returns a no-op `close()` for any borrowed `database`, closes an owned `database` in `catch` if a later step (such as configuration read) fails without masking the original error, and preserves the exact error ladder (schema admission, carried `AppCommandError`, contention for surfaced calls, `INTERNAL_ERROR`). Every factory MUST keep its exact current open order, config-read mode, borrowed-handle support and throw-vs-`Result` contract from the table below:

| Module / Factory | Open order & DB handling | Config read & special rules |
|---|---|---|
| `handoff-command-ports.ts`: `createNodeSendPorts`, `createNodeRetentionPorts`, `createNodeRevisionPorts`, `createNodeHandoffReadPorts` | **DB first** (owned or borrowed `options.database`, close on config error) | `readForOperation()` (or borrowed `options.configuration`); throws `AppCommandError` on setup refusal. |
| `handoff-command-ports.ts`: `createNodeReviewPorts`, `createNodeTerminalPorts` | **DB only** (owned or borrowed `options.database`) | Does not read configuration at composition time. |
| `project-command-ports.ts`: `createNodeProjectPorts` | **DB first** (owned or borrowed `options.database`, close on config error) | `readForOperation()` (or borrowed `options.configuration`); throws `AppCommandError` (`NOT_INITIALIZED` on null). |
| `channels.ts`: `createNodeChannelPorts` | **DB first** (owned or borrowed `options.database`, close on config error) | `readForOperation()`. |
| `memo-command-ports.ts`: `createNodeMemoPorts` | **DB first** (per `ADR-0032` `PRAGMA data_version`, owned or borrowed) | `read()`. |
| `vault-command-ports.ts` | **Config first**, lazy per-operation `withDatabase` | `readForOperation()` when `contentionSurface` is set, else `read()`; returns `Result`. |
| `backup-command-ports.ts` | **Config first**, lazy per-operation `withDatabase` | `read()`; returns `Result`. |
| `exchange-command-ports.ts` | **Config first** (`contextOf`) | `readForOperation()`; `openExchangeWriter` checks `vaultMoveLockHeld` BEFORE `openAndMigrate`, while reads use covered-read admission without opening a writer. |
| `daemon-command-ports.ts` | Separate (never opens DB and config together) | Keep outside `openAdapterContext`. |

- `sqlite/transaction.ts` `runInTransaction` gains `checkFence?: boolean` (default `true`) and `fenceError?: (pid) => AppError`. A failing `ROLLBACK` in its error path is swallowed so that the original error survives.
  - Migrate with `checkFence: true` and the site's own `fenceError`: `intent-log.ts` `record`, `handoffs.ts` `createFanout` and `applyContentRevision`, `content-store.ts` `writeFile`, `writeInline` and `cleanup`, and `handoff-read-store.ts` first-fetch (`recordFirstFetch`).
  - Migrate `handoffs.ts` `applyRetentionMutation` with `checkFence: contentRemoval`, where `contentRemoval` is narrowed on the `TASK-156` union as `input.change.kind === "deletion-approve" && (input.change.unlinkIntent !== undefined || input.change.removeContent === true)`, with its existing `fenceError`. Preserve `RUN-002` and `SHR-011`: under a live move fence, BOTH inline (`removeContent: true`, no `unlinkIntent`) and file-backed deletion-approve pause with `SERVICE_PAUSED`, while metadata-only changes (`pin`, `unpin`, `archive`, `unarchive`, `deletion-request`, `deletion-reject`) continue. Add focused integration tests for all three cases.
  - Migrate with `checkFence: false`:
    - `handoffs.ts` `completeActivations`, `applyNoChangeResolution`, `completeUnlinks`, `applyTerminalTransition` and `completeUnlink`;
    - `content-store.ts` `completeCommonIntentTx`;
    - `intent-log.ts` drain settle and `clear`;
    - `review-store.ts` (review and reporting writes);
    - `events.ts`;
    - read `BEGIN` in `channels.ts` and `memos.ts` `captureListBatch` only (`memos.ts` `inspect` already uses fenced `runInTransaction("BEGIN", ...)` and stays fenced).
  - **Conflict-read rule:** Rewrite `handoffs.ts` `rollbackWithConflict` (called by `applyContentRevision`, `applyNoChangeResolution`, `applyTerminalTransition` and `applyRetentionMutation`), every early refusal branch inside `createFanout`, and the post-rollback conflict read in `review-store.ts` so they query `row_version` (and `revision` in `review-store.ts`) inside `work` and return `err(...)` with NO manual `db.exec("ROLLBACK")`. `runInTransaction` alone executes `ROLLBACK` on an `err(...)` return; a manual rollback inside `work` triggers a second `ROLLBACK` and converts conflict or refusal errors into `INTERNAL_ERROR`. In `review-store.ts`, preserve the exact precedence `HANDOFF_NOT_FOUND` -> `REVISION_CONFLICT` (`expectedRevision !== row.revision`) -> `ROW_VERSION_CONFLICT`.
  - Keep manual: the fence owners in `intent-log.ts` (`setMoveFenceAndCountPending` and `clearMoveFence`), `sqlite/migrator.ts`, `preflight.ts`, every Project repository transaction in `projects.ts`, the snapshot read in `backup-command-ports.ts` and the restore rebuild with its `cleanupSafe`/`commitAttempted` flags.
- Route the direct git spawns in `doctor.ts` (`symbolic-ref --short HEAD`, `diff --cached --name-only`, `remote`), `project-command-ports.ts` (`rev-parse --is-bare-repository` and `--git-common-dir`) and `exchange-sources.ts` (`rev-parse --show-toplevel`) through `git-client.ts`.
  - `project-command-ports.ts` and `exchange-sources.ts` keep `timeoutMs: 10_000` and their exact current failure mapping.
  - `doctor.ts` uses `createNodeGitClient()` (batch env, `shell: false`, default 60,000 ms bound from `BKP-025`) and preserves its exact existing non-throwing diagnostic fallback: `!result.ok || result.value.exitCode !== 0` yields `""` for `symbolic-ref` and `remote`, and `result.ok ? result.value.stdout : ""` for `diff --cached`.
- Split `content-store.ts` and `intent-log.ts`. None of the resulting modules imports back up this chain. Keep every name exported from the adapters index.
  - `sqlite/move-fence.ts` gains `setMoveFenceAndCountPending` and `clearMoveFence`; update `apps/daemon/test/int/first-fetch-fence.int.test.ts` to import them from `sqlite/move-fence`.
  - `common-intent.ts` takes the common-intent execution section of `content-store.ts`.
  - `content-file-io.ts` takes the bounded reads and body handles.
  - `fetch-cache.ts` takes the fetch-cache section.
  - `content-layout.ts` takes the layout inspection and link validators.
  - `content-references.ts` takes `sqliteContentReferences` and `receiptReferencedContentKeys`.
  - `legacy-intent.ts` takes the legacy intent execution.
  - `collectVaultGarbage` moves into `maintenance.ts`.
  - `intent-log.ts` keeps its factory; `content-store.ts` keeps its factory and `stageBytes`.
- Delete `createSqliteHandoffRowStore`, `ASSIGNABLE` and the test cases in `handoff-ledger.int.test.ts` that exercise only them.

**Verification.** Adapter integration suites for crash points, failure injection, storage contention, maintenance cleanup, artifact link guard, Vault move, lockfile, content store, Memo shared content, Channel snapshot, content snapshot and backup snapshot, plus `apps/daemon/test/int/runtime.int.test.ts`, `apps/daemon/test/int/first-fetch-fence.int.test.ts` and CLI Vault and backup integration suites. Add focused tests for live-fence inline/file deletion-approve refusal vs metadata-only retention passage and for `placeExclusive` ancestor-dir fsync and readback mismatch handling. The review notes map every changed transaction and atomic-write site to the lists above.

### 7.5 TASK-158: domain rules and adapter decomposition

**Fixed decisions.**

- `handoff-read-store.ts` `toCandidate` calls core `deriveNextActors` with `reviewState`, `tombstone`, `pendingDeletionRequest` and `integrityOrConfigurationFailure`. The artifact integrity computation stays in the adapter.
- Add a pure core `revalidateSenderAtCommit(bindings, sender)` returning `Result<void, AppError>`, where each binding fact carries `id`, `projectId`, `directory`, `bindingKind`, `slug` and `status`.
  - It reproduces the adapter rules in `createFanout` exactly: `PROJECT_UNBOUND` for an override whose Project lost its binding, and `PROJECT_ARCHIVED` or `SENDER_IDENTITY_DOWNGRADE` for an owner mismatch; for an unregistered sender, the same refusal the adapter returns today when any binding root sits above or below the directory.
  - Do not import `dirname` from `node:path` in core (that would violate `TASK-156`'s purity grep); implement a pure POSIX parent-directory helper in core. Keep `directoryOwner` using `directory === row.directory || directory.startsWith(\`${row.directory}/\`)` and `unresolvedRoot` using the root-safe `atOrBelow` helper, matching the adapter's exact current behavior.
  - Because `createFanout` already runs inside `runInTransaction` after `TASK-157`, the adapter keeps its SQL read, calls `revalidateSenderAtCommit`, and returns `err(checked.error)` directly inside `work` with **NO** manual `db.exec("ROLLBACK")` (`runInTransaction` owns rollback).
  - Existing core `isAtOrBelow` and `resolveWorkspaceActor` stay unchanged; unifying them is a deferred item.
- Add a core `findBindingConflict(target, existing, excludeBindingId?)` that returns the existing `BINDING_DUPLICATE` or repository-containment error, or `null`. Both `checkedBindingTarget` and the `replaceBinding` recheck in adapters `projects.ts` call it; the adapter keeps its `installation_id` scoping and its Vault containment recheck.
- Move the SQL of `revokeExchangeClaims`, including its current schema guard, into `packages/adapters/src/exchange-claims.ts` as `revokeExchangeClaimsInTx(db, projectId)`.
  - `SqliteProjectRepositoryOptions` gains a required `onLocalProjectWithdrawn(projectId)` that runs synchronously inside the open transaction, before the event emit, at both current call sites (archive and removal of the last local binding).
  - `project-command-ports.ts` supplies `revokeExchangeClaimsInTx`. Export a dedicated read-only `createSqliteProjectReader(db)` from `projects.ts` (exposing only `findProjectBySlug`, `listProjects` and `listBindings*` with no withdrawal hook) and switch `ExchangeStore` in `exchange-command-ports.ts` to call `createSqliteProjectReader(db)` instead of `createSqliteProjectRepository`. Update every direct `createSqliteProjectRepository` test call site across `projects.int.test.ts`, `handoff-send.int.test.ts`, `stage-fence.int.test.ts`, `handoff-ledger.int.test.ts` and `failure-injection.int.test.ts`.
- Move the `openHandoffCount` implementation into a Handoff-owned `createSqliteProjectHandoffStats(db)` (in `handoff-read-store.ts` or a new `handoff-stats.ts`), keeping the core port name and behavior. Correct the stale port comment, and correct the stale open-Handoff definition in [interface section](../specs/interfaces-and-operations.md) `project unbind` so it matches the amended `PRJ-022`.
- Result conversion is limited to adapter-owned Exchange orchestration: `contextOf`, `openExchangeWriter`, the read checkpoints, the `writeExchange` branch bodies and `admitExchangeJoin`.
  - ExchangeStore methods reached through the core `ExchangeBusinessRepository` keep throwing the carried error as the documented rollback carrier of `runInTransaction`.
  - Preserve rollback on every abort, the `storageFailure` precedence (carried, schema admission, contention, `INTERNAL_ERROR`) and the `commitAttempted` cleanup path.
- Decompose along these seams. Every allowlisted entry module keeps its current exports.
  - `exchange-command-ports.ts` stays the entry: `admitExchangeJoin`, `executeExchange`, option types and the `contentionKindOf` re-export. New modules: `exchange-context.ts`, `exchange-store.ts`, `exchange-store-control.ts`, `exchange-store-lifecycle.ts`, `exchange-store-notices.ts`, `exchange-store-read.ts`, `exchange-capture.ts`, `exchange-checkpoints.ts` and `exchange-write.ts`.
  - `doctor.ts` stays `createNodeDoctorPorts`. It moves its parts into `doctor-context.ts`, `doctor-recoveries.ts` and `doctor-checks-{config,vault,storage,bindings,runtime}.ts`, and replaces the check `switch` with a record keyed by check id that keeps the catalog order.
  - `preflight.ts` keeps its public API. It moves its parts into `preflight-capture.ts`, `preflight-staging.ts`, `preflight-classify.ts`, `preflight-home.ts` and `preflight-fs.ts`.
  - Adapters `channels.ts` keeps the repository and row mapping. The node composition, body capture, sweep, release and `channelStorageError` move into `channel-command-ports.ts`.
  - Adapters `memos.ts` moves its backup helpers into `memo-backup-records.ts` and its shared row mappers into `memo-rows.ts`.

**Verification.** Integration suites for Handoff send and fan-out, failure injection, Project commands, Exchange commands (including the revocation cases), doctor, preflight, Channels, Memo storage and backup, with the `check:*` boundary scripts. New tests cover the revocation hook on both trigger points, atomic rollback of both Project state and event ledger when `onLocalProjectWithdrawn` throws, and each refusal code of `revalidateSenderAtCommit`.

### 7.6 TASK-159: CLI bootstrap

**Fixed decisions.**

- `apps/cli/src/main.ts` stays the entry file, because every self-invocation detects a source run by `endsWith("main.ts")`. `main()` becomes `async function main(...): Promise<number>`, `if (import.meta.main)` awaits `main()`, and it keeps the argv dispatch order while dynamically importing the target for each case:
  - `__health-probe`, `__port-probe` and `__config-put` load `internal-probes.ts`;
  - exactly `["mcp"]` loads `mcp-server.ts` directly and runs `serveMcp()`, returning `-1`;
  - `daemon serve` loads `daemon-serve.ts`, the only module that imports `@sorage/daemon`;
  - everything else loads `program.ts` and calls synchronous `runCli(...)`.

  It stays below 150 lines.
- `program.ts` owns `buildProgram` and synchronous `runCli` with the exact current registration order, because the help and completion goldens depend on it. **Never place an unawaited `async` dynamic `import()` inside Commander's synchronous `.action()`:** for `sorage --json mcp` (global options preceding `mcp`), `program.ts` registers `.command("mcp").allowExcessArguments(false)` whose synchronous `.action()` invokes an optional `onMcpRequested` callback supplied by `main()` and calls `reportExitCode(-1)`. After `runCli` returns `-1` with `mcpRequested === true`, `async function main()` executes `await import("./mcp-server")` and calls `serveMcp()` inside `main()`'s own async error boundary. `sorage mcp --help` (exit `0`) and `sorage mcp extra` (exit `2`) stay purely synchronous Commander paths and never import `mcp-server.ts`.
- Command modules live under `apps/cli/src/commands/`: `setup.ts`, `config.ts`, `project.ts`, `handoff.ts`, `handoff-read.ts`, `vault.ts`, `backup.ts` and `runtime.ts`. The existing `memo-commands.ts`, `channel-commands.ts` and `exchange-commands.ts` stay.
- Shared helpers:
  - `cli-output.ts`: output ports, request id, rendering and usage errors, listing reports and integer parsing;
  - `disclosure-buffer.ts`: the large-content warning buffering duplicated in send, revise, Memo and Channel commands;
  - `covered-read.ts`;
  - `self-invocation.ts`: for the CLI copies only. The adapters copy in `doctor.ts` receives the invocation as a parameter or stays.
- Tests import `runCli`, `buildProgram`, `withCoveredRead`, `renderAppError`, `configPutOnce`, `main`, `CLI_VERSION`, `CLI_NAME`, `OutputPorts` and `CommandInput` from `src/main`. Update those imports to the new modules, and update `apps/cli/test/unit/cli-entry.test.ts` so its test callback is `async () => { ... expect(await main(["version"])).toBe(0); }` (same exit-code check, adapted for the async bootstrap).
- Move these pieces out of the CLI:
  - `applyInitChoices` sequencing becomes a core use case. Its file and process facts, the LaunchAgent install and the daemon start arrive as injected ports or callbacks, and the CLI renders exactly the current lines.
  - The uninstall wiring becomes an adapters factory that takes `stopDaemon` as a callback.
  - The HTTP and TCP probes move to `packages/adapters/src/daemon-probes.ts`.
  - Handoff and Channel wait storage orchestration moves into adapters, while rendering stays in the CLI.
  - `confineFileArgument` with `realPathOf`, `isInsideWorkspace`, `resolveCallCwd` and tilde expansion moves to `packages/adapters/src/workspace-confinement.ts`. The MCP envelope helpers stay in the CLI.
  - Add every new adapters module that the CLI imports to the CLI allowlist in `scripts/check-import-boundaries.ts`.
- `ExchangeKeeper` stays where it runs today, in `mcp-server.ts` and `exchange session`. Renew and release keep running as `sorage exchange renew|release … --json` child processes of the same executable.
- Confirm that Bun bundles the string-literal dynamic imports into the single compiled binary (`scripts/build-cli.ts`, `bun build --compile`) and defers evaluation of `@sorage/daemon`. Verify BOTH (a) `bun build apps/cli/src/main.ts --target bun --metafile=<tmp>/meta.json` showing `@sorage/daemon` is reached ONLY through `dynamic-import` edges, AND (b) on the compiled candidate itself, confirm `sorage daemon serve` still boots and serves `/api/v1/health` (positive control) while `sorage exchange renew` succeeds without evaluating daemon code. If `@sorage/daemon` is statically bundled into the non-serve closure, stop and return to the Coordinator.

**Measurement.** Repeat [M11 qualification metric 5](../implementation-tips/m11-qualification.md) on a compiled candidate in a temporary `SORAGE_HOME`:

1. Initialize the home, add two Projects and create an Exchange.
2. Join it to obtain a claim.
3. Run one warm-up renew, then time ten cold `Bun.spawnSync([binary, "exchange", "renew", id, "--claim", claim, "--json"])` runs, asserting exit `0` and parsed JSON `ok === true` on every timed run.
4. Report the minimum, median, mean, p95 and maximum against the 71.98 ms median baseline on the same machine and toolchain.

`TASK-163` repeats the final measurement.

**Verification.** CLI unit, contract and integration suites (including plain `mcp`, `--json mcp`, `mcp --help` and `mcp extra`), `test/e2e` Exchange session and MCP suites, and a new managed-Bun runtime test (Vitest runs under Node ESM where `require.cache` is unavailable or empty for ESM imports, so the test MUST spawn managed `bun -e` rather than inspect `require.cache` inside Vitest). That test invokes non-exiting `main(["exchange", "renew", ...])` and the internal probe module entry (without calling `process.exit`) in a temporary home and asserts `Object.keys(require.cache)` contains zero `apps/daemon/src` entries, paired with a positive control importing `./apps/cli/src/daemon-serve.ts` that asserts `Object.keys(require.cache)` DOES contain `apps/daemon/src` entries.

### 7.7 TASK-160: MCP catalogue, completion and polling

**Fixed decisions.**

- `defineMcpTool(spec)` derives `properties`, `inputSchema` and the required-positional table from one declaration with these parts:
  - `name`, `description`, `annotations` and `mirrorsIntegerBounds`;
  - `command`, plus `options` (`property`, `flag`, `form`, `type`, optional `schema` and `required`);
  - `positionals`;
  - an optional schema `extra` (`oneOf`, `allOf` and `not`), and optional `argv` and `guard` overrides for the inbox and Channel message waits.

  It must reproduce the existing key order exactly, including positionals first for Exchange tools and the placement of the integer `maximum`.
- Migrate one family at a time: project, Memo, Channel, Handoff, then Exchange. After each family, run `mcp-server.contract.test.ts` against the unchanged `mcp-tools.json` and `mcp-catalog.unit.test.ts`. Never set `SORAGE_TEST_REGEN_MCP_GOLDEN`.
- `MCP_TOOLS` stays an array in its current order. `mcpToolByName` reads a `Map` built from the same objects; do not freeze them, because a contract-test preload replaces `argv`. Memoize the `toolsListResult` value in `mcp-server.ts`.
- `completion.ts` skips commands whose commander `_hidden` flag is set. It emits option completions for every visible subcommand in zsh and bash, which covers the Handoff, Memo, Channel and Exchange subcommands (adding 2-word subcommand `case` dispatch alongside single-word commands).
  - Regenerate `send-recovery-completion-zsh.txt` and `send-recovery-completion-bash.txt` with `SORAGE_UPDATE_GOLDENS=1` only after the code change; `apps/cli/test/contract/golden/preflight-completion.txt` stays unchanged. The reviewers read the whole diff: `daemon serve` is the only removed command, and every added line is a subcommand option completion or its 2-word `case` dispatch wrapper.
  - `send --re` must still complete to `--replay-only`, and real `bash` and `zsh` completion tests must also verify option completion on representative 2-word subcommands (at least one each from `memo`, `channel` and `exchange`).
- Polling in `daemon-commands.ts` (start and stop) and `web.ts` (start) sleeps for `min(current, remaining deadline)`. It starts at the current interval (200 ms, or 100 ms for stop), doubles after each miss and caps at 1,000 ms. Timeout values are unchanged. Add fake-clock unit tests pinning the geometric sleep intervals, a final readiness probe right before the deadline (succeeding if ready), and clean timeout failure when still unready at the deadline.
- Line 53 of `skills/use-sorage/SKILL.md` states that the 35 Handoff, Memo, Channel and Project tools this skill uses are internal communication; it no longer says that only 35 MCP tools are published.
- `scripts/sot-check.ts` applies `checkHardWrap` and `checkLinks` to `skills/**/*.md`, skipping a leading YAML frontmatter block. Update the statement in [testing-and-acceptance](../specs/testing-and-acceptance.md) that the check excludes the skill directory.

**Verification.** MCP contract, unit and schema-instance suites, `test/unit/use-sorage-skill.test.ts`, the send-recovery completion contract (including real bash/zsh 2-word subcommand checks), the preflight and help-and-completion integration suites, the Memo golden contract, daemon-commands and web fake-clock unit tests, and `bun run check:sot`.

### 7.8 TASK-165: snapshot export and restore

**Fixed decisions.**

- Step 1, before any refactor, on the unchanged code (retained in the working candidate and committed once by the Coordinator in the authorized `TASK-165` commit):
  - Add deterministic fixture installations with fixed identifiers and timestamps covering Handoffs with reporting state, file-backed and inline Memos, Channels with shared content, events, and Exchanges in active, paused and completed states — generating frozen V5 goldens for **both** Exchange representations (`foundation` and `collaboration`).
  - Generate Format 1, 2, 3, 4 and 5 source trees (including required Vault content files referenced by file-backed artifacts/Memos/Channels) once with the current writers, store them as on-disk fixtures, and add frozen-fixture restore tests across all five formats while keeping existing writer-based round-trip tests intact.
  - Add focused error-precedence characterization tests pinning first-error code, message and order across `validateSnapshot` and `backup verify`, including duplicate JSON keys, a non-object `events.jsonl` line, and a missing `manifest.json` during `backup verify`.
  - These frozen goldens and tests are the oracle for the rest of the Task.
- Step 2: introduce `SnapshotDomainCodec<T>` with `id`, `validate(data, context)`, `files(data, context)`, `counts(data)` and optional `digests(data)`.
  - The domains are projects, handoffs (the V4 reporting shard), Memos, Channels and shared content, events, and Exchanges.
  - Rewrite `snapshotFilesV5` (and `exportSnapshot`'s V5 path) onto one driver that builds the manifest once and produces byte-identical output to BOTH Step 1 V5 goldens (`foundation` and `collaboration`).
  - Keep `snapshotFiles`, `snapshotFilesV2`, `snapshotFilesV3` and `snapshotFilesV4` exported from `@sorage/core` so the `§7.1` export-name set, `backup-commands.ts`'s non-Exchange V4 branch and the existing V1–V4 unit, contract and E2E tests stay intact.
  - The Format 1–5 restore readers stay.
- Step 3: replace the linear lookups with maps or sets built once per validation, keeping every error code, message and first-error precedence order. The lookups to change:
  - the per-event Handoff lookup in `handoff-reporting-snapshot.ts`;
  - the acceptance lookup in `exchange-collaboration-snapshot.ts`;
  - the report and message lookups in `exchange-lifecycle-snapshot.ts`;
  - the per-operation recomputation in `exchange-notice-snapshot.ts`.
- Step 4: backup verify parses the manifest once and each event line once (still rejecting duplicate JSON keys, non-object event lines and a missing manifest with unchanged errors). Restore runs `readSourceSnapshot` validation once instead of reading the manifest and validating a second time.

**Verification.** Both V5 goldens (`foundation` and `collaboration`) stay byte-identical. Adapter suites for backup snapshot, content snapshot, Channel snapshot, Memo backup, handoff-reporting v12, legacy revise upgrade and Exchange restore (both frozen Format 1–5 fixtures and live writer round-trip tests). CLI backup integration suites and core snapshot unit and contract suites. New validator and verify tests for error precedence, duplicate JSON keys, non-object event lines, missing manifest and duplicate/missing references.

### 7.9 TASK-166: core directory layout

**Fixed decisions.**

- The target layout keeps base file names, so each move is a pure rename (because `TASK-155` created `primitives/identity.ts`, moving `packages/core/src/ids.ts` to `primitives/ids.ts` has no collision). `src/index.ts` and `src/version.ts` stay at the package root. `git.ts` (which still holds `MANAGED_PATHSPECS`, `isManagedVaultPath`, `unmanagedStagedPaths` and `isRuntimeTrackedPath` after `TASK-156`) moves definitively to `backup/git.ts`.

| Directory | Files |
|---|---|
| `shared/` | `errors`, `events`, `protocol`, `known-schemas` |
| `primitives/` | the `TASK-155` modules (`identity`, `validation`, `json`, `polling`, `disclosures`), `ids`, `cursor` |
| `config/` | `config`, `config-commands` |
| `content/` | `content`, `artifacts`, `artifact-integrity`, `import-policy`, `intent-log` |
| `project/` | `projects`, `project-commands`, `workspace-identity` |
| `handoff/` | `handoffs`, `handoff-commands`, `handoff-read`, `revision-commands`, `review-commands`, `reporting-commands`, `retention-commands`, `terminal-commands`, `send-recovery`, `inbox-marker` |
| `memo/` | `memos`, `memo-protocol`, `memo-commands`, `memo-repository`, `memo-request-hash` |
| `channel/` | the split `channels.ts` |
| `exchange/` | `exchanges`, `exchange-lifecycle`, `exchange-notices`, `exchange-use-cases`, `exchange-wait` |
| `vault/` | `vault`, `vault-commands` |
| `backup/` | the split `backup-commands.ts`, `backup-schedule`, `git` |
| `backup/snapshot/` | every `*-snapshot.ts` file |
| `runtime/` | `init`, `doctor`, `preflight`, `uninstall`, `tokens` |

- Split `channels.ts` into `channel/channel-model.ts`, `channel-validation.ts`, `channel-events.ts`, `channel-ports.ts`, `channel-views.ts`, `channel-commands.ts`, `channel-messages.ts`, `channel-queries.ts`, `channel-wait.ts` and `channel-errors.ts`. Shared private helpers (`invalid`, `resolveChannel` and `channelNotFound`) go into `channel-internal.ts`, which `index.ts` does not re-export.
- Split `backup-commands.ts` into `backup/backup-export.ts`, `backup-restore.ts`, `vault-git.ts`, `backup-verify.ts`, `backup-run.ts` (sync and async together, keeping `messageOf` and `hashOf` private), `backup-status.ts` and `backup-configure.ts`.
- Keep tests where they are and rewrite their imports. `version.ts` stays at the root, so `scripts/build-cli.ts`, `scripts/check-version.ts` and `scripts/package.ts` need no change. Update the three `test/e2e` imports of `known-schemas`, and the string paths in `packages/adapters/test/int/send-recovery.int.test.ts` and `memo-storage.int.test.ts`.
- Update the documentation links that `check:sot` resolves in [interfaces-and-operations](../specs/interfaces-and-operations.md) (including `../../packages/core/src/backup/git.ts`), [memo qualification](../implementation-tips/memo-qualification.md) and [preflight qualification](../implementation-tips/preflight-qualification.md), and update code-span paths in the other documents.
- Move leaf directories first, in this order: shared, primitives, config, content, project, memo, handoff, exchange, vault, runtime, backup/snapshot, backup. Run `bun run check:typecheck` after each directory, then split the two monoliths.
- Add an explicit directory-level DAG check over `packages/core/src/*` directories (either in `scripts/check-cycles.ts` or a unit test in `test/unit/preparation-gates.test.ts`) proving zero inter-directory cycles across `packages/core/src`.

**Verification.** All `check:*` scripts (`check:cycles` plus the core directory-level DAG check). Core unit and contract suites, `make test-int` and `make test-e2e`. The core export-name set is unchanged.

### 7.10 TASK-167: package encapsulation

**Fixed decisions.**

- Exports:
  - core and daemon: `{ ".": "./src/index.ts" }`;
  - cli: `{ ".": "./src/main.ts" }`, with `main` and `types` corrected to `./src/main.ts`;
  - adapters: retain `".": "./src/index.ts"` (without `./testkit`), keep `"./src/<name>"` subpath keys for every module in either app allowlist so app import lines do not change, add `"./testkit": "./src/testkit/index.ts"`, and keep explicit test-support subpaths `"./src/sqlite/connection"` and `"./src/sqlite/migrator"` (still forbidden in `apps/*/src` by `check:import-boundaries`) so `vi.spyOn` in `cli-storage-contention.int.test.ts` and `domain-routes.int.test.ts` keeps intercepting live internal adapter calls with existing assertions unmodified.
- Update `scripts/check-cycles.ts` to resolve workspace package imports against each package's `package.json` `"exports"` map target paths (failing on any unresolved internal specifier or missing export target).
- Remove `export * from "./testkit"` from `packages/adapters/src/index.ts`. Adapter tests keep their relative testkit imports. App tests that import the remaining unexported adapter modules (`sqlite/migrations`, `events`, `review-store`, `lockfile`, `sqlite/move-fence` moved from `intent-log` in `TASK-157`, and `testkit/fakes`) switch to exported subpaths or to `@sorage/adapters/testkit` re-exports (`init-ports` and `token-store` are already allowlisted and exported).
- Remove `src/init-ports`, `src/import-source` and `src/sleep` from the daemon allowlist. Add a test in `test/unit/preparation-gates.test.ts` against the real repository manifest (or guard a missing `packages/adapters/package.json` if checked inside `check-import-boundaries.ts` so the existing minimal temp fixtures stay green) verifying that every allowlist entry resolves to a real exported file in `packages/adapters/package.json` `"exports"`.
- Add `scripts/workspace.ts` with the workspace directory enumeration, manifest reading, the dependency-block and ecosystem-tool constants, and violation reporting. All five workspace-walking `check-*.ts` scripts (`check-version`, `check-typecheck`, `check-import-boundaries`, `check-dependency-boundaries`, `check-cycles`) use it with unchanged messages. The `Makefile` `test-prepare` recipe stays as `TASK-155` left it.

**Verification.** `make test` exits 0 on the candidate, including `build:cli`, the compiled binary and the existing `vi.spyOn` assertions. Update the [implementation tips](../implementation-tips/README.md) `CLI-018` allowlist description.
