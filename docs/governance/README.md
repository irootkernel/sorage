# SOT Governance

## 1. Purpose

This document defines how the Sorage Source of Truth is interpreted, changed, and used during development.

## 2. Normative language

The terms `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are normative.

- `MUST` and `MUST NOT` define release-blocking requirements.
- `SHOULD` and `SHOULD NOT` define expected behavior. A deviation requires a recorded rationale.
- `MAY` defines an optional implementation choice that must not alter required behavior.

## 3. Authority order

When requirements conflict, use this order:

1. [../specs/required-specification.md](../specs/required-specification.md)
2. Accepted decisions in [../architecture-decision-records/README.md](../architecture-decision-records/README.md)
3. [../architecture/README.md](../architecture/README.md)
4. [../specs/interfaces-and-operations.md](../specs/interfaces-and-operations.md)
5. [../specs/security-reliability.md](../specs/security-reliability.md)
6. [../specs/testing-and-acceptance.md](../specs/testing-and-acceptance.md)
7. [../specs/traceability.md](../specs/traceability.md)
8. [../roadmap/README.md](../roadmap/README.md)
9. [../implementation-tips/README.md](../implementation-tips/README.md)
10. Examples, schemas, and comments

[../product/README.md](../product/README.md) and [../todo/future-work.md](../todo/future-work.md) are non-normative context rather than levels of this order: they record intent and deliberate exclusions, they may be cited as rationale, and they never override a normative document or settle a conflict.

Where two normative documents describe the same surface, the higher level owns it and the lower level points at it; the `doctor` check catalog, for example, is normative only in [../specs/interfaces-and-operations.md](../specs/interfaces-and-operations.md).

A conflict MUST stop the active Task, and the team MUST update the Source of Truth or record an architecture decision before continuing.

## 4. Material change control

A change is material when it affects any of the following:

- Domain terminology
- State transitions
- Identity resolution rules, including bindings, worktree resolution, and actor provenance
- Persistence format
- CLI command contract
- HTTP API contract
- File or Vault layout
- Configuration schema
- Security boundary
- Backup semantics
- Deletion semantics
- Milestone assignment of a requirement
- Multi-machine compatibility
- MVP scope
- Sorage naming or runtime identifiers
- The ecosystem boundary, meaning repository placement or the rule that ecosystem tools are never source dependencies

A material change MUST record:

1. Problem statement
2. Proposed decision
3. Alternatives considered, with the reason each was rejected
4. Compatibility impact
5. Migration impact
6. Required Source of Truth edits
7. New or amended architecture decision
8. Roadmap impact

Item 3 is not optional prose: every decision in [../architecture-decision-records/README.md](../architecture-decision-records/README.md) carries an `Alternatives considered` section, and a new decision without one is incomplete.

No implementation-only shortcut may become product behavior without this process.

## 5. Roadmap identifier governance

- Every Epic MUST have one globally unique identifier in the form `EPIC-NNN`.
- Every Task MUST have one globally unique identifier in the form `TASK-NNN`.
- Both forms use a zero-padded three-digit numeric component beginning at `001`.
- Task numbering is global across the roadmap and MUST NOT restart inside each Epic.
- Identifiers become immutable once committed to this repository, and an immutable identifier MUST NOT be reused, even when its item is completed, blocked, deferred, cancelled, or replaced (GEN-012).
- Before the first commit the roadmap is not yet published, so renumbering is permitted; v0.4.0 used that window to renumber the roadmap, and the window closes with the first commit.
- A renamed or rescheduled item retains its original identifier.
- Dependencies, reviews, commits, reports, and status updates MUST use complete canonical identifiers.
- Local shorthand or a title without an identifier is not an authoritative reference.

## 6. Task statuses

| Status | Meaning |
|---|---|
| `Planned` | Defined but not started |
| `In Progress` | The one Task currently being implemented |
| `In Review` | Implementation is complete and under review by a separate session |
| `Completed` | The acceptance gate passed and documentation is current |
| `Blocked` | Work cannot proceed; blocker and next action are documented |
| `Deferred` | Deliberately moved outside the current delivery scope |

These six words are the complete vocabulary, they are case-sensitive, and they MUST NOT be paraphrased, because the Aquarium roadmap commit gate matches them literally when it classifies this repository and reconciles lifecycle state.

## 7. Active slot rule

Delivery is sequential with one review overlap.

- At most one Task may be `In Progress`, and at most one other Task may be `In Review`.
- The Task in `In Review` MUST reach `Completed`, `Blocked`, or `Deferred` before a third Task leaves `Planned`.
- A Task may move from `Blocked` back to `In Progress` only when no other Task is `In Progress`.
- A blocked Task does not prevent a dependency-safe Task from starting, but the blocker, its owner, and its dependency impact MUST be recorded on the blocked Task.
- Epic status is advanced by the Aquarium epic handler rather than derived silently from its Tasks.
- The active pointer section of [../roadmap/README.md](../roadmap/README.md) holds `Active Epic`, `Active Task`, `In Review Task`, and `Next eligible Task`; no other file in this repository records delivery status, and a second status location is a governance defect rather than redundancy.

## 8. Task start checklist

Before changing a Task to `In Progress`, the implementer MUST:

- Confirm every dependency is `Completed` or explicitly waived by an accepted decision.
- Read the linked requirements and the decisions they cite.
- Declare the packages touched, using the five-package layout of [../architecture/README.md](../architecture/README.md).
- Declare the milestone the Task belongs to, one of `M1`, `M2`, `M3`, `M4`, `M5`, or `M6`.
- Verify that no requirement the Task cites carries a later milestone than the Task itself, because a requirement whose every citing Task lands after its own release gate cannot be satisfied at that gate; `scripts/sot-check` fails on exactly that condition.
- Declare the Task class, one of Chore, Standard, or Contract, as defined in section 9.
- Confirm the `Design Gate impact` cell, which is `Not required` for every Task in this repository because no Design Gate registry is enrolled, and record that reason rather than leaving the cell empty.
- Record the exact acceptance gate as an observable command with its expected exit code or state.
- Confirm the Task can be completed without starting another Task.

## 9. Definition of Done by Task class

Every Task declares one class, and the class fixes what `Completed` requires.

### 9.1 Chore

A Chore is a Task whose deliverable text starts with `Chore:`; it is closed when the change exists, one test covers it or a recorded reason states why a test does not apply, and no conflict with a higher-authority document remains.

### 9.2 Standard

A Standard Task is closed when all of the following hold:

- The required implementation exists and satisfies every requirement the Task cites.
- Unit and integration tests pass.
- Error paths are tested, not only the success path.
- Documentation and examples affected by the change are updated in the same change.
- The Task row in [../roadmap/README.md](../roadmap/README.md) and the active pointer are updated.
- No higher-authority conflict remains.
- The Reviewer confirms the acceptance gate.

### 9.3 Contract

A Contract Task is any Task that touches the `protocol` DTOs, the CLI JSON contract, an HTTP DTO, `../specs/schemas/config.schema.json`, or a database migration; it requires everything in 9.2 plus:

- The snapshot diff of the changed contract is reviewed and explicitly classified as breaking or non-breaking.
- The migration impact is recorded, including the upgrade fixture when the database schema changed.

## 10. Reviewer and review rules

The Reviewer is a separate AI session that runs the `task-review` phase of `$aquarium:task-handler`, which drives Mulgae against the completed Task target; it has no write access to the implementation diff, and its verdict is recorded in the Task implementation report.

The implementing session MUST NOT review its own work, and an unreviewed Standard or Contract Task MUST NOT reach `Completed`.

A review MUST verify:

- Behavioral compliance with the cited requirements, not only code style
- Transactional integrity, including that no `await` appears inside a `UnitOfWork.run` callback and that no filesystem I/O happens inside a transaction
- Intent-log invariants: intents committed with the domain change, executed afterwards, cleared in a second transaction, drained idempotently at process start, and never fabricating a missing file
- Failure recovery at the enumerated crash points
- Identity and provenance correctness, including binding resolution, git common-directory folding, `--as`, `--as-user`, and the downgrade guard
- CLI JSON stability and the documented exit codes
- For daemon work, the Host allowlist check before routing, the session token exchange, the response security headers, and the absence of cookies
- Path and file safety
- Concurrency behavior, including Row Version compare-and-set and idempotency replay ordering
- No unapproved scope expansion
- No hidden historical Artifact retention outside documented Git behavior

## 11. Commits and the Source of Truth check

- Every commit is created through `$aquarium:task-commit` once a roadmap file is tracked in this repository, because the Aquarium gate then classifies the whole repository as a roadmap repository and blocks direct shell commits.
- No session commits, amends, or pushes without an explicit instruction from the user for that exact action.
- A commit carries either one exact Task relationship with an approved lifecycle edit, or an explicit statement that it is unrelated to every active Task.
- `scripts/sot-check` verifies this document set, covering identifier uniqueness, dangling references, relative-link resolution, the schema against the example, the CLI and API surface against the error table, and the milestone rule of section 8; it MUST pass in CI on every change.
- `make test` is the single verification gate for code and MUST pass before a Task moves to `In Review`.

## 12. Release change freeze

Each milestone has its own release gate, and the freeze applies from the moment a milestone enters its release candidate until that gate passes. `M1` through `M5` are closed; post-MVP freezes apply per later milestone, beginning with `M4`, and `M6` is the current post-MVP gate (ADR-0026).

- Schema changes require an accepted architecture decision.
- CLI or API breaking changes require an accepted architecture decision.
- Configuration changes require migration tests.
- New features are deferred to the next milestone unless they resolve a release blocker for the milestone being frozen.
- A change that would move a requirement between milestones is a material change under section 4.
