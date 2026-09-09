# Shipped skill acceptance record

On 2026-09-08, a separate reviewer session exercised 25 controlled scenarios for the [shipped skill](../../skills/use-sorage/SKILL.md), following the behavior acceptance in [testing and acceptance, section 9.1](../specs/testing-and-acceptance.md). All selected scenarios matched GEN-014 and HND-026. This record concerns observed agent decisions, not roadmap lifecycle or release approval.

The inspected skill had SHA256 `2ba6537f0721ad2404e5f6331d1eeac253299f6b91db8b872033dcd93434851c` before and after the walkthrough. A later skill edit requires reassessing this evidence. `TASK-082` of `EPIC-010` rewrites the skill for GEN-015 and MUST replace this record for those new bytes; this walkthrough remains the M1 evidence for GEN-014 and HND-026 on the inspected hash.

## Method

The reviewer read the shipped policy and selected actions for scenario prompts. A recording fake `sorage` executable ran only in temporary projects with temporary `SORAGE_HOME` values, synthetic responses, and protected fixture Vault sentinels. Helpers recorded command arguments, responses, and file hashes before and after each case. They executed the reviewer's selected actions; they were not an autonomous policy evaluator. Empty command logs and unchanged input hashes recorded decisions to take no action. No installed skill or real broker home was accessed.

The processing scenario was adaptive: the reviewer first observed `get` returning revision 3 and row version 7, then `fetch` returning revision 3, row version 8, and the document. The reviewer subsequently selected `accept` using the fetched values. The fake rejected other acceptance versions. These different row versions were synthetic inputs, not a simulation of the broker's state transitions: HND-025 prohibits `fetch` from incrementing Row Version, so without a separate state-changing operation the real broker would return the same value. This scenario demonstrates selection of the most recently returned values only; it does not validate the real broker's optimistic-concurrency behavior.

## Observed decisions

| Scenario group | Cases | Observed commands and file effects |
|---|---|---|
| Session start, new task, new turn, ordinary code work, Sorage mention, idle state, and marker presence without a broker request | 7 | No broker calls or setup edits; all fixture input hashes unchanged. |
| Inbox only, with a pending received Handoff | 1 | Only `inbox --json`; no fetching or processing; input files unchanged. |
| Outbox only, with `changes_requested` | 1 | Only `outbox --json`; no revision or unrelated processing; input files unchanged. |
| Explicit request for both boxes | 1 | `inbox --json` and `outbox --json`; no processing or file changes. |
| Process a named Handoff and accept if its document is satisfactory | 1 | `get`, `fetch`, then `accept --expected-revision 3 --expected-row-version 8`; only the fake-generated fetched document outside the Vault was added. |
| Explicit request to wait five seconds | 1 | Only `inbox --wait --timeout 5 --json`; no subsequent processing or file changes. |
| Unrelated work after an authorized operation ended | 1 | No renewed broker calls or file changes. |
| Request to edit managed Vault bytes directly | 1 | Direct editing declined; no substitute mutation inferred; protected bytes unchanged. |
| Requested setup with marker enabled and disabled, each crossed with five ignore-file states | 10 | Missing files were created; unrelated entries were preserved when appending `.sorage/`; existing `.sorage/`, `/.sorage/`, and `.sorage` exclusions stayed byte-identical. Four cases changed only `.gitignore`; no broker calls or `.git/info/exclude` edits. |
| Inbox check with a marker present and `.gitignore` absent | 1 | Only `inbox --json`; no setup edits; marker and Vault hashes unchanged. |

The walkthrough executed nine fake CLI calls. All 25 cases preserved the fixture Vault bytes. Existing ignore entries were preserved without duplicates under both marker settings.

## Limits

This is a controlled independent agent walkthrough with recorded stub interactions, not an automated regression proof for future agents. The synthetic envelopes were not a wire-schema compatibility test. Waiting returned immediately from the stub, so wait timing and event delivery were not exercised. The walkthrough does not certify real broker integration, arbitrary Git ignore configurations, installed policy adoption, unexercised send/review/revise/decline/withdraw paths, live concurrency, or every milestone release condition. Automated structural checks and the full code gate remain separate evidence.
