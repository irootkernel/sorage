# Project Memo execution dossier

## 1. Goal and authorities

Deliver explicit project-scoped reminders separately from directional Handoffs. The user must be able to leave a reminder before a restart, inspect only Memos after returning, and explicitly mark a handled reminder done or an obsolete reminder dismissed. No hook, execution history service, scheduler, or ecosystem integration is part of this work.

[The roadmap](../roadmap/README.md#epic-013-project-memos) alone owns Epic/Task identity, order, dependencies, and delivery status. [Required specification](../specs/required-specification.md#18-project-memos) owns MEM-001 to MEM-024. [The Memo contract](../specs/project-memos.md) is the detailed implementation contract; [ADR-0027](../architecture-decision-records/README.md#adr-0027-project-memos-as-a-separate-domain-in-m7) records alternatives and migration decisions. Do not promote a checklist here into a second status authority.

## 2. Decision record and implementation boundary

The selected defaults are explicit local User operations, a Memo attached to an immutable Project ID, three states, explicit reopen, required optimistic concurrency, separate CLI/API/Web surfaces, and no hard deletion or synchronization. No outstanding product decision blocks this design. Product release SemVer is intentionally not allocated: M7 is a delivery gate, and publication needs separate authorization.

Both CLI and Web record User provenance, including AI operations performed on the User's behalf. This does not distinguish individual AI providers or create a named-user feature. A Memo may be created with only a title; a body adds context but is not a required execution dossier. Epic/Task names remain searchable ordinary text.

Retain the existing Handoff domain and all data. Do not create a Handoff subtype, rename accepted to done, auto-convert old User-to-Project exchanges, or add a central project-state file. A completed Memo does not mutate or certify roadmap, Podway, Git, or another tool's state. Sorage remains responsible only for storing and managing the note.

Implementation seams are settled, not left to adapter preference: Memo HTTP routes bypass the legacy transport replay cache and use the shared application/DB receipt; the real Web surface is `apps/daemon/src/web-app.ts`, not the `apps/web` stub; format 1 and format 2 have separately defined inventories and exact-byte digest rules; one active unresolved Web attempt blocks every new Memo write in its tab until evidence settles it or the User explicitly abandons recovery while preserving an unknown-outcome notice. Recovery is replay-only and never executes when its receipt is missing, including after restore or expiry. Do not expand this Epic into a Handoff replay rewrite, frontend migration, multiple-attempt queue, or new recovery service. Canonical decisions are in the Memo contract and the aligned authority order, not duplicated status in this dossier.

## 3. Execution order and per-Task gates

Keep the EPIC-012 prerequisite and follow its already accepted canonical outcome in the roadmap; do not reopen or repeat that work to start the Memo Epic. Current eligibility and lifecycle live only in the roadmap's active pointer. Use one whole Epic execution with strictly sequential member Tasks in the roadmap order, TASK-087 through TASK-094. Each member owns one normal completion commit; staging and commit authority must come from the governing workflow and explicit User authorization. This design correction updates eligibility, not implementation status, and performs no implementation, staging, commit, or publication.

Each Task must finish its own production layer, failure paths, tests, and affected canonical documentation without starting a later Task. A pure domain or persistence layer can be accepted through its real application/adapter tests before a public adapter exists; it must not claim an unimplemented CLI, API, or UI is usable. New public mutations are exposed only after backup and restore can preserve the stored Memo domain.

Acceptance ownership is layer-specific. TASK-092 must pass AJ-21-B browser checks only and must not require TASK-093's skill implementation or walkthrough. TASK-093 owns AJ-21-S; TASK-094 checks the whole AJ-21 after both have evidence. Lower-layer Tasks verify their real owned contracts without depending on later public adapters or claiming the whole cross-layer journey passed. The common make gate covers implemented tests, not unavailable future-layer acceptance.

Common completion checklist for every Task:

- [ ] Re-read current scope, prerequisites, instructions, and any changed native contracts; preserve unrelated working-tree changes.
- [ ] Implement all outcomes assigned to this Task, including failure and no-op behavior, without moving correctness work to qualification.
- [ ] Run the narrowest applicable checks first, then `make test` and `git diff --check`; use only isolated temporary SORAGE_HOME and test Vaults.
- [ ] Update affected normative documents, usage, examples, and traceability in the same Task; requirements can span layers but this Task's declared layer must be complete.
- [ ] For Contract work, supply a reviewed snapshot diff, explicit breaking/non-breaking classification, database/snapshot migration impact, and old-client compatibility evidence.
- [ ] Obtain a separate Reviewer under repository governance; do not replace that gate with self-review or a review waiver.
- [ ] Update lifecycle only through the roadmap, record exact verification and any unverified manual checks, then hand off the next Task.

Design Gate impact is Not required because this repository has no enrolled Design Gate registry. The checklist is an execution aid, not evidence that a check ran.

## 4. TASK-087: Domain values and checked public contracts

**Class:** Contract. **Packages:** `packages/core` and its tests; affected documentation and contract fixtures. **Precondition:** EPIC-012 is accepted. **Next:** TASK-088.

- [ ] Add the independent Memo types, bounded Unicode/title/body normalization, positive safe row versions, lifecycle transitions, no-op results, and closed-content rules.
- [ ] Define DTOs for complete detail, bounded list summary, mutation receipt, filter input, and API requests exactly as the canonical contract specifies. Freeze execute/replay-only application modes, CLI --replay-only, HTTP Idempotency-Mode, required recovery key/original inputs, and MEMO_REPLAY_UNAVAILABLE (HTTP 409, CLI 75). Mode must not change the normalized business-request hash or receipt namespace; a replay-only miss never executes.
- [ ] Add Memo error mappings and event catalog entries while preserving existing Handoff states, event meanings, and wire outputs.
- [ ] Define closed snapshot-format-2 validation shapes, legacy format-1 decoding rules, and Memo event association under the explicit Memo-contract authority order. Freeze the snapshot field set, format-2 count/map requirements including the zero-Memo case, and keep existing format-1 fixtures unchanged.
- [ ] Pin independent golden fixtures for canonical Memo UTF-8 bytes, final LF, raw-file SHA-256 as 64 lowercase hexadecimal characters, and snapshots-relative UUID-derived memoDigests keys. Cover duplicate JSON keys, noncanonical files, malformed digests, wrong shards, and path aliases; do not derive every expected digest using the production serializer.
- [ ] Pin request/response examples and invalid cases: missing expectation, null/unknown fields, invalid Unicode, 64-KiB body boundary, escaped JSON overhead, surrogate pairs, and closed-state edits.
- [ ] Test all pure lifecycle transitions, conflicts before no-ops, and the distinction between caller-recorded done and external completion.
- [ ] Do not add runnable Memo commands, HTTP routes, UI controls, a database writer, or a fake persistence implementation presented as production.

**Verification:** focused core unit and contract tests, `make test-contract`, `bun run check:sot`, and the common gate. **Completion:** pure values, transitions, DTO validation, symbolic errors, and migration-facing schemas are independently testable; the public binary does not advertise unavailable Memo operations.

## 5. TASK-088: Durable storage, migration, backup, and restore

**Class:** Contract. **Packages:** `packages/core`, `packages/adapters`, existing backup/restore wiring, and tests. **Precondition:** TASK-087. **Next:** TASK-089.

- [ ] Append the next unused SQLite migration; create Project-linked Memo storage and indexes, add nullable Memo event association, and retain old migrations and Handoff rows unchanged.
- [ ] Implement transactional Memo repository ports, read/query support, compare-and-set, metadata event append, and bounded summary projection. Do not expose public mutations yet.
- [ ] Implement format-2 export with Memo shards, counts, memoDigests, event associations, stable canonical bytes, and one consistent read snapshot. Hash the exact bytes published for each shard, including its final LF; use only the Memo contract's snapshots-relative canonical keys, never Vault-relative keys or a second serialization.
- [ ] Extend backup verify, restore dry-run, and real restore together; accept format 1 as zero Memos, reject future formats, verify every Memo file/reference/count/digest before import, and restore exact identities and lifecycle metadata.
- [ ] Exercise old-to-new database upgrade with existing Projects, bindings, Handoffs, Notes, Artifacts, events, and idempotency records; assert their existing meaning and identities survive. Separately prove real backup restore preserves the Installation ID and Memo rows but restores no operational receipts, even when the snapshot includes a newly created Memo. Supply restored/no-receipt fixtures for TASK-089 onward; do not require a later CLI/API to complete this persistence Task or reconstruct receipts from events.
- [ ] Test idempotent migration, concurrent startup, migration failure rollback, database read/write failures, partial backup publication, malformed or missing Memo files, orphan references, and interrupted restore.
- [ ] Verify format-2 empty inventories, byte-for-byte deterministic exports, hashes independently calculated from published files, and rejection of final-LF/BOM/whitespace corruption, missing/extra digest entries, duplicate JSON keys/IDs, wrong shards, absolute/parent/backslash path aliases, symlinks, and special files. Verification and dry-run must exercise the same validation as restore without silently upgrading the format-1 field set.
- [ ] Test an acknowledged seeded repository write surviving a process restart without a daemon. Treat real OS/power-loss testing as a separate explicitly recorded platform check, not a claim inferred from process restart.
- [ ] Document stopping old processes and verified pre-upgrade backup; test rollback into a fresh separate installation without claiming in-place downgrade or old-binary rejection safety.
- [ ] Do not create Memo Artifacts, a second database, automatic live synchronization, new home discovery, or writes to the developer's real home.

**Verification:** adapter integration/contract tests and legacy/new snapshot fixtures through real backup/restore use cases, then the common gate. **Completion:** persisted Memos and their events round-trip through backup and restore before a CLI/API can create real user Memos; old backup behavior is not silently used to omit new data.

## 6. TASK-089: Shared Memo application use cases

**Class:** Standard, promoted to Contract if a frozen shape changes. **Packages:** `packages/core`, `packages/adapters`, and tests. **Precondition:** TASK-088. **Next:** TASK-090.

- [ ] Implement add/list/show/update/done/dismiss/reopen against the real repository, with explicit target scope separated from User provenance.
- [ ] Support Project selection without a live binding; use the native resolver only for the CLI's explicit current-directory inference path, without all-project fallback.
- [ ] Enforce archived-Project create/reopen checks inside the write transaction while permitting read and existing-note cleanup.
- [ ] Implement required row-version checks, same-state/no-content no-ops, and the sole shared application/DB receipt authority before fresh lifecycle evaluation. Normalize selectors, title, create defaults, and update-field presence once; exclude transport serialization/token/path spelling while preserving accepted body bytes.
- [ ] Test equivalent JSON values and text/body-file inputs at the shared boundary, changed body bytes under one key, optional Project assertion identity, and 24-hour receipt expiry without expiry extension on replay. Return historical memo/changed with replayed=true to adapters, rather than caching a complete transport envelope.
- [ ] Implement replay-only as a non-executing branch of the common application before any fresh lifecycle write path. Require the original key/request/version, exclude mode from request identity, filter by expiresAt > server lookup time, and return MEMO_REPLAY_UNAVAILABLE on an absent/expired receipt. Do not reserve a key, purge expired receipts, append events, or mutate any Memo/receipt in that branch; storage failure must not become execute fallback.
- [ ] Use real TASK-088 restore fixtures for committed-create/response-loss recovery with the same Installation ID but no receipt; require no duplicate or new receipt. With a fake Clock, test just before, exactly at, and after expiry, including dispatch-before/lookup-after expiry. Also test an original that never arrived and an original that commits after a replay-only miss. Missing evidence stays unknown, not failed; a newly intended execute operation remains separately available.
- [ ] Commit Memo row, event, and optional receipt together; apply existing pause/migration/restore fences; fail without partial success.
- [ ] Implement parameterized literal search, stable created-time keysets, scope/filter-bound cursors, bounded Unicode-safe previews, and explicit all-project queries.
- [ ] Test simultaneous editors, update-versus-done, archive-versus-create/reopen, duplicate creation keys, changed requests under one key, replay after later changes, missing or wrong Project assertions, and unbound Projects.
- [ ] Prove no Handoff state, counter, timeline, artifact, or derived inbox marker is changed by a Memo operation.
- [ ] Do not infer work completion or execute a body, add provider identity, or weaken stale-version protection for convenience.

**Verification:** real core/adapter integration tests, storage-failure injection, relevant existing Handoff tests, then the common gate. **Completion:** both future public transports can use one complete application implementation rather than duplicate lifecycle logic.

## 7. TASK-090: CLI and restart-safe local workflow

**Class:** Contract. **Packages:** `apps/cli`, input adapters, and tests. **Precondition:** TASK-089. **Next:** TASK-091.

- [ ] Add all seven `memo` commands, help, shell completion, inherited JSON/diagnostic policy, Project/assertion selection, filters, and required expectation handling.
- [ ] Add bounded regular-file body import, text/file XOR by presence, exact UTF-8/line-ending preservation, and no implicit stdin/FIFO/device consumption.
- [ ] Accept the redundant `--as-user` flag but reject `--as`, sender/recipient, and other Handoff-only options on Memo commands.
- [ ] Pin CLI success, error, conflict, no-op, and historical replay goldens; compare existing Handoff goldens unchanged. Expose --replay-only on all five mutation commands with a required valid key and original inputs/expected version; reject the flag on reads. Verify retained, absent, expired, restored, and conflicting-key outcomes, with unavailable receipt at exit 75 and no execute fallback or duplicate.
- [ ] Execute AJ-20 against the real compiled binary and a temporary home: add, exit, restart, list only Memos, update, mark done, dismiss another, and reopen explicitly.
- [ ] Verify all-project selection is explicit, invalid current-directory resolution does not enumerate other Projects, and CLI use requires no running daemon or AI provider.
- [ ] Update the CLI catalog and examples without installing or replacing the user's binary.

**Verification:** CLI unit/int/contract tests, AJ-20, and the common gate. **Completion:** the user's restart/reminder scenario works through the compiled CLI and its stored data is already covered by backup/restore.

## 8. TASK-091: Authenticated local HTTP API

**Class:** Contract. **Packages:** `apps/daemon`, shared transport DTOs, and tests. **Precondition:** TASK-090. **Next:** TASK-092.

- [ ] Add the seven route forms under the existing loopback/authentication/Host and security-header pipeline.
- [ ] Require explicit Project/all-project scope for list and Project ID for create; never use the daemon's current directory as user intent.
- [ ] Collect raw byte chunks under the encoded JSON cap, perform fatal UTF-8 decoding before JSON parsing, then enforce closed-object, scalar-value, and decoded-field validation before normalization/hash/receipt lookup. Use a Memo-specific strict reader or explicit opt-in mode, not the legacy readDomainJsonBody replacement decoder or empty-object fallback; preserve existing callers. Invalid encoding or JSON returns MEMO_INVALID_INPUT/422 without content in diagnostics.
- [ ] Test malformed raw bytes inside title and body using byte-oriented HTTP requests, not only JSON.stringify on JavaScript strings: FF, invalid continuation, truncated end-of-input, overlong encodings, and UTF-8 encodings of surrogate code points. Cover valid ASCII JSON containing escaped unpaired surrogates separately after parsing. Assert no Memo/event/receipt writes and no successful replay for fresh or already committed keys.
- [ ] Test valid Korean/emoji bytes split across request chunks and legitimate U+FFFD as EF BF BD or the equivalent JSON escape. The valid representations replay as one normalized request; malformed FF with that key is rejected rather than repaired into a replay. A malformed fresh-key attempt must not consume the key or prevent a later valid request with it. Keep the encoded-size error separate from decoding errors.
- [ ] Register Memo routes with the legacy RouteEntryInternal.idempotent flag unset or false and use the ordinary authenticated handler branch in apps/daemon/src/server.ts. Forward Idempotency-Key to the same normalized application/DB receipt as CLI; no Memo request may use evaluateIdempotency/storeReplay/discardReplay from route-kit.ts. This bypass removes only the legacy raw-body replay wrapper, not application deduplication, authentication, bounded reads, or mutation fences.
- [ ] Preserve every existing Handoff route's replay flag, spooling, response envelope, and behavior. Do not introduce a Memo cache, replay stored HTTP envelopes, or solve this Task by changing generic Handoff semantics.
- [ ] Prove CLI-created Memos are read/updateable through HTTP and HTTP-created Memos through CLI, with identical state, versions, and existing User provenance.
- [ ] Test the real HTTP route with one key and equivalent JSON reordered, re-spaced, and equivalently escaped; require the original outcome with replayed=true and the current request's meta.requestId. Changed normalized content under that key must conflict, while changed body line endings must not normalize away.
- [ ] Test CLI-to-HTTP and HTTP-to-CLI replay-only recovery with the same key and normalized scope/input, concurrent submissions, and response loss after commit followed by daemon restart. Require exactly one creation/event and stable original identity without relying on process-local cache state.
- [ ] Map Idempotency-Mode execute/replay-only to the common application without changing the request hash; reject missing replay-only keys and invalid/duplicate/combined mode values or modes on Memo GET routes. Exercise all five mutation routes. A receipt miss or expiry returns MEMO_REPLAY_UNAVAILABLE/409, never writes or executes, and preserves existing validation/security ordering.
- [ ] Drive real create/commit/response-loss, format-2 backup/restore with the same Installation ID, reauthentication, and replay-only HTTP recovery. Prove the restored Memo count and events do not grow. Cover restored snapshots with and without the original Memo, exact expiry boundaries, a fresh-key miss, changed-request conflict, and late original completion; no unavailable/error response may become automatic execute.
- [ ] Test authentication and Host failure before any lookup or replay, oversized raw/decoded input even for a known key, concurrent CLI/browser edits, and unchanged legacy Handoff replay/output goldens.
- [ ] Update endpoint/error catalogs and contract snapshots before claiming route support.

**Verification:** daemon unit/int/contract suites, AJ-22 transport cases including raw-byte HTTP requests through the real server and pinned runtime, existing local-security journeys, and the common gate. **Completion:** every declared route has a real application path and documented errors; malformed UTF-8 is rejected before replay or persistence while valid Unicode survives; no unauthenticated or fake-only route is presented as complete.

## 9. TASK-092: Separate Memo Web experience

**Class:** Standard. **Packages:** the shipped `apps/daemon/src/web-app.ts` browser assets, related daemon asset tests, and real browser tests. **Precondition:** TASK-091. **Next:** TASK-093.

- [ ] Extend the browser assets actually served by apps/daemon/src/server.ts, reusing the existing navigation, API helper, and renderMarkdownSafe in web-app.ts. Leave apps/web/src/index.ts as its existing stub; no package migration, new framework, separate build pipeline, or disconnected demo is in scope.
- [ ] Add a separate Memos Project view and explicit all-project view, default Open filter, state filters, literal search, pagination, bounded summaries, and complete detail.
- [ ] Implement create/edit forms, exact newline/Unicode input, safe Markdown preview, byte-limit guidance, and Open/Done/Dismissed labels with no Handoff acceptance or sender/recipient controls.
- [ ] Implement explicit Done, Dismiss, and Reopen; closed content remains read-only until a successful reopen.
- [ ] Preserve drafts and display a conflict when the observed version is stale; refresh for inspection but never automatically overwrite against the fresh version.
- [ ] Persist one bounded original operation/key/input/Installation record in session storage before dispatch, then gate all Memo writes in the tab at both UI controls and the common submit function. A missing/full/invalid store prevents sending. Preserve the first-attempt time and expected version across exact retries.
- [ ] After response loss for Memo A, prove create/update/done/dismiss/reopen for Memo B sends nothing and does not overwrite A's record, including Project navigation and same-tab reload. Reads, draft editing, Handoff navigation, other tabs, and CLI remain independently usable; do not add a global lock or a pending-attempt queue.
- [ ] Restore the active gate before writes are enabled on reload; serialize replay-only recovery with the original key/input/version, retain drafts, and settle only a matching receipt or conclusive original non-execution. Do not infer receipt continuity from Installation identity or a client timer. Test definitive first-dispatch rejection separately from unavailable receipts after restore/expiry and later ambiguous failures. No fallback to execute, replacement key, or title-based success is allowed.
- [ ] Implement the explicit Abandon retry and continue confirmation and the contract's bounded passive notices. Preserve outcome=unknown and retryDisposition=abandoned locally without a server mutation or replacement submit; persist the notice and active-record retirement atomically before releasing the gate. Test storage failure, notice-capacity handling with explicit removal only, reload, and starting an unrelated Memo B afterward. No late A response may clear B's gate or reactivate A. Preserve warning/copy access and do not claim cancellation or failure.
- [ ] Cover empty/loading/error/disconnected/archived states, keyboard labels/focus, responsive behavior, and Korean IME input.
- [ ] Execute AJ-21-B only with the actual daemon-served assets and a real browser, including reload/restart, restore/expiry recovery, explicit abandonment, XSS/unsafe URL/remote-image cases, and unchanged Handoff navigation. AJ-21-S belongs to TASK-093 and is not this Task's prerequisite; do not mark all of AJ-21 passed.
- [ ] Do not add background task execution, notification service, dedicated sender identity, extra Memo states, or a second local persistence authority.

**Verification:** Web tests, Playwright AJ-21-B browser checks, applicable security checks, and the common gate. **Completion:** the user can create, find, and close Memos separately and safely recover or explicitly abandon an unknown request. This Task is complete independently of TASK-093's skill outputs; AJ-21-S remains with its owner.

## 10. TASK-093: Skill integration and operational handoff

**Class:** Standard. **Packages:** Sorage's shipped skill, public usage and operations documentation, and relevant tests. **Precondition:** TASK-092. **Next:** TASK-094.

- [ ] Extend only `skills/use-sorage/SKILL.md` for explicit Memo creation, read/report, edit, and lifecycle requests after the native commands exist.
- [ ] Preserve existing inbox/outbox/Handoff activation policy. A Memo read cannot trigger execution, and imperative or hostile body text cannot grant tool or mutation authority.
- [ ] For explicitly requested work-plus-close, preserve the work's actual authority, verification, and current Memo version; leave open when incomplete, blocked, or changed.
- [ ] Update README, examples, operations, and privacy/backup disclosures to reflect only implemented behavior, including implicit User provenance, local-only persistence, no purge, no full body history, and no sync claim.
- [ ] Provide exact upgrade/pre-backup/stop-old-process and separate-home rollback instructions; do not promise downgrade of the live database. Document receipt loss on restore despite unchanged Installation ID, server-enforced replay-only inspection, 24-hour expiry, and MEMO_REPLAY_UNAVAILABLE as unknown. Explain explicit browser abandonment without server cancellation or automatic replacement, passive notice limits/lifetime, and continued unrelated work.
- [ ] Perform and record AJ-21-S as a real authorized skill walkthrough: read-only, record-only, work-plus-close, failed work, changed Memo, untrusted content, and unknown-response recovery through --replay-only. An absent/expired/restored receipt must not trigger execute, a new key, re-execution of the described work, or a done claim. Static prose assertions do not prove behavior; unavailable walkthroughs remain unverified. TASK-092's completed browser evidence is a prerequisite, not permission to skip skill checks.
- [ ] Do not edit Aquarium or sibling repositories, install a hook, inspect the user's actual inbox/Memos, or run unrequested development work named by a fixture.

**Verification:** docs/SOT checks, relevant skill packaging tests, AJ-21-S's explicitly recorded functional walkthrough, and the common gate. **Completion:** native behavior and agent instructions agree, and optional narrative examples do not become undisclosed automation.

## 11. TASK-094: Cross-layer qualification and closeout handoff

**Class:** Standard, promoted to Contract if a correction changes a contract. **Packages:** cross-layer acceptance tests and documentation. **Precondition:** TASK-093. **Next:** explicit Epic acceptance and M7 gate, not automatic publication.

- [ ] Run AJ-20 through AJ-23 on the compiled CLI, authenticated real daemon, real browser, and real SQLite/backup adapters under isolated temporary homes. Full AJ-21 requires both TASK-092's AJ-21-B and TASK-093's AJ-21-S evidence; inspect/revalidate applicable evidence against the final candidate and report unperformed skill checks rather than counting them as browser success.
- [ ] Re-run the existing AJ-01 through AJ-19 regressions applicable to the candidate and the complete `make test` gate; report manual platform checks honestly.
- [ ] Reuse the owning Tasks' regressions for normalized CLI/HTTP replay-only recovery, daemon restart, same-Installation backup restore without receipts, exact server-side expiry boundaries, and unavailable receipt without execute fallback. Combine tab-wide active-request protection, explicit abandonment preserving unknown notices, late-callback isolation, and exact-byte/path snapshot verification. These failures must already be handled by their owning implementation Tasks, not deferred to this qualification Task.
- [ ] Inject concurrent CLI/Web mutations, response loss, process restart, write failure, migration failure, archived/unbound Project transitions, and corrupt format-2 snapshot inventories.
- [ ] Restore both legacy and Memo-bearing backups into clean installations, compare exact restored data, and prove rejected restores leave the target unchanged under the documented restore contract.
- [ ] Classify the final CLI/HTTP changes as additive except explicitly versioned snapshot changes; include existing-client regression evidence and the unsupported downgrade boundary.
- [ ] Confirm the product still works without Codex, Aquarium, Podway, Dolgorae, Gul, hooks, or a remote service. Verify no unrelated source, Handoff data, or user-global configuration is changed.
- [ ] Resolve current Epic correctness defects before acceptance; any additional independently owned Task receives a new roadmap identity under governance rather than being hidden in future work.
- [ ] Prepare canonical outcomes and an exact implementation handoff. Do not require this Task's own completion or Epic closure to test the acceptance gate, and do not mark the Epic complete merely because all member Tasks have rows.

**Verification:** full gate plus the independent Epic assessment and explicit manual-evidence inventory. **Completion:** all planned user outcomes and cross-layer failure cases have evidence; the accepted Epic closeout then removes this dossier only after durable content and links are preserved.

## 12. Canonical promotion and dossier removal

Permanent design already belongs to the required specification, ADR, Memo contract, architecture, interfaces, security/operations, and acceptance owners. During each Task, update those owners for reviewed implementation facts. Keep detailed local runtime records out of tracked documentation unless a reviewed durable evidence package is actually required.

At explicit Epic closeout, verify no other active Epic references this dossier, promote any remaining durable guidance, replace the roadmap Detailed SOT link with Canonical Outcomes, remove this file and its TODO-index entry, and replace the Memo contract's execution-dossier link with its canonical roadmap reference. Leave every requirement-to-Task traceability row intact. Dossier deletion is part of the disclosed closeout scope, not an automatic effect of completing the last Memo or closing a browser.
