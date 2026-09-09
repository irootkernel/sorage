---
name: use-sorage
description: Use Sorage only when the user explicitly requests a broker operation, such as checking an inbox or outbox, sending a document, or handling a Handoff, or explicitly requests Sorage project setup. Mentioning Sorage or developing its code does not trigger broker operations.
---

# Use Sorage

Sorage hands one current document at a time between AI coding sessions: one project sends a Handoff to one recipient project, the recipient reads it, may attach one Review Note, the sender revises, and the recipient closes the exchange with an explicit accept or decline. This skill is the whole discovery policy for that loop; no other file or tool is needed to follow it.

## Explicit requests only

Start broker operations only in response to an explicit user request. Session start, a new task or turn, a mention of Sorage, and work on Sorage code are not triggers. Continue an authorized operation to completion without asking again for each step, then stop; later unrelated work does not resume discovery.

For an inbox check, run `sorage inbox --json`; for an outbox check, run `sorage outbox --json`. Check both only when requested. Report the requested results: a check does not authorize `sorage review show`, fetching Artifacts, revising documents, sending, reviewing, accepting, declining, or withdrawing Handoffs. An outbox item in `changes_requested` is information to report, not an obligation to interrupt other work.

When the user requests Handoff processing, perform the operations needed within that request. Revisions supersede older content through the review loop.

`sorage inbox --wait --timeout <seconds> --json` blocks until a new item arrives or the timeout elapses; use it only when the user explicitly requests waiting for an inbox item. Being idle alone is not a trigger.

## Working a received Handoff

Read the current document with `sorage get <handoff-id>` and `sorage fetch <handoff-id>`; `fetch` also records that the recipient has engaged, which is what later makes a sender withdrawal impossible. `sorage get` is metadata only and does not carry the Review Note body. Request changes with `sorage review set <handoff-id> --text "<note>"`, and close the exchange with `sorage accept <handoff-id> --expected-revision <n> --expected-row-version <n>` or `sorage decline <handoff-id> --reason "<why>" --expected-row-version <n>`; both expected values come from the `get` or `fetch` output you just read.

## Answering a Review Note as the sender

When Handoff processing is requested and the current Handoff has a Review Note, read that Note through `sorage review show <handoff-id> --json` before `revise`. The sender sequence is `get`, `review show`, `fetch`, then `revise` (or `--no-change --reason "<why>"` when the Note needs no content change). `sorage get` still has no Note body. A sender `fetch` returns the in-Vault path and does not set `firstFetchedAt`. Edit a workspace copy of that document, not the Vault file. `sorage events <handoff-id> --json` reconstructs recent metadata and is not required on every revision.

Withdraw only what the recipient has neither fetched nor reviewed, with `sorage withdraw <handoff-id>`.

Every command accepts `--json` and prints a versioned envelope with a stable symbolic error code; the `recovery.suggestedCommand` field of a failure names the next valid command.

## Never touch the managed Vault

The Vault directory holds every Artifact under `artifacts/<handoff-id>/<artifact-id>/<stored-name>` together with its marker, `.gitattributes`, and `.gitignore`; Sorage manages those bytes and their checksums. Never create, edit, rename, or delete anything inside the Vault by hand — a rewritten byte surfaces as `ARTIFACT_CORRUPTED`, and a fabricated file is never adopted. Move the Vault only with `sorage vault move --to <path> --as-user`.

The `.sorage/INBOX.md` marker that appears in your working directory when the installation enables `handoff.inboxMarker` is derived: during a requested broker operation, read it as a hint if it helps, never as authority, and never edit it. Its presence does not trigger a broker operation. Deleting it is safe and pointless, because the next state change recreates it.

## Ignore `.sorage/` in Git

During requested Sorage project setup, ensure this Project's `.gitignore` contains `.sorage/`; create the file if absent, preserve existing entries, and do not duplicate an existing entry that already ignores the directory. Use `.gitignore` as the default rather than `.git/info/exclude`. An inbox or outbox check does not trigger setup edits. The marker directory is per-machine derived state and never belongs in a commit; the Vault itself carries its own `.gitignore` written at init. This is setup guidance; the CLI does not automatically edit the Project's `.gitignore`.

## Command reference

The complete command catalog, the exit-code categories, and every symbolic error code with its recovery hint live in [../../docs/specs/interfaces-and-operations.md](../../docs/specs/interfaces-and-operations.md); the configuration keys live in [../../docs/specs/examples/config.example.yaml](../../docs/specs/examples/config.example.yaml).
