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
6. [../specs/project-memos.md](../specs/project-memos.md), for the detailed Memo domain and its explicit M7 extensions
7. [../specs/testing-and-acceptance.md](../specs/testing-and-acceptance.md)
8. [../specs/traceability.md](../specs/traceability.md)
9. [../roadmap/README.md](../roadmap/README.md)
10. [../implementation-tips/README.md](../implementation-tips/README.md)
11. Examples, schemas, and comments

[../product/README.md](../product/README.md) and [../todo/future-work.md](../todo/future-work.md) are non-normative context rather than levels of this order: they record intent and deliberate exclusions, they may be cited as rationale, and they never override a normative document or settle a conflict.

Where two normative documents describe the same surface, the higher level owns it and the lower level points at it; the `doctor` check catalog, for example, is normative only in [../specs/interfaces-and-operations.md](../specs/interfaces-and-operations.md).

The Memo contract owns detailed Memo lifecycle, CLI/HTTP data, pending-attempt handling, and format-2 Memo shard/digest rules. Shared authentication, security, envelopes, and transaction guarantees remain with their higher-ranked owners. Those owners explicitly scope the unchanged Handoff replay rules and format-1 backup representation; Memo specificity alone is not permission to override them. Keep this order synchronized with the documentation index and root agent guidance.

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
- Declare the milestone the Task belongs to, one of `M1`, `M2`, `M3`, `M4`, `M5`, `M6`, `M7`, `M8`, or `M9`.
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

The Reviewer is a separate AI session with no write access to the implementation diff. A standalone Task uses the `task-review` phase of `$aquarium:task-handler`; a member Task in an explicitly invoked `$aquarium:epic-handler` workflow uses that handler's approved delegated review route against the exact Task candidate. The verdict and criterion assessments are recorded in the Task implementation report or the Epic handler's Goal evidence and commit handoff, respectively. A review waiver does not satisfy the Reviewer requirement for a Standard or Contract Task.

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
- `scripts/sot-check` verifies this document set, covering identifier uniqueness, dangling references, relative-link resolution, the schema against the example, the CLI and API surface against the error table, and the milestone rule of section 8; it MUST pass in CI on every change. Sections 13 to 15 record the M8 and M9 registration boundaries. Checker support for those milestones does not waive make test, a passing Source of Truth result, independent review, or Contract classification for later implementation.
- `make test` is the single verification gate for code and MUST pass before a Task moves to `In Review`.

## 12. Release change freeze

Each milestone has its own release gate, and the freeze applies from the moment a milestone enters its release candidate until that gate passes. `M1` through `M5` are closed; post-MVP freezes apply per later milestone, beginning with `M4`. `M6` is governed by ADR-0026, and ADR-0027 adds the separate successor `M7` gate. Current delivery and eligibility remain solely in the roadmap; registering M7 does not close M6.

- Schema changes require an accepted architecture decision.
- CLI or API breaking changes require an accepted architecture decision.
- Configuration changes require migration tests.
- New features are deferred to the next milestone unless they resolve a release blocker for the milestone being frozen.
- A change that would move a requirement between milestones is a material change under section 4.

## 13. M8 document-only registration boundary

ADR-0028 and ADR-0029 adopt shared M8 and SOT version 0.9.0 for EPIC-014 and EPIC-015, with intended product release v0.1.3. The [roadmap](../roadmap/README.md) alone records lifecycle and eligibility. This registration adopted documents and did not implement preflight, change the executable, rewrite the shipped skill, or authorize publication. TASK-096 adds M8 checker support, behavioral fixtures, and this status cleanup before product implementation. The checker now recognizes milestones M1 through M9 and still rejects invalid milestones, missing requirement coverage, forward dependencies, reverse-index mismatches, unresolved links, and bad identifiers.

This boundary waives neither make test nor later Contract review. No existing accepted milestone is reopened and no new Task is completed by writing its design.

## 14. M9 registration and adoption boundary

M9 registered the ordered work for [EPIC-016](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage), a temporary execution dossier and Proposed ADR-0030; registration authorized planning records and minimal M9 checker support only. TASK-105 then completed the adoption step: it accepted [ADR-0030](../architecture-decision-records/README.md#adr-0030-agent-communication-channels-and-shared-content-storage-in-m9) with its revision record, adopted SHR-001 to SHR-014 and CHN-001 to CHN-011 in required-specification section 21, amended the conflicting earlier rows in place, settled interface section 38, populated every EPIC-016 Requirements cell and traceability row including AJ-27 to AJ-29 and the M9 gate, and extended the `artifact.maxBytes` schema description to all three domains.

Adoption remains design authority, not delivery: it implements no Channel, no shared store, no migration, no product release assignment, and no installation or publication. The roadmap alone records lifecycle and eligibility; TASK-106 may start only after TASK-105 reaches a terminal state, and later implementation retains independent review, Contract classification, and the full verification gate. Uncited behavior stays unimplemented, and no adopted text bypasses a current contract that section 21 and its amended rows do not explicitly supersede.

## 15. M9 adoption-hardening registration boundary

M9 registers the ordered work for [EPIC-017](../roadmap/README.md#epic-017-channel-adoption-hardening-and-v013-release-readiness), a temporary execution dossier and [Proposed ADR-0033](../architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release) in response to Aquarium's Channel adoption request. Registration authorizes these planning records only. It changes no product code, test, checker, shipped skill, normative specification, CHANGELOG, release-gate row or Source of Truth version, allocates no release by itself, and starts no Task. EPIC-016's completed acceptance is not reopened.

Before TASK-112 begins, TASK-111 must accept or revise ADR-0033, record the shared v0.1.3 allocation that Master selected through a dated ADR-0030 amendment, the release-gate table and the CHANGELOG, and adopt the accepted contracts in their higher-authority owners. Following the EPIC-016 registration precedent, the registered Tasks temporarily use `None` in their Requirements cells; TASK-111 must replace those placeholders with accepted citations and matching traceability in the same design candidate. Later implementation retains independent review, Contract classification and the full verification gate.

TASK-111 executed this adoption on 2026-10-21: it accepted [ADR-0033](../architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release) with its recorded completions, added the dated ADR-0030 release-allocation amendment and the dated ADR-0032 storage-preparation-contention amendment, adopted SHR-015 and CHN-012 and the CHN-006, CHN-007, CHN-010, and CLI-020 amendments in required-specification section 21, settled interface sections 13 to 16 and 38 including the new 38.10 classification record, extended security-reliability sections 7 and the new 17, updated testing-and-acceptance including the AJ-24 to AJ-29 requirement headers and the M8 and M9 gate text, updated the release-gate rows and restructured the CHANGELOG for the shared v0.1.3, and populated every EPIC-017 Requirements cell and reverse-index row. This adoption is design authority, not delivery: implementation belongs to TASK-112 and later Tasks with their full gates.

On 2026-10-22 Master appended `TASK-117` and `TASK-118` under the roadmap's post-commit defect policy: TASK-117 corrects the ordinary `channel create` `IDEMPOTENCY_CONFLICT` and Channel `STORAGE_SCHEMA_UNSUPPORTED` recovery text, and TASK-118 corrects the shared Vault-open refusal guidance for every surface; this registration and its completion change the roadmap range and execution order, the interface section 38.10 rows, traceability, the dossier, the documentation index and the CHANGELOG, and change no canonical requirement, accepted decision, error code, exit, DTO or migration. TASK-118 also narrows the section 15 `VAULT_INTEGRITY_ERROR` and `CONFIG_INVALID` meanings, names the event-metadata invariant and backup-source parse path as non-open paths that keep the catalogue default, updates the section 35 doctor `home.permissions`, `config.schema`, `vault.marker`, `vault.gitattributes`, `vault.writable`, `artifacts.checksums`, `content.checksums` and `platform.tcc` rows, and makes `sorage init` refuse an unreadable or non-regular configuration; its observable output changes are the Vault-open messages and recoveries, the V2 listing-failure mapping, the doctor messages and recoveries including the configuration-access recoveries of `vault.writable` and `platform.tcc`, the `vault.gitattributes` actions (reconfiguration of a missing file or `.gitattributes` line with `--non-interactive`, and a manual `.gitignore` `staging/` entry), the operational access or path recovery for a configuration that cannot be read or whose path is a directory, a FIFO or another non-regular target, a dangling symlink, or a symlink loop (a live symlink to a regular configuration stays followed), on Channel, Handoff and Project commands, and that `init` refusal, while the error-code catalogue, its code-to-HTTP and code-to-exit mapping, DTO shapes, and doctor check ids, severities and count are unchanged, and no canonical requirement or migration changes.

On 2026-10-22 Master further appended `TASK-119` under the same post-commit defect policy, from the Epic Evaluator's F-b ruling on TASK-115's first observation: TASK-119 corrects the shared storage-preparation classification so a write-protected installation's readonly database-open and migration failures return the typed `STORAGE_INSPECTION_UNAVAILABLE` refusal with state-accurate recovery, and corrects the shared private-copy inspection so a stable, readable, write-protected installation inspects normally. This registration and its completion change the roadmap range and execution order, the interface section 38.10 row, traceability, the dossier, the documentation index and the CHANGELOG, and make these canonical edits: the SHR-015 clarification naming a write-protected installation among the covered unavailability causes, the ADR-0032 amendment dated 2026-10-22 extending the error family that record owns to the write-protected signature, the interface section 15 `STORAGE_INSPECTION_UNAVAILABLE` meaning cell clarified in place — with the same one-phrase clarification in the section 15 shared-layer paragraph and security-reliability section 7, named here as such — and the interface section 38.4 Channel recovery sentence naming the write-protected state and its restore-access recovery. No error code, exit, DTO, doctor check or migration changes: no section 15 or 16 row is added or removed and the code, HTTP and exit mapping of every code is unchanged, while the `STORAGE_INSPECTION_UNAVAILABLE` meaning text changes with the write-protected clarification; the actual responses on a write-protected installation change as the section 38.10 row records, including the daemon's Handoff and Project routes answering 503 instead of 500 there.

On 2026-10-22, under governance section 4, TASK-115 made one canonical precision edit: the security-reliability section 17 sentence about read-only callers now states that every Channel command except `submit --replay-only` writes the home's state database, that any of those commands may also need to write the Vault, and that `submit --replay-only` is the only Channel command that needs no write access to the home or the Vault — with no behavior, code, exit, HTTP or golden change and no migration.

On 2026-10-23, under governance section 4, TASK-120 made one canonical precision edit, from the Epic Evaluator's F-1 ruling on TASK-116's isolated v0.1.2-to-candidate upgrade drill: interface sections 6 and 6.2 now state the `vault verify` Vault policy-file check — the `.gitattributes` lines VLT-024 requires for the running build in their stated relative order, and the `.gitignore` `staging/` entry, each missing or disordered item a blocking finding — name the operations that re-assert the files and `doctor`'s `vault.gitattributes` warning, and the operations runbook's M9 post-upgrade procedure now creates and verifies the new backup before it verifies the Vault, because the first `backup run` with the new executable re-asserts the M9 policy lines — with no behavior, output, exit, HTTP, golden or migration change.
