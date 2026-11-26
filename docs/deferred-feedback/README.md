# Deferred feedback

Track small, actionable findings that have been intentionally postponed and retain the reasons for closing findings at the end of this page. Move an epic-sized finding to [TODO](../todo/README.md) or adopt it into the [roadmap](../roadmap/README.md). The roadmap owns delivery status.

## EPIC-010 whole-epic audit

Two Low findings were confirmed during the EPIC-010 validation audit. Timeline overflow coverage remains below. The review-port factory connection-reuse finding was addressed through TASK-137 in [EPIC-020](../roadmap/README.md#epic-020-pre-release-simplification): [architecture section 16](../architecture/README.md#16-core-application-ports) documents command-local ownership and failure cleanup, preserving the [covered-read contract](../specs/security-reliability.md#17-m9-messaging-trust-boundary-and-writable-storage). It is no longer tracked here as a separate conditional cleanup, and EPIC-010 is not reopened.

### Timeline bound overflow coverage

- **Verification gap.**
- **Roadmap follow-up.** [TASK-171](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** `sorage events` and `GET /api/v1/handoffs/{id}/events` already pass `HANDOFF_TIMELINE_LIMIT` (50) into a newest-first SQL `LIMIT`, and existing tests assert `length <= 50` plus one newest-first pair on short fixtures. A regression that dropped or widened the bound, or that ignored the limit argument, would still pass those assertions.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement CLI-023 / TASK-081)
- **Re-entry:** Add a focused adapter or CLI integration test that inserts more than 50 events for one Handoff and asserts the returned list is exactly 50, newest-first, with the oldest event types absent. Do not reopen EPIC-010 for this coverage.

## EPIC-011 whole-epic audit

The EPIC-011 audit identified event-loop hardening and a missing integration case for body uploads.

### Body emptiness rescan on the request callback

- **Product fix.**
- **Roadmap follow-up.** [TASK-170](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** After a `body` field is streamed to a spool, `utf8EmptyAfterTrim` re-reads the file with `readSync` on the daemon request callback so empty and whitespace-only UTF-8 text fail with `CONFIG_INVALID`. A body near `artifact.maxBytes` that is only whitespace can stall the loopback event loop for the duration of that scan. Non-whitespace bodies return as soon as the first non-trim character is decoded, and current AJ-18 plus upload tests pass.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement API-013 / TASK-084)
- **Re-entry:** Track non-whitespace UTF-8 while spooling the `body` field, or move the post-stream scan off the request callback, then add a focused test that a large whitespace-only body still fails with `CONFIG_INVALID` and leaves no spool. Do not reopen EPIC-011 for this scan.

### Body-only upload with a missing title

- **Verification gap.**
- **Roadmap follow-up.** [TASK-170](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** `sendHandoffs` already rejects an empty title with `CONFIG_INVALID` before creating a Handoff. The Web compose form always sends a title field. An HTTP body upload that omits `title` or sends it empty is therefore refused, but no upload integration fixture names that path.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement WEB-019 / TASK-084)
- **Re-entry:** Add a focused `POST /api/v1/handoffs/upload` test that a body part with a missing or empty `title` fails with `CONFIG_INVALID` and creates no Handoff. Do not reopen EPIC-011 for this fixture.

## EPIC-023 execution refinement

These items surfaced while the [2026-11-24 EPIC-023 execution refinement](../governance/README.md#epic-023-execution-refinement-2026-11-24) verified the plan against the code. Each one would change a contract or a behavior outside a golden-preserving refactor, so `EPIC-023` preserves the current behavior and records the item here instead.

### Daemon and Web CLI JSON envelope alignment

- **Contract fix.**
- **Roadmap follow-up.** [TASK-174](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** `apps/cli/src/daemon-commands.ts` emits `"daemon"` as `meta.requestId`, and `apps/cli/src/web.ts` emits a bare `{ url, daemonStarted, expiresAt, note }` object. Both differ from the [documented CLI envelope](../specs/interfaces-and-operations.md#14-cli-envelopes).
- **Owner:** `docs/deferred-feedback/README.md` (removed from `TASK-160` by the EPIC-023 execution refinement)
- **Re-entry:** A Contract Task identifies affected consumers and their migration needs, classifies both output changes in interface section 42 or its successor, updates the affected goldens and tests, and aligns both modules onto the shared CLI output helper.

### Full Result conversion of Exchange storage methods

- **Conditional follow-up.**
- **Impact:** Exchange storage methods behind the core `ExchangeBusinessRepository` port (`packages/core/src/exchange/exchange-use-cases.ts`) return plain values and abort by throwing a carried `AppError`, which `runInTransaction` turns into a rollback and a typed error. `TASK-158` converts only adapter-owned orchestration; a full conversion changes a core port and its use cases.
- **Owner:** `docs/deferred-feedback/README.md` (scoped out of `TASK-158`)
- **Re-entry:** Revisit when a concrete error propagation problem warrants changing the port. If converted, cover rollback, `storageFailure` precedence and the `commitAttempted` cleanup path with focused failure tests.

### Atomic writes without fsync

- **Conditional follow-up.**
- **Impact:** The Installation API token is replaced by rename without file or directory `fsync`. The relevant question is whether an acknowledged token rotation must survive abrupt power loss. The Web secret and derived inbox marker also use rename without `fsync`. The daemon run record syncs the file and attempts to sync its directory.
- **Owner:** `docs/deferred-feedback/README.md` (observed during the EPIC-023 execution refinement)
- **Re-entry:** Revisit the API token if a durability requirement or an observed rotation recovery failure establishes the need. Test the affected crash points if the policy changes. Evaluate the single-use Web secret, derived marker and daemon run record only if a file-specific recovery requirement arises.

### Root-safe workspace containment in project resolution

- **Product fix.**
- **Roadmap follow-up.** [TASK-169](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** `isAtOrBelow` in `project-commands.ts` misses descendants of `/`, so workspace resolution can miss an existing root binding. The [Vault containment check](../../packages/core/src/content/import-policy.ts) has the same edge case in the path checks used for Project registration, binding and rebinding. At `dcd7ee5`, the check accepted `/` as a Project directory with `/audit/vault` as the Vault, violating VLT-017.
- **Owner:** `docs/deferred-feedback/README.md` (observed during the EPIC-023 execution refinement)
- **Re-entry:** Enforce root-safe containment in the Vault guard, Vault move guard, external-source guard, and sender downgrade guard, and isolate any existing invalid `/` binding record so it remains explicitly repairable through `rebind` or `unbind` without gaining implicit authority over descendant workspaces. Cover rejection of `/` as a new or replacement binding, downgrade refusal from `/`, ordinary path segment boundaries, and explicit repair of a legacy root row.

## EPIC-024 TASK-162 browser observation

### Narrow Web layout overflow

- **Product fix.**
- **Roadmap follow-up.** [TASK-173](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** At a 390 CSS pixel viewport, Dashboard, New Handoff (Compose), and Backup can extend past the viewport and require page-wide horizontal scrolling. The same three views overflowed before and after Web asset extraction. The [M11 qualification](../implementation-tips/m11-qualification.md) carries forward that observation against unchanged Web sources and embedded bytes.
- **Owner:** `docs/deferred-feedback/README.md` (observed during TASK-162 browser verification)
- **Re-entry:** Adjust the three views' narrow layout in a focused Web follow-up and add a compiled-browser regression at 390 CSS pixels that checks document width and access to the existing controls. Verify the desktop layout in the same pass.

## EPIC-024 validation follow-up

### Detecting stale committed Web assets

- **Verification gap.**
- **Roadmap follow-up.** [TASK-172](../roadmap/README.md#epic-025-m11-release-hardening-and-regression-coverage).
- **Impact:** `make test-prepare` regenerates the tracked Web embedding before the aggregate reaches packaging, so `make test` can pass after rewriting previously stale bytes. Standalone `make package` rejects stale embedding bytes before compiling. The embedding at `dcd7ee5` passed the read-only `bun run build:web -- --check`.
- **Owner:** `docs/deferred-feedback/README.md` (observed during EPIC-024 validation)
- **Re-entry:** Compare the checked-out `apps/daemon/src/web-assets.generated.ts` with the expected generated bytes before any regeneration and verify in an isolated copy that a deliberately stale input is rejected before it is rewritten.

## Closed findings

### EPIC-017 TASK-115 observation follow-up

#### Observer explanation accuracy

- **Superseded by current guidance.** The [current skill](../../skills/use-sorage/SKILL.md) limits receipts to historical broker results and excludes inferences about external work in either direction. The [independent observations](../implementation-tips/use-sorage-acceptance.md#epic-017-independent-observations-2026-10-23) retain all five inaccuracies, their corrections and the two scoped passes for step 7f. That record also preserves which inaccuracies affected the original judgments.

### Exchange claim revocation schema guard

- **Inapplicable to supported writes.** The [claim hook](../../packages/adapters/src/exchange-claims.ts) introduced by TASK-158 still skips both deletes when an injected schema-14 or schema-15 database lacks `exchange_notice_claims`. Supported Project writes open a [migrated database](../../packages/adapters/src/adapter-context.ts), and the [schema-16 migration](../../packages/adapters/src/sqlite/migrations.ts) removes claims for Projects that already lost authority. Revisit if a supported write path starts operating on schema 14 or 15 before migration.

### Startup maintenance live-key queries

- **Redundant for live-key protection.** TASK-157 retained the two queries. Vault startup reads materialized Artifact keys and backup startup reads all recorded Artifact keys. [Common startup maintenance](../../packages/adapters/src/maintenance.ts) already protects every recorded `content_records.storage_key` in addition to the caller's Artifact keys. Unifying the queries would leave the protected set the same. The Artifact sweep still depends on whether the caller's list is empty. Revisit that sweep condition if an actual cleanup problem is observed.
