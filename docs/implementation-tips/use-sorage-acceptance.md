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
