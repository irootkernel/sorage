# Deferred feedback

Track small, actionable findings that have been intentionally postponed and retain the reasons for closing findings at the end of this page. Move an epic-sized finding to [TODO](../todo/README.md) or adopt it into the [roadmap](../roadmap/README.md). The roadmap owns delivery status.

## EPIC-023 execution refinement

These items surfaced while the [2026-11-24 EPIC-023 execution refinement](../governance/README.md#epic-023-execution-refinement-2026-11-24) verified the plan against the code. Each one would change a contract or a behavior outside a golden-preserving refactor, so `EPIC-023` preserved the current behavior and recorded the item here instead. The two confirmed product/contract items from that refinement (`Daemon and Web CLI JSON envelope alignment` and `Root-safe workspace containment in project resolution`) are now resolved under [Closed findings](#closed-findings); the two conditional follow-ups below remain deferred with their existing re-entry conditions.

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

## Closed findings

### EPIC-017 TASK-115 observation follow-up

#### Observer explanation accuracy

- **Superseded by current guidance.** The [current skill](../../skills/use-sorage/SKILL.md) limits receipts to historical broker results and excludes inferences about external work in either direction. The [independent observations](../implementation-tips/use-sorage-acceptance.md#epic-017-independent-observations-2026-10-23) retain all five inaccuracies, their corrections and the two scoped passes for step 7f. That record also preserves which inaccuracies affected the original judgments.

### Exchange claim revocation schema guard

- **Inapplicable to supported writes.** The [claim hook](../../packages/adapters/src/exchange-claims.ts) introduced by TASK-158 still skips both deletes when an injected schema-14 or schema-15 database lacks `exchange_notice_claims`. Supported Project writes open a [migrated database](../../packages/adapters/src/adapter-context.ts), and the [schema-16 migration](../../packages/adapters/src/sqlite/migrations.ts) removes claims for Projects that already lost authority. Revisit if a supported write path starts operating on schema 14 or 15 before migration.

### Startup maintenance live-key queries

- **Redundant for live-key protection.** TASK-157 retained the two queries. Vault startup reads materialized Artifact keys and backup startup reads all recorded Artifact keys. [Common startup maintenance](../../packages/adapters/src/maintenance.ts) already protects every recorded `content_records.storage_key` in addition to the caller's Artifact keys. Unifying the queries would leave the protected set the same. The Artifact sweep still depends on whether the caller's list is empty. Revisit that sweep condition if an actual cleanup problem is observed.

### Review-port factory connection reuse

- **Addressed in `TASK-137` (`EPIC-020`).**
- **Origin:** Confirmed as one of the two Low findings during the `EPIC-010` whole-epic validation audit.
- **Resolution and durable evidence:** Addressed through `TASK-137` in [EPIC-020](../roadmap/README.md#epic-020-pre-release-simplification): [architecture section 16](../architecture/README.md#16-core-application-ports) documents command-local ownership and failure cleanup, preserving the [covered-read contract](../specs/security-reliability.md#17-m9-messaging-trust-boundary-and-writable-storage); `EPIC-010` is not reopened.

### Root-safe workspace containment in project resolution

- **Resolved in `TASK-169` (`EPIC-025`, with absent-Vault commit-time ancestor resolution implemented and verified in `TASK-175` under Master's [2026-11-27 scope approval](../governance/README.md#task-175-absent-vault-commit-time-containment-scope-approval-2026-11-27)).**
- **Origin:** Observed during the EPIC-023 execution refinement (`dcd7ee5`, originating requirement `VLT-017`); `isAtOrBelow` in `project-commands.ts` and the Vault containment guard previously missed descendants of `/` and accepted `/` as a Project directory alongside `/audit/vault`.
- **Resolution and durable evidence:** Implemented root-safe `isPathAtOrBelow` containment across [import-policy.ts](../../packages/core/src/content/import-policy.ts), [project-commands.ts](../../packages/core/src/project/project-commands.ts), [workspace-identity.ts](../../packages/core/src/project/workspace-identity.ts), [vault-commands.ts](../../packages/core/src/vault/vault-commands.ts), [projects.ts](../../packages/adapters/src/projects.ts), [project-command-ports.ts](../../packages/adapters/src/project-command-ports.ts), [handoff-command-ports.ts](../../packages/adapters/src/handoff-command-ports.ts), [vault-command-ports.ts](../../packages/adapters/src/vault-command-ports.ts), and [doctor-checks-bindings.ts](../../packages/adapters/src/doctor-checks-bindings.ts) under [interfaces section 42.6.2](../specs/interfaces-and-operations.md#4262-boundary-1-root-safe-containment-vs-legacy--binding-isolation-task-169). Kept `checkExternalSource` fail-closed on `/` (`VLT-016`), isolated pre-existing invalid `/` bindings from implicit authority and runtime containment while preserving explicit `project rebind`/`unbind` repair and `doctor` `bindings.nested` guidance, and verified across [projects.int.test.ts](../../packages/adapters/test/int/projects.int.test.ts), the unit and integration suites, and the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).

### Body emptiness rescan on the request callback

- **Resolved in `TASK-170` (`EPIC-025`).**
- **Origin:** Identified during the EPIC-011 whole-epic audit (originating requirement `API-013` / `TASK-084`); `utf8EmptyAfterTrim` previously rescanned spooled multipart `body` files synchronously with `readSync` on the daemon request callback.
- **Resolution and durable evidence:** Replaced `utf8EmptyAfterTrim` in [upload.ts](../../apps/daemon/src/upload.ts) with incremental streaming fatal UTF-8 validation and non-whitespace tracking inside the `body` push-sink evaluated in synchronous `onComplete` (leaving Memo multipart untouched), eliminating the disk rescan while covering the full body payload under `API-013`, preserving `CONFIG_INVALID` responses, error precedence, spool cleanup, and keyed replay. Verified by [upload.unit.test.ts](../../apps/daemon/test/unit/upload.unit.test.ts), [upload.int.test.ts](../../apps/daemon/test/int/upload.int.test.ts), and the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).

### Body-only upload with a missing title

- **Resolved in `TASK-170` (`EPIC-025`).**
- **Origin:** Identified during the EPIC-011 whole-epic audit (originating requirement `WEB-019` / `TASK-084`); `POST /api/v1/handoffs/upload` previously lacked a dedicated integration regression fixture for body-only uploads with omitted or empty `title`.
- **Resolution and durable evidence:** Added focused `POST /api/v1/handoffs/upload` regression tests in [upload.int.test.ts](../../apps/daemon/test/int/upload.int.test.ts) confirming that body-only uploads with missing, empty, or whitespace-only `title` fail with `422 CONFIG_INVALID`, create zero Handoffs, and leave zero request spools, while file uploads preserve filename fallback. Verified inside the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).

### Timeline bound overflow coverage

- **Resolved in `TASK-171` (`EPIC-025`).**
- **Origin:** Confirmed during the EPIC-010 whole-epic validation audit (originating requirement `CLI-023` / `TASK-081`); prior timeline tests asserted `length <= 50` only on short fixtures without pinning overflow truncation or cross-surface parity.
- **Resolution and durable evidence:** Added shared over-limit SQLite fixtures (>50 events on one Handoff including scrambled-rowid identical-timestamp ties across the 50-event cutoff plus newer events on another Handoff) in [cli-detail-read.int.test.ts](../../apps/cli/test/int/cli-detail-read.int.test.ts) and [domain-routes.int.test.ts](../../apps/daemon/test/int/domain-routes.int.test.ts), proving that compiled `sorage events --json` and `GET /api/v1/handoffs/{id}/events` return the exact same 50 newest event IDs in deterministic `created_at DESC, id DESC` order, retain metadata-only admission checks, and perform zero writes. Verified inside the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).

### Detecting stale committed Web assets

- **Resolved in `TASK-172` (`EPIC-025`).**
- **Origin:** Observed during EPIC-024 validation (`dcd7ee5`); `Makefile` `test-prepare` previously ran `bun run build:web` and rewrote stale `apps/daemon/src/web-assets.generated.ts` before packaging could reject drift.
- **Resolution and durable evidence:** Switched `test-prepare` in [Makefile](../../Makefile) to read-only `$(BUN) run build:web -- --check`, updated [make-gate.int.test.ts](../../test/int/make-gate.int.test.ts), preserved explicit `bun run build:web`, ordinary `make build`, and standalone `make package` stale rejection, and verified via isolated stale-embedding copy drills and the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).

### Narrow Web layout overflow

- **Resolved in `TASK-173` (`EPIC-025`).**
- **Origin:** Observed during EPIC-024 `TASK-162` browser verification; Dashboard, New Handoff (Compose), and Backup previously overflowed a 390 CSS pixel viewport horizontally.
- **Resolution and durable evidence:** Updated [styles.css](../../apps/daemon/src/web/styles.css) and [dashboard.ts](../../apps/daemon/src/web/views/dashboard.ts), [compose.ts](../../apps/daemon/src/web/views/compose.ts), and [backup.ts](../../apps/daemon/src/web/views/backup.ts) with keyboard-focusable labeled scroll regions (`role="region"`, `tabindex="0"`, `aria-labelledby`), bounded full-width Compose form fields and `<div class="compose-result" role="status">`, and narrow text wrapping; explicitly regenerated [web-assets.generated.ts](../../apps/daemon/src/web-assets.generated.ts); and verified 390px and 1280px populated views, keyboard scrolling, failure-warning rendering, and zero `axe-core` violations across [web-ui-defects.e2e.test.ts](../../test/e2e/web-ui-defects.e2e.test.ts), [aj18-web-compose-body.e2e.test.ts](../../test/e2e/aj18-web-compose-body.e2e.test.ts), [backup-web.e2e.test.ts](../../test/e2e/backup-web.e2e.test.ts), and [axe-a11y.e2e.test.ts](../../test/e2e/axe-a11y.e2e.test.ts) inside the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).

### Daemon and Web CLI JSON envelope alignment

- **Resolved in `TASK-174` (`EPIC-025`, Contract).**
- **Origin:** Removed from `TASK-160` during the EPIC-023 execution refinement; `apps/cli/src/daemon-commands.ts` previously emitted literal `"daemon"` `meta.requestId` values and multi-object restart output, while `apps/cli/src/web.ts` emitted a bare top-level JSON object and plain-text errors.
- **Resolution and durable evidence:** Routed [web.ts](../../apps/cli/src/web.ts), [daemon-commands.ts](../../apps/cli/src/daemon-commands.ts), [runtime.ts](../../apps/cli/src/commands/runtime.ts), and [setup.ts](../../apps/cli/src/commands/setup.ts) through shared [cli-output.ts](../../apps/cli/src/cli-output.ts) helpers under [ADR-0041](../architecture-decision-records/README.md#adr-0041-m11-release-hardening-and-regression-coverage) and [interfaces section 42.6.3](../specs/interfaces-and-operations.md#4263-boundary-2-web-and-daemon-cli---json-default-output-and-setupts-isolation-task-174), emitting standard envelopes with per-invocation UUIDs under `--json`, exact human-default templates without `--json`, single-envelope `daemon restart`, and isolated `init --start-daemon`/`uninstall` envelopes; cut over all nine tracked Web E2E consumers to `data.url`; pinned 34 normalized envelopes in [web-daemon-goldens.contract.test.ts](../../apps/cli/test/contract/web-daemon-goldens.contract.test.ts) and [web-daemon-envelopes.json](../../apps/cli/test/contract/golden/web-daemon-envelopes.json); documented breaking migration guidance in [CHANGELOG.md](../../CHANGELOG.md) and [Operations](../ops/README.md#web-and-daemon-cli-json-cutover-and-legacy-root-binding-recovery-adr-0041); and verified inside the combined [M11 qualification](../implementation-tips/m11-qualification.md#8-combined-epic-025-v016-release-hardening-qualification-task-175).
