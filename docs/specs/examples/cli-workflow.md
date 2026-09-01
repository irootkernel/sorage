# Example CLI Workflow

This walkthrough uses the v0.4.0 command surface defined in [../interfaces-and-operations.md](../interfaces-and-operations.md); every command without a milestone note works in milestone 0.1 with no daemon running.

Row Version values are shown explicitly because `--expected-row-version` is always the value the client currently holds, never the value it expects afterwards (HND-025).

## Initialize

Milestone 0.1, non-interactive:

```bash
sorage init \
  --vault "$HOME/.sorage/vault" \
  --non-interactive
```

The ten-question interactive wizard arrives with milestone 0.3 (INIT-004):

```bash
sorage init
```

## Register Projects

```bash
sorage project add \
  --name "Dolgorae" \
  --slug dolgorae \
  --dir "$HOME/projects/dolgorae"

sorage project add \
  --name "Gul" \
  --slug gul \
  --dir "$HOME/projects/gul"

sorage project add \
  --name "Scallop" \
  --slug scallop \
  --dir "$HOME/projects/scallop"
```

Each `--dir` inside a git working tree is stored as the repository's git common directory, so every worktree of that repository resolves to the same Project (PRJ-017).

A worktree therefore needs no binding of its own, and binding one would be rejected as `BINDING_DUPLICATE`; check what a path resolves to instead:

```bash
sorage project resolve --path "$HOME/worktrees/dolgorae-feature"
# dolgorae (git_repository binding, common dir $HOME/projects/dolgorae/.git)
```

## Send to one recipient

```bash
cd "$HOME/projects/dolgorae"

sorage send \
  --to gul \
  --title "gRPC stream ownership proposal" \
  --file "./docs/gul-stream-proposal.md"
```

The Handoff is created in `awaiting_recipient` at Revision 1 and Row Version 1.

A short question needs no file; `--body` materializes the text as a Markdown Artifact so the Handoff still has exactly one current Artifact (HND-023):

```bash
sorage send \
  --to gul \
  --title "Who owns stream backpressure?" \
  --body "Does Gul or Dolgorae own backpressure on the shared stream? One paragraph is enough."
```

A retryable create carries its own key, so a network-less retry after a crash returns the original result instead of a second Handoff (CLI-021):

```bash
sorage send \
  --to gul \
  --title "gRPC stream ownership proposal" \
  --file "./docs/gul-stream-proposal.md" \
  --idempotency-key "0d0a2c2a-7f38-4b0e-9a1f-6a1f2c4b8e11"
```

## Recipient reviews

```bash
cd "$HOME/projects/gul"

sorage inbox --json
sorage fetch <handoff-uuid> --json
```

`fetch` returns the read-only in-Vault path, sets `firstFetchedAt`, and appends `ARTIFACT_FETCHED_FIRST_TIME`; it does not change the review state and does not increment Row Version, so the Handoff is still at Row Version 1 (HND-012, HND-025).

```bash
sorage review set <handoff-uuid> \
  --file "./review-note.md" \
  --target-revision 1
```

`--target-revision 1` names the Revision the Note is written against, and a stale value returns `REVISION_CONFLICT` (REV-005, REV-006).

No expected Row Version is required here; supplying one is allowed and would be enforced (HND-014).

The Handoff is now `changes_requested` at Revision 1 and Row Version 2.

## Sender revises

```bash
cd "$HOME/projects/dolgorae"

sorage revise <handoff-uuid> \
  --file "./docs/gul-stream-proposal.md" \
  --expected-row-version 2
```

The revision imports the changed content, increments Revision to 2, removes the Review Note in the same transaction, and returns the state to `awaiting_recipient` at Row Version 3.

An unchanged file fails with `NO_CONTENT_CHANGE`, so when the sender concludes that no change is warranted the bounded no-change resolution is the alternative, taken instead of the revise above while the Handoff is still in `changes_requested` (REV-017):

```bash
sorage revise <handoff-uuid> \
  --no-change \
  --reason "The current wording already covers the retry budget; see section 4."
```

It is valid only in `changes_requested`; in `awaiting_recipient` there is no Note to resolve and it fails with `NO_REVIEW_NOTE`.

A second consecutive no-change resolution fails with `NO_CHANGE_LIMIT`, so the next resolution must change content.

## Recipient accepts

```bash
cd "$HOME/projects/gul"

sorage accept <handoff-uuid> \
  --expected-revision 2 \
  --expected-row-version 3
```

Both expected values are mandatory on `accept`, and the Handoff becomes `accepted` at Row Version 4 with `acceptedRevision = 2` (LIFE-002, CLI-013).

## Recipient declines

```bash
cd "$HOME/projects/gul"

sorage decline <handoff-uuid> \
  --reason "Gul does not own this stream; route it to Scallop." \
  --expected-row-version 3
```

`declined` is terminal, records `declineReason` and `declinedAt`, and is available from both `awaiting_recipient` and `changes_requested` (HND-022).

## Sender withdraws

```bash
cd "$HOME/projects/dolgorae"

sorage withdraw <handoff-uuid>
```

Withdraw is available only from `awaiting_recipient` while the recipient has neither fetched nor reviewed, that is while both `firstFetchedAt` and `reviewEngagedAt` are null; otherwise it fails with `HANDOFF_ALREADY_FETCHED` and the sender must supersede or ask for a decline instead (HND-021).

`reviewEngagedAt` is set by the first `review set` and is never cleared, so a Handoff whose Note was later withdrawn still cannot be recalled.

## Supersede a terminal Handoff

```bash
sorage send \
  --to gul \
  --title "gRPC stream ownership proposal, second pass" \
  --file "./docs/gul-stream-proposal.md" \
  --supersedes <handoff-uuid>
```

A terminal Handoff is immutable in content, so every further change uses a new Handoff (LIFE-006).

## Multi-recipient fan-out

```bash
cd "$HOME/projects/dolgorae"

sorage send \
  --to gul \
  --to scallop \
  --title "Shared session lifecycle proposal" \
  --file "./docs/session-lifecycle.md" \
  --json
```

Sorage returns two independent Handoff UUIDs and one Dispatch Group UUID; creation is all-or-nothing and the two Handoffs diverge from that moment on (HND-008, HND-009).

## Unregistered Workspace

```bash
cd "/tmp/prototype-client"

sorage send \
  --to dolgorae \
  --title "Prototype integration request" \
  --file "./request.md"

sorage outbox --current-workspace
```

An unregistered Workspace may send but may never receive, and `outbox --current-workspace` is how it finds what it sent (PRJ-012).

Two shapes fail with `SENDER_IDENTITY_DOWNGRADE` unless the send is deliberately marked, because both are nearly always a forgotten `cd` or a missing binding rather than an intentional anonymous send (PRJ-019).

The first is a directory that is an ancestor of a binding's workspace root, here `$HOME/projects` sitting above the bound `$HOME/projects/dolgorae`:

```bash
cd "$HOME/projects"

sorage send --to gul --title "Scratch note" --file "./note.md"
# ERROR [SENDER_IDENTITY_DOWNGRADE]

sorage send --to gul --title "Scratch note" --file "./note.md" --allow-unregistered
```

The second is a nested independent git repository inside a bound tree: the directory is contained in the workspace root, but its own git common directory matches no binding, so it resolves to no Project:

```bash
cd "$HOME/projects/dolgorae/vendor/upstream-fork"

sorage send --to gul --title "Upstream patch notes" --file "./NOTES.md"
# ERROR [SENDER_IDENTITY_DOWNGRADE]
```

A worktree of a bound repository is the case that does *not* downgrade: it folds onto the same git common directory and resolves to the Project.

Binding the directory later gives the Project sender authority over the Handoffs the Workspace already sent, while the recorded `senderKind` and `senderPathSnapshot` stay historically accurate (PRJ-020).

## Explicit identity for agent harnesses

An agent harness that runs from a scratch directory, a container mount, or a temporary worktree names its Project instead of relying on the working directory (PRJ-018, CLI-020):

```bash
sorage --as dolgorae send \
  --to gul \
  --title "Nightly integration report" \
  --file "/tmp/agent-run-4821/report.md" \
  --allow-external-source

sorage --as gul inbox --json
```

`--as` requires a Project that exists and has at least one binding on this Installation, otherwise `PROJECT_NOT_FOUND` or `PROJECT_UNBOUND`.

## Wait for work

A recipient session that has nothing else to do can block instead of polling by hand (CLI-020):

```bash
cd "$HOME/projects/gul"

sorage inbox --wait --timeout 600 --json
```

In milestone 0.1 this polls the database every `--interval` seconds, default 2, and on timeout exits 0 with an empty list and `meta.timedOut: true`.

The `use-sorage` skill tells every session to run `sorage inbox --json` at session start and before starting a task, which is the primary discovery path; `--wait` is for a session that is idle on purpose (GEN-014).

## Administrative unblock

When both participants are stuck on a Review Note nobody will resolve, the User removes it (REV-015):

```bash
sorage review remove <handoff-uuid> --as-user --confirm
```

The removal is audited as `REVIEW_NOTE_REMOVED` and returns the Handoff to `awaiting_recipient` with the Revision unchanged.

The recipient can also withdraw the current Note, whichever actor authored it, without administrative help (REV-016):

```bash
cd "$HOME/projects/gul"

sorage review withdraw <handoff-uuid>
```

Omitting `--as-user` on a User-admin command fails with `USER_CONTEXT_REQUIRED` (CLI-019).

## Backup, milestone 0.3

```bash
sorage backup enable --daily-at "03:00" --timezone "Asia/Seoul" --as-user
sorage backup status
sorage backup run
sorage backup verify
```

`backup status` reports the last attempt, commit, push, failure, the computed next due time, and the repository size on disk.

Push is enabled separately, and every Git call runs in batch mode under a 60-second timeout so a missing credential fails with `GIT_AUTH_REQUIRED` instead of hanging on a prompt (BKP-025):

```bash
sorage backup enable-push --remote origin --branch main --as-user
```

Restore is a bootstrap operation against an empty installation; always dry-run it first (BKP-021):

```bash
sorage backup restore --from "/Volumes/backup/sorage-vault" --dry-run --as-user
sorage backup restore --from "/Volumes/backup/sorage-vault" --as-user --confirm
```

The restored Installation adopts the `installationId` from the Vault marker, regenerates only the API token, verifies every checksum, and leaves Project bindings to be recreated by hand because they are machine-local:

```bash
sorage project bind gul --dir "$HOME/projects/gul"
sorage doctor
```

## Deletion

Any participant may request deletion:

```bash
sorage delete request <handoff-uuid> \
  --reason "Integration is complete."
```

A request may be filed from any non-deleted state, but only the User may approve or reject, approval requires a terminal review state and fails with `HANDOFF_NOT_TERMINAL` otherwise, and it is destructive, so it needs User context and an explicit confirmation (LIFE-011, CLI-014):

```bash
sorage delete approve <handoff-uuid> --as-user --confirm
sorage delete reject <handoff-uuid> --as-user --reason "Keep it for the audit trail."
```

A pinned Handoff needs the distinct second confirmation naming the Handoff itself, otherwise the approval fails with `PINNED_DELETE_CONFIRMATION` (LIFE-012):

```bash
sorage delete approve <handoff-uuid> \
  --as-user \
  --confirm \
  --confirm-pinned <handoff-uuid>
```

Approved deletion removes the current Artifact and the current Review Note and leaves a tombstone, which stays listable with `--include-deleted` and still answers `get`, `pin`, `archive`, and `unarchive`, while `fetch`, `revise`, `review`, `accept`, `decline`, `withdraw`, and a further `delete request` all fail with `HANDOFF_DELETED`.

Deletion never claims to purge Git history, and a Revision replaced between two backups is not preserved anywhere (LIFE-015, BKP-019).

## Web UI, milestone 0.2

```bash
sorage daemon start
sorage web
```

`sorage web` starts the daemon when it is not already running and opens the browser at `http://127.0.0.1:46321/#s=<one-time-secret>`, which the SPA exchanges for a session token; navigating to the port directly without a session shows a page telling you to run `sorage web` (RUN-012, SEC-019).
