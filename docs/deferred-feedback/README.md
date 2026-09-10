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
