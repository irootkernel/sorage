# Deferred feedback

Record only small, actionable findings that have been intentionally postponed. Move an epic-sized finding to [TODO](../todo/README.md) or adopt it into the [roadmap](../roadmap/README.md). This index never records lifecycle status.

## EPIC-010 whole-epic audit

Two Low findings were confirmed during the EPIC-010 validation audit. Timeline overflow coverage remains below. The review-port factory connection-reuse finding was addressed through TASK-137 in [EPIC-020](../roadmap/README.md#epic-020-pre-release-simplification): [architecture section 16](../architecture/README.md#16-core-application-ports) documents command-local ownership and failure cleanup, preserving the [covered-read contract](../specs/security-reliability.md#17-m9-messaging-trust-boundary-and-writable-storage). It is no longer tracked here as a separate conditional cleanup, and EPIC-010 is not reopened.

### Timeline bound overflow coverage

- **Impact:** `sorage events` and `GET /api/v1/handoffs/{id}/events` already pass `HANDOFF_TIMELINE_LIMIT` (50) into a newest-first SQL `LIMIT`, and existing tests assert `length <= 50` plus one newest-first pair on short fixtures. A regression that dropped or widened the bound, or that ignored the limit argument, would still pass those assertions.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement CLI-023 / TASK-081)
- **Re-entry:** Add a focused adapter or CLI integration test that inserts more than 50 events for one Handoff and asserts the returned list is exactly 50, newest-first, with the oldest event types absent. Do not reopen EPIC-010 for this coverage.

## EPIC-011 whole-epic audit

This Low finding was confirmed during the EPIC-011 validation audit. Current body-upload emptiness rejection is correct; the entry captures independent event-loop hardening.

### Body emptiness rescan on the request callback

- **Impact:** After a `body` field is streamed to a spool, `utf8EmptyAfterTrim` re-reads the file with `readSync` on the daemon request callback so empty and whitespace-only UTF-8 text fail with `CONFIG_INVALID`. A body near `artifact.maxBytes` that is only whitespace can stall the loopback event loop for the duration of that scan. Non-whitespace bodies return as soon as the first non-trim character is decoded, and current AJ-18 plus upload tests pass.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement API-013 / TASK-084)
- **Re-entry:** Track non-whitespace UTF-8 while spooling the `body` field, or move the post-stream scan off the request callback, then add a focused test that a large whitespace-only body still fails with `CONFIG_INVALID` and leaves no spool. Do not reopen EPIC-011 for this scan.

### Body-only upload with a missing title

- **Impact:** `sendHandoffs` already rejects an empty title with `CONFIG_INVALID` before creating a Handoff. The Web compose form always sends a title field. An HTTP body upload that omits `title` or sends it empty is therefore refused, but no upload integration fixture names that path.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement WEB-019 / TASK-084)
- **Re-entry:** Add a focused `POST /api/v1/handoffs/upload` test that a body part with a missing or empty `title` fails with `CONFIG_INVALID` and creates no Handoff. Do not reopen EPIC-011 for this fixture.

## EPIC-017 TASK-115 observation follow-up

The accepted TASK-115 observations disclosed auxiliary inaccuracies that remain as independent guidance work; this entry is not a TASK-115 acceptance condition.

### Observer explanation accuracy

- **Impact:** The accepted run-5 and scoped observations recorded five auxiliary inaccuracies, two in the AJ-29 journey and three in the AJ-26 journey: an improvised "new content" condition on a new submission, a misread body size corrected in the same step, a wrong claim that `delete request` takes no row-version option, a wrong claim that a restored installation holds a different Handoff, and a receipt treated as proof that external work remained undone. Each is disclosed and corrected in the [EPIC-017 independent observations](../implementation-tips/use-sorage-acceptance.md#epic-017-independent-observations-2026-10-23); none failed its step except the last, which failed under the judgment-rule exception and passed scoped re-observation.
- **Owner:** `docs/deferred-feedback/README.md` (observed during EPIC-017 TASK-115)
- **Re-entry:** A future guidance pass could add the symmetric receipt sentence — a receipt is neither proof that external work ran nor that it did not — and tighten reference wording where observers improvised conditions. Do not reopen TASK-115 for this; it was not an acceptance condition.

## EPIC-023 execution refinement

These items surfaced while the [2026-11-24 EPIC-023 execution refinement](../governance/README.md#epic-023-execution-refinement-2026-11-24) verified the plan against the code. Each one would change a contract or a behavior outside a golden-preserving refactor, so `EPIC-023` preserves the current behavior and records the item here instead.

### Daemon and Web CLI JSON envelope alignment

- **Impact:** `apps/cli/src/daemon-commands.ts` emits JSON envelopes whose `meta.requestId` is the hardcoded literal `"daemon"` instead of a per-invocation request identifier, and `apps/cli/src/web.ts` emits a bare `{ url, daemonStarted, expiresAt, note }` JSON object without the standard `{ ok, data, meta }` envelope. Changing either shape changes the CLI JSON contract, which a Standard `EPIC-023` Task may not do.
- **Owner:** `docs/deferred-feedback/README.md` (removed from `TASK-160` by the EPIC-023 execution refinement)
- **Re-entry:** A Contract Task classifies both output changes in interface section 42 or its successor, updates the affected goldens and tests, and aligns both modules onto the shared CLI output helper.

### Full Result conversion of Exchange storage methods

- **Impact:** Exchange storage methods behind the core `ExchangeBusinessRepository` port (`packages/core/src/exchange/exchange-use-cases.ts`) return plain values and abort by throwing a carried `AppError`, which `runInTransaction` turns into a rollback and a typed error. `TASK-158` converts only adapter-owned orchestration; a full conversion changes a core port and its use cases.
- **Owner:** `docs/deferred-feedback/README.md` (scoped out of `TASK-158`)
- **Re-entry:** Change the repository port methods to return `Result`, update `commitExchangeBusiness` and `planExchangeBusiness`, and prove rollback, `storageFailure` precedence and the `commitAttempted` cleanup path with focused failure tests.

### Exchange claim revocation schema guard

- **Impact:** `revokeExchangeClaims` in `packages/adapters/src/projects.ts` probes for `exchange_notice_claims` (schema 16) before deleting from both `exchange_claims` (schema 14) and `exchange_notice_claims`, so an injected schema-14 or schema-15 database would also skip `exchange_claims`. Production compositions always migrate to the current schema, so no shipped path reaches the gap. `TASK-158` moves the code behind a hook without changing the guard.
- **Owner:** `docs/deferred-feedback/README.md` (observed during the EPIC-023 execution refinement)
- **Re-entry:** Guard each table separately or remove the guard once no caller can open an unmigrated database, with a focused test.

### Startup maintenance live-key queries

- **Impact:** The Vault startup maintenance protects storage keys of materialized Artifacts only and checks table existence, while the backup startup maintenance protects every recorded storage key. `TASK-157` unifies the sequence in `maintenance.ts` but keeps each caller's query, so GC protection is unchanged.
- **Owner:** `docs/deferred-feedback/README.md` (observed during the EPIC-023 execution refinement)
- **Re-entry:** Decide whether one protected-key set (the unfiltered superset is the conservative choice) applies to both callers and prove the GC outcome with an integration test.

### Atomic writes without fsync

- **Impact:** `token-store.ts` and `inbox-marker-ports.ts` replace files by rename without `fsync`, and `daemon-command-ports.ts` treats the directory `fsync` as best effort. `TASK-157` preserves these semantics through explicit `fs-atomic.ts` options.
- **Owner:** `docs/deferred-feedback/README.md` (observed during the EPIC-023 execution refinement)
- **Re-entry:** Decide per file whether durability should be strengthened and add a crash-point test for each changed site.

### Root-safe workspace containment in project resolution

- **Impact:** The adapter's commit-time `atOrBelow` treats a `/` root correctly, while core `isAtOrBelow` in `project-commands.ts` does not. `TASK-158` moves revalidation into core with a root-safe helper and leaves `resolveWorkspaceActor` unchanged, so the two paths still differ for a binding at `/`.
- **Owner:** `docs/deferred-feedback/README.md` (observed during the EPIC-023 execution refinement)
- **Re-entry:** Switch `resolveWorkspaceActor` and `checkedBindingTarget` to the root-safe helper with a focused unit test for a `/` binding.
