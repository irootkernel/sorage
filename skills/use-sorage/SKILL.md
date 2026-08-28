---
name: use-sorage
description: Operate Sorage, the local document-handoff broker, from an AI coding session: check the inbox at session start and before each task, act on changes_requested outbox items before new work, hand documents over with sorage send, answer received Handoffs with review set, and never touch the managed Vault by hand.
---

# Use Sorage

Sorage hands one current document at a time between AI coding sessions: one project sends a Handoff to one recipient project, the recipient reads it, may attach one Review Note, the sender revises, and the recipient closes the exchange with an explicit accept or decline. This skill is the whole discovery policy for that loop; no other file or tool is needed to follow it.

## Session start and before every task

Run `sorage inbox --json` at session start and again before starting any task. The inbox lists the Handoffs this Project has received and is the only discovery surface you need; an empty list means no one is waiting on you.

Before beginning any new work, also run `sorage outbox --json` and act on every item in `changes_requested` first: a recipient has asked for changes to something you sent, and revisions you send later supersede the older content only through the review loop, never through a parallel channel.

`sorage inbox --wait --timeout <seconds> --json` blocks until a new item arrives or the timeout elapses; use it only when the session is intentionally idle.

## Working a received Handoff

Read the current document with `sorage get <handoff-id>` and `sorage fetch <handoff-id>`; `fetch` also records that the recipient has engaged, which is what later makes a sender withdrawal impossible. Request changes with `sorage review set <handoff-id> --text "<note>"`, and close the exchange with `sorage accept <handoff-id> --expected-revision <n> --expected-row-version <n>` or `sorage decline <handoff-id> --reason "<why>" --expected-row-version <n>`; both expected values come from the `get` or `fetch` output you just read.

When you are the sender, revise with `sorage revise <handoff-id> --file <path>` (or `--no-change --reason "<why>"` when the Note needs no content change) and let the recipient decide; withdraw only what the recipient has neither fetched nor reviewed, with `sorage withdraw <handoff-id>`.

Every command accepts `--json` and prints a versioned envelope with a stable symbolic error code; the `recovery.suggestedCommand` field of a failure names the next valid command.

## Never touch the managed Vault

The Vault directory holds every Artifact under `artifacts/<handoff-id>/<artifact-id>/<stored-name>` together with its marker, `.gitattributes`, and `.gitignore`; Sorage manages those bytes and their checksums. Never create, edit, rename, or delete anything inside the Vault by hand — a rewritten byte surfaces as `ARTIFACT_CORRUPTED`, and a fabricated file is never adopted. Move the Vault only with `sorage vault move --to <path> --as-user`.

The `.sorage/INBOX.md` marker that appears in your working directory when the installation enables `handoff.inboxMarker` is derived: read it as a hint if it helps, never as authority, and never edit it. Deleting it is safe and pointless, because the next state change recreates it.

## Ignore `.sorage/` in Git

Add `.sorage/` to this Project's `.git/info/exclude` or `.gitignore`. The marker directory is per-machine derived state and never belongs in a commit; the Vault itself carries its own `.gitignore` written at init.

## Command reference

The complete command catalog, the exit-code categories, and every symbolic error code with its recovery hint live in [../../docs/interfaces-and-operations.md](../../docs/interfaces-and-operations.md); the configuration keys live in [../../docs/examples/config.example.yaml](../../docs/examples/config.example.yaml).
