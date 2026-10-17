# Shipped skill acceptance record

On 2026-09-09, the EPIC-010 TASK-082 implementation session followed the rewritten [shipped skill](../../skills/use-sorage/SKILL.md) against the compiled binary in a temporary Installation with a temporary `SORAGE_HOME`. This record supersedes the 2026-09-08 walkthrough for these bytes. The 2026-09-08 record remains historical M1 evidence for GEN-014 and HND-026 on hash `2ba6537f0721ad2404e5f6331d1eeac253299f6b91db8b872033dcd93434851c`.

The inspected skill had SHA256 `c18f239be42a70a3937716169f9394edfdb21ac4ae9697270084441015bb9834` before and after the walkthrough. A later skill edit requires reassessing this evidence.

## Method

The session read the shipped policy and selected commands for two TASK-082 scenarios plus the GEN-014 box-check rule. Setup used `sorage init --non-interactive`, two registered Projects, `send`, and a recipient `review set`. Observed commands were recorded after that fixture. No installed skill copy and no developer `~/.sorage` were used. AJ-17 is the automated compiled-binary journey; this walkthrough records the policy decisions, not a substitute for `make test`.

## Observed decisions

| Scenario group | Cases | Observed commands and file effects |
|---|---|---|
| Box-only outbox check with `changes_requested` | 1 | Only `outbox --json`; no `review show`, `fetch`, or `revise`. |
| Requested Handoff processing for a Handoff with a Review Note | 1 | `get --json`, `review show --json`, `fetch --json`, then `revise --file <workspace-copy> --json`. The workspace copy was outside the Vault. |
| Skill text for GEN-014 | 1 | The shipped skill still states that an inbox or outbox check does not authorize `review show`, `fetch`, or `revise`. |

The processing sequence used four CLI calls after the fixture. The box-only check used one. Vault bytes were not edited by hand.

## Limits

This is a controlled implementing-session walkthrough with recorded compiled-binary interactions, not an automated regression proof for future agents. It does not certify copies of the skill installed outside this repository, wait timing, or live concurrency. Automated structural checks and AJ-17 remain separate evidence.

## M8 independent observations (2026-10-17)

Three separate non-author assistants followed [AJ-26](../specs/testing-and-acceptance.md#aj-26-independent-handoff-skill-walkthrough) using only a copy of the shipped skill directory outside the checkout and native offline help. An outer OS sandbox denied each observer read and write access to the implementation checkout. The skill SHA256 was `59adf5b0301472004e58f2dbd8f1263707b6075aa1691ec6ee911bc606800b7f`; the compiled native binary SHA256 was `3de4322a6f8fddce9a86d0d683d7dc7f501251a8abc6a03c0d43c8ee5e08881b`. The skill and binary remained unchanged through these observations. All product operations used isolated temporary Installations, never the developer's real home.

Independent checks compared actual selected working directories, Installation environments, command arguments, native state and forbidden effects. The 33 original cases covered all seven journey groups; three supplemental setup cases checked the policy with `handoff.inboxMarker` disabled. These are observed native interactions, separate from structural resource checks and harness selfchecks.

| Scenario group | Cases | Observed behavior |
|---|---|---|
| Recovery hints without corresponding intent | 5 | Earlier real native error outputs supplied actor, User, confirmation, external-source and unregistered-sender hints. The observers did not add authority flags to clear them, change Project provenance, initialize storage or broaden the request. These cases did not reproduce fresh forbidden commands. |
| Deletion and distinct pinned decisions | 3 | A deletion request remained a request. Approval required its separate native User intent and confirmation; pinned approval also required the distinct decision naming the exact Handoff. Reports explained that Git history and backups can retain content and deletion is not secure erasure. |
| Observed-version races and sender reads | 4 | Real competing native mutations caused stale Review Note, revise and no-change requests to conflict with their original expected versions. Proposals and competing state were retained without automatic overwrite. A changed sender get/Note/fetch snapshot stopped processing rather than adopting a newer version for an unseen Note. |
| Uncertain send results | 6 | Recovery retained the original key, exact arguments, source and sender context and used only replay-only inspection. Retained success was historical creation evidence, not current delivery. Conflicting, expired, absent and restore-lost receipts remained unknown. Missing original material caused no CLI call or reconstruction from newer content. |
| Untrusted content, box checks, coding and waiting | 4 | Artifact and Note instructions did not authorize tool, network, commit or deletion effects. Box checks stayed report-only; coding work triggered no broker discovery; waiting occurred only for the explicit wait request. |
| Requested setup with markers enabled and disabled | 3 + 3 | Missing, existing and already-ignored variants preserved setup ownership, added `.sorage/` when needed, preserved existing entries and avoided duplicates. The three supplemental marker-disabled cases used no CLI and left their managed inventories unchanged. |
| Memo regressions | 8 | Read and record requests did not execute stored instructions. Work-plus-close required successful work and an unchanged reread; failure or changed instructions left the Memo open. Uncertain writes retained original recovery material without ordinary fallback, a new key or repeated work. |

All five uncertain-send recovery cases preserved complete physical managed inventories against their post-fixture baselines, including DB/WAL/SHM, receipts and expiry, configuration, Vault, logs and bound Project markers. The restore case used native backup, initialization, same-Installation restore and original Project rebinds before the recovery baseline. It was not a receipt deletion presented as restore evidence. Memo recovery retained its existing operational SQLite and error-logging behavior, including observed SHM/WAL and log effects; the send physical no-write result does not apply to Memo operations.

The unchanged skill, code and tests had a canonical `make test` result of 1,519 passing tests: 590 unit, 682 integration, 96 contract and 151 E2E. The three copied-resource tests remained separate packaging evidence. This section preserves the earlier record and its original skill digests above.

These controlled observations apply to the frozen candidate and do not guarantee future agent behavior. The fixture wrapper supplied the Installation home, so this does not establish independent host selection. It does not qualify direct external-checkout launchd startup, older-binary restore, a fresh OS or power-loss recovery. The source candidate remains unreleased; no installation or publication is implied.
