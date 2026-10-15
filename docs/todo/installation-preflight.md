# Installation preflight execution dossier

## 1. Purpose

Provide a public storage assessment before a writer opens an existing installation, so a consumer can stop depending on private SQL, migration identifiers, and identity-file layouts. Aquarium requested this assessment on 2026-10-14. The contract is owned in this repository and does not authorize edits to the consumer repository.

[The roadmap](../roadmap/README.md#epic-014-non-mutating-installation-preflight) alone owns Epic and Task identity, order, dependencies, and delivery status. This dossier is the temporary execution integration map for that Epic. Do not copy lifecycle status into this file.

## 2. Must and must-not

The work must follow TASK-096 through TASK-100 in that order. TASK-096 must extend the Source of Truth checker to recognize milestone M8 and the adopted requirement vocabulary, with behavioral fixtures, before any preflight product code. Inspection must be non-mutating: no initialization, migration, repair, intent drain, lock creation or removal, journal change, WAL checkpoint, installation log write or rotation, configuration or Vault change, daemon start, or service change. A coherent temporary database snapshot is the inspection boundary, and the operational database must not be opened to produce it. Every home, Vault, database, process, and source used for proof must be test-only under an explicit temporary SORAGE_HOME. The Bun baseline remains 1.4.2. `bun run check:sot` and `make test` must pass before review. The checker must keep rejecting invalid milestones, missing requirement coverage, forward dependencies, reverse-index mismatches, broken links, and bad identifiers.

Do not implement `sorage preflight` product behavior, core assessment, adapter inspection, or CLI exposure in TASK-096. Do not start EPIC-015 or any successor Task from an unfinished Task. Do not change Task or Epic identifiers, acceptance criteria, public behavior, or order. Do not edit the accepted historical text of ADR-0028. Do not waive a failing Source of Truth gate. Do not use doctor as proof of the non-mutating boundary. Do not publish, install, or activate a consumer. Do not use Podway for this Epic or its preparation. Do not record runtime paths, session identifiers, provider logs, or transcripts in tracked documents.

## 3. Task goals

Keep this order. The roadmap rows remain the acceptance text.

1. TASK-096, Chore. Extend `scripts/sot-check.ts` and its behavioral fixtures to recognize M8. Update checker-capability wording only at the docs README M8 entrypoints, governance sections 11 and 13, roadmap section 2, traceability section 2, and testing AJ-24. Preserve accepted ADR history and the existing link, identifier, requirement, dependency, and reverse-index guards. Pass focused checker tests, `bun run check:sot`, and `make test` with no product-surface change. Depends on TASK-095. Cites NFR-015.
2. TASK-097, Contract. Implement the pure preflight assessment, version-1 report DTO, six statuses, check catalog, and exit mapping in `packages/core`. Expose no command or filesystem adapter. Depends on TASK-096. Cites PFL-003, PFL-005, and PFL-007.
3. TASK-098, Standard. Implement adapter inspection over coherent temporary DB/WAL copies, configuration, migration history, schema integrity, installation identity, fences, and permissions, with scratch cleanup and no operational connection. Depends on TASK-097. Cites PFL-002, PFL-004, PFL-005, and PFL-006.
4. TASK-099, Contract. Expose `sorage preflight` through `apps/cli` before initialization, with the report, existing envelope, documented exits, contextual no-log messages and recovery, human output, help, and completion, bypassing migration, intent drain, and failure logging. Depends on TASK-098. Cites PFL-001, PFL-002, PFL-003, and PFL-007.
5. TASK-100, Standard. Qualify AJ-24 on the complete preflight slice, add and retain the public example in `docs/specs/examples/cli-workflow.md` and the canonical no-write and upgrade limits, and prepare EPIC-014 acceptance without publishing. Depends on TASK-099. Cites PFL-001 through PFL-008.

## 4. Requirement owners

Normative text stays in the linked owners. Citing Tasks below are the roadmap Requirements column, not a second status list.

- NFR-015, milestone M1, [non-functional requirements](../specs/required-specification.md#16-non-functional-requirements). EPIC-014 owner: TASK-096.
- PFL-001 through PFL-008, milestone M8, [installation preflight](../specs/required-specification.md#19-installation-preflight-milestone-m8). Interface: [section 36](../specs/interfaces-and-operations.md#36-installation-preflight-milestone-m8), including [command and report](../specs/interfaces-and-operations.md#361-command-and-report) and [check catalog](../specs/interfaces-and-operations.md#362-check-catalog-and-inspection-boundary). Decision: [ADR-0028](../architecture-decision-records/README.md#adr-0028-non-mutating-installation-preflight-in-m8). Architecture boundary: [section 26](../architecture/README.md#26-m8-inspection-and-send-recovery-boundaries). Acceptance: [AJ-24](../specs/testing-and-acceptance.md#aj-24-non-mutating-installation-preflight).
- PFL-001: TASK-099, TASK-100. PFL-002: TASK-098, TASK-099, TASK-100. PFL-003: TASK-097, TASK-099, TASK-100. PFL-004: TASK-098, TASK-100. PFL-005: TASK-097, TASK-098, TASK-100. PFL-006: TASK-098, TASK-100. PFL-007: TASK-097, TASK-099, TASK-100. PFL-008: TASK-100.
- Group map: [traceability section 2](../specs/traceability.md#2-requirement-group-map).

SND-001 through SND-006 and GEN-016 through GEN-020 belong to EPIC-015. Do not implement them in this Epic.

## 5. Checks and handoff boundaries

TASK-096 owns this thin dossier, its index entry, the roadmap Detailed SOT link, the M8 checker and fixture extension, and the five scoped checker-status updates. Do not treat this dossier as evidence that any gate passed.

Before review of TASK-096, focused checker tests, `bun run check:sot`, and `make test` must exit 0. Chore completion still needs the change, one covering test, and no higher-authority conflict, as defined in [governance section 9](../governance/README.md#9-definition-of-done-by-task-class). The start conditions are [governance section 8](../governance/README.md#8-task-start-checklist). Design Gate impact remains Not required.

A later Task starts only after the current Task is accepted and progression is explicitly authorized. Check coordination, exact staging, task-commit, and progression stay outside this dossier. Repository edits for this Epic stay with one writer. EPIC-015 stays unstarted until EPIC-014 is complete and separately progressed.
