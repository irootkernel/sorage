# Deferred feedback

Record only small, actionable findings that have been intentionally postponed. Move an epic-sized finding to [TODO](../todo/README.md) or adopt it into the [roadmap](../roadmap/README.md). This index never records lifecycle status.

## EPIC-010 whole-epic audit

These two Low findings were confirmed during the EPIC-010 validation audit. Current CLI detail-read behavior is correct; the entries capture independent hardening work.

### Timeline bound overflow coverage

- **Impact:** `sorage events` and `GET /api/v1/handoffs/{id}/events` already pass `HANDOFF_TIMELINE_LIMIT` (50) into a newest-first SQL `LIMIT`, and existing tests assert `length <= 50` plus one newest-first pair on short fixtures. A regression that dropped or widened the bound, or that ignored the limit argument, would still pass those assertions.
- **Owner:** `docs/deferred-feedback/README.md` (originating requirement CLI-023 / TASK-081)
- **Re-entry:** Add a focused adapter or CLI integration test that inserts more than 50 events for one Handoff and asserts the returned list is exactly 50, newest-first, with the oldest event types absent. Do not reopen EPIC-010 for this coverage.

### Review-port factory connection reuse

- **Impact:** `createNodeReviewPorts` opens a second SQLite connection and a second review store after `createNodeHandoffReadPorts` already returned one. `sorage review show` uses only the read factory, so current CLI detail reads are unaffected. Later store statefulness or connection-affine locking could split mutation and read behavior.
- **Owner:** `docs/deferred-feedback/README.md` (originating factory in the adapters package)
- **Re-entry:** Reuse the read factory's review store and connection from `createNodeReviewPorts` if the review store becomes stateful or connection-affine. Do not reopen EPIC-010 for this factory cleanup.

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

## EPIC-017 integration review

This Low finding was confirmed during the EPIC-017 integration review of the committed result. The Channel coherence refusal itself is correct and its retry instruction is safe; the entry captures a recovery-text precision correction.

### Keyless Channel coherence-exhaustion recovery

- **Impact:** `runChannelMutation` in `packages/core/src/channels.ts` always builds its exhaustion refusal as keyed, so a keyless Channel mutation — `channel close`, `participant add` and `deactivate`, `assignment add` and `close`, `handle`, and a `create` or `submit` sent without `--idempotency-key` — that exhausts its coherence budget is told to retry "with its original mode, inputs, and key", and the binding-change `CONFIG_CONFLICT` recovery names a key the same way. Interface section 38 requires the original key only when one was present. The instruction to retry the identical request stays correct and nothing is committed; the TASK-117 audit kept both texts as state-accurate without separating the keyless case.
- **Owner:** `docs/deferred-feedback/README.md` (originating ADR-0032's 2026-10-20 Channel amendment in EPIC-016; observed during the EPIC-017 integration review)
- **Re-entry:** Pass whether the request carried an idempotency key into the exhaustion refusal and the binding-change `CONFIG_CONFLICT` text, and test both texts on one keyless and one keyed Channel command. The fix changes the packaged binary, so bundle it with the next change that already re-packages and requalifies the candidate, such as the v0.1.3 version change. Do not reopen TASK-117 for this text.
