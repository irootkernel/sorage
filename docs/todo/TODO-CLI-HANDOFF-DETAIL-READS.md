# CLI Handoff detail reads

## Roadmap ownership

- **Adopted Epic:** `EPIC-010`
- **Canonical roadmap:** [../roadmap/README.md](../roadmap/README.md)
- **Decision:** [ADR-0024](../architecture-decision-records/README.md)

## Goal

Let an AI session acting as a Project read the current Review Note and the bounded metadata timeline through `sorage … --json` without a daemon, using the same application use cases the HTTP detail surface already calls.

## Scope and approach

`TASK-080` adopts the post-MVP milestone `M4` and this Source of Truth: Source of Truth version `0.5.0`, ADR-0024, `GEN-015`, `CLI-022`, `CLI-023`, the command catalog, examples, traceability, and the M4 gate. It does not ship CLI commands.

`TASK-081` wires `sorage review show` and `sorage events` to `readReviewNote` and `readHandoffTimeline`, adds CLI JSON goldens, and classifies the contract diff as additive non-breaking. `sorage get` stays metadata only.

`TASK-082` rewrites `skills/use-sorage/SKILL.md` so that requested Handoff processing reads the Note through `review show` before `revise`, keeps GEN-014 for box checks, extends `cli-workflow.md`, and records a fresh skill walkthrough plus AJ-17.

## Required actions

- Close `EPIC-009` through the Aquarium epic handler or validator before starting `TASK-080`. Do not append these Tasks to `EPIC-009`.
- Keep `sorage get` metadata-only. Do not fold the Note body or the timeline into that envelope.
- Call existing `core` use cases. Do not add a second Review Note store or a native Artifact history.
- Keep GEN-014: an inbox or outbox check reports the requested box and does not open the Note.
- Teach the skill the sender sequence `get` → `review show` → `fetch` → `revise`, and state that `get` has no Note body and that a sender `fetch` does not set `firstFetchedAt`.
- Classify new CLI goldens as additive non-breaking. Record that classification on `TASK-081`.
- Leave copies of the skill installed outside this repository for a separate update.

## Prohibited actions

- Do not change the review state machine, fetch semantics, or Vault layout.
- Do not add `--needs-action`, `fetch --to`, MCP, Artifact bundles, Linux packaging, or human-only inbox sender rendering.
- Do not edit managed Vault files from the skill.
- Do not reopen `M1`, `M2`, or `M3`.

## Acceptance

The Epic is accepted when `sorage review show --json` and `sorage events --json` match the HTTP detail reads, `sorage get` is unchanged, AJ-01 to AJ-16 still pass, AJ-17 passes, the skill walkthrough covers a box-only outbox check that does not open the Note and a processing request that reads the Note before `revise`, and `make test` exits 0.
