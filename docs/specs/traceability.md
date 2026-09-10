# Requirement Traceability

## 1. Purpose

This document connects every normative requirement in [required-specification.md](required-specification.md) to the Tasks in [../roadmap/README.md](../roadmap/README.md) that implement it and to the evidence that proves it.

It exists so that three questions have mechanical answers: which Tasks a requirement depends on, which requirements a Task is allowed to change, and which requirements are still uncovered.

The roadmap is the source of the mapping; this document is derived from the `Requirements` column of its Task rows, so a change here that is not also a change there is a defect rather than a decision.

Milestone values come from the specification and name the release gate at whose passing the requirement must be fully satisfied, as defined in section 1 of [required-specification.md](required-specification.md).

`scripts/sot-check`, delivered by `TASK-008`, regenerates section 3 from the roadmap and fails the build when the two disagree, when a Task cites an identifier that does not exist, when a requirement that is not `Deferred` has no citing Task, or when every citing Task of a requirement belongs to a later milestone than the requirement itself.

## 2. Requirement group map

| Requirement group | Milestone | Implementing tasks | Acceptance evidence (AJ ids / test layer) |
|---|---|---|---|
| GEN-001 to GEN-015 | M1, M2, M4 | `TASK-001` to `TASK-002`, `TASK-005`, `TASK-008`, `TASK-039` to `TASK-042`, `TASK-051`, `TASK-064` to `TASK-065`, `TASK-080`, `TASK-082` | AJ-01, AJ-02, AJ-16, AJ-17; the dependency-boundary check in `make test-prepare` and the clean-home run in `make test-int` |
| INIT-001 to INIT-017 | M1, M3 | `TASK-009`, `TASK-012` to `TASK-014`, `TASK-020`, `TASK-025`, `TASK-043`, `TASK-053`, `TASK-056`, `TASK-059`, `TASK-068` to `TASK-069`, `TASK-073` | AJ-01, AJ-02, AJ-16; `make test-int` for idempotent init and `make test-contract` for the milestone-scoped `doctor` catalog snapshot |
| CFG-001 to CFG-020 | M1 | `TASK-010` to `TASK-013`, `TASK-015`, `TASK-026`, `TASK-045`, `TASK-061`, `TASK-063`, `TASK-072` | AJ-01, AJ-13; `make test-unit` for schema defaults and the comment round-trip, `make test-int` for atomic writes and ETag conflict, `make test-contract` for the schema against the example |
| RUN-001 to RUN-014 | M1, M2, M3 | `TASK-006` to `TASK-007`, `TASK-009`, `TASK-024`, `TASK-026`, `TASK-036`, `TASK-042` to `TASK-045`, `TASK-052`, `TASK-056`, `TASK-059`, `TASK-061`, `TASK-068` to `TASK-069`, `TASK-073` | AJ-01, AJ-09, AJ-11; `make test-int` for locks, drain, and `SERVICE_PAUSED`, `make test-contract` for health, readiness, and version |
| PRJ-001 to PRJ-022 | M1 | `TASK-015` to `TASK-020`, `TASK-029`, `TASK-050`, `TASK-066` | AJ-03, AJ-05; `make test-int` for worktree folding, binding precedence, alias ambiguity, and the workspace-root downgrade guard |
| VLT-001 to VLT-024 | M1, M2 | `TASK-003`, `TASK-012`, `TASK-021` to `TASK-026`, `TASK-029` to `TASK-030`, `TASK-032`, `TASK-034` to `TASK-035`, `TASK-044`, `TASK-046`, `TASK-052`, `TASK-055`, `TASK-063` | AJ-08 to AJ-10; `make test-int` for the intent log and the seven crash points, plus `sorage doctor` and `sorage vault verify` for exhaustive checksums |
| HND-001 to HND-026 | M1 | `TASK-027` to `TASK-030`, `TASK-032` to `TASK-033`, `TASK-035`, `TASK-038` to `TASK-039`, `TASK-080` to `TASK-082`, `TASK-084` | AJ-04, AJ-06, AJ-07, AJ-08, AJ-17, AJ-18; `make test-unit` for the transition table and `make test-contract` for the public representation |
| REV-001 to REV-017 | M1 | `TASK-027`, `TASK-031` to `TASK-032`, `TASK-049` | AJ-04, AJ-07, AJ-13; `make test-unit` for the Note rules and `make test-int` for atomic resolution |
| LIFE-001 to LIFE-018 | M1 | `TASK-028`, `TASK-033` to `TASK-034`, `TASK-049`, `TASK-081` | AJ-04, AJ-07, AJ-10, AJ-17; `make test-int` for terminal immutability, tombstone rejection, retention, and the two-phase deletion |
| CLI-001 to CLI-023 | M1, M3, M4 | `TASK-004` to `TASK-005`, `TASK-013`, `TASK-017` to `TASK-018`, `TASK-026`, `TASK-029` to `TASK-034`, `TASK-036` to `TASK-037`, `TASK-040`, `TASK-055`, `TASK-057`, `TASK-064` to `TASK-065`, `TASK-067`, `TASK-080` to `TASK-082` | AJ-01 to AJ-10, AJ-17; `make test-contract` for golden envelopes, exit-code categories, and cursors |
| API-001 to API-013 | M2, M5 | `TASK-042`, `TASK-045` to `TASK-048`, `TASK-060`, `TASK-067`, `TASK-070`, `TASK-084` | AJ-11, AJ-12, AJ-13, AJ-18; `make test-contract` for the symbolic-error to HTTP-status matrix and the DTOs |
| WEB-001 to WEB-019 | M2, M5, Deferred | `TASK-045`, `TASK-047` to `TASK-051`, `TASK-058`, `TASK-060`, `TASK-067`, `TASK-084` | AJ-12, AJ-13, AJ-18; `make test-e2e` under Playwright with the axe-core check as engineering practice |
| BKP-001 to BKP-026 | M3 | `TASK-052` to `TASK-058`, `TASK-061`, `TASK-065` | AJ-14, AJ-15; `make test-int` with the fault-injection Git adapter, plus `sorage backup verify` |
| SEC-001 to SEC-021 | M1, M2 | `TASK-006` to `TASK-007`, `TASK-011`, `TASK-013`, `TASK-018`, `TASK-023` to `TASK-025`, `TASK-027` to `TASK-028`, `TASK-035`, `TASK-040` to `TASK-044`, `TASK-052`, `TASK-057`, `TASK-060` to `TASK-061`, `TASK-063`, `TASK-068`, `TASK-070` to `TASK-071` | AJ-08, AJ-10, AJ-12, AJ-13; the security matrix inside `make test` and the crash-point suite in `make test-int` |
| NFR-001 to NFR-017 | M1, M3 | `TASK-001` to `TASK-006`, `TASK-008`, `TASK-014` to `TASK-015`, `TASK-022`, `TASK-027`, `TASK-030`, `TASK-036` to `TASK-037`, `TASK-041`, `TASK-047`, `TASK-051`, `TASK-062` to `TASK-065`, `TASK-073`, `TASK-080`, `TASK-083` to `TASK-084` | AJ-16; `make test-prepare` for boundaries and the toolchain pin, `make test-contract` for versioned contracts, and the scale run of `TASK-062` |

`WEB-016` is the only `Deferred` requirement and therefore the only identifier with no implementing Task; within the MVP, Vault relocation is `sorage vault move --to <path>`, delivered by `TASK-026`.

Acceptance journeys are numbered per milestone: AJ-01 to AJ-10 close the M1 CLI gate, AJ-11 to AJ-13 close the M2 daemon and Web gate, AJ-14 to AJ-16 close the M3 MVP gate, AJ-17 closes the M4 CLI detail-read gate, and AJ-18 closes the M5 Web body-compose gate, as recorded in section 6 of [../roadmap/README.md](../roadmap/README.md).

## 3. Reverse index

This section lists every requirement identifier in the specification with the Tasks whose `Requirements` cell cites it, and it is generated from the roadmap rather than maintained by hand.

A requirement cited by several Tasks is normal: one Task usually establishes the behavior and later Tasks extend it into the daemon, the Web UI, or the release gate.

An entry reading `None` for a requirement that is not `Deferred` is a coverage gap and blocks the milestone whose gate the requirement belongs to, and so is a requirement whose citing Tasks all sit in a later milestone than the requirement itself.

| Requirement | Milestone | Citing tasks |
|---|---|---|
| `GEN-001` | M1 | `TASK-001`, `TASK-005`, `TASK-040`, `TASK-075`, `TASK-077` |
| `GEN-002` | M1 | `TASK-041`, `TASK-064`, `TASK-077`, `TASK-078` |
| `GEN-003` | M1 | `TASK-001` |
| `GEN-004` | M1 | `TASK-041` |
| `GEN-005` | M2 | `TASK-042` |
| `GEN-006` | M2 | `TASK-042`, `TASK-051` |
| `GEN-007` | M1 | `TASK-041` |
| `GEN-008` | M1 | `TASK-041` |
| `GEN-009` | M1 | `TASK-002` |
| `GEN-010` | M1 | `TASK-002`, `TASK-041` |
| `GEN-011` | M1 | `TASK-039`, `TASK-082` |
| `GEN-012` | M1 | `TASK-008`, `TASK-065` |
| `GEN-013` | M1 | `TASK-041`, `TASK-051`, `TASK-065` |
| `GEN-014` | M1 | `TASK-039`, `TASK-082` |
| `GEN-015` | M4 | `TASK-080`, `TASK-082` |
| `INIT-001` | M1 | `TASK-009` |
| `INIT-002` | M1 | `TASK-009` |
| `INIT-003` | M1 | `TASK-012`, `TASK-043` |
| `INIT-004` | M3 | `TASK-059`, `TASK-069` |
| `INIT-005` | M1 | `TASK-012` |
| `INIT-006` | M1 | `TASK-012`, `TASK-073` |
| `INIT-007` | M3 | `TASK-053`, `TASK-059` |
| `INIT-008` | M3 | `TASK-056`, `TASK-059` |
| `INIT-009` | M3 | `TASK-059`, `TASK-073` |
| `INIT-010` | M3 | `TASK-059` |
| `INIT-011` | M1 | `TASK-013` |
| `INIT-012` | M1 | `TASK-013` |
| `INIT-013` | M1 | `TASK-012` |
| `INIT-014` | M1 | `TASK-014` |
| `INIT-015` | M1 | `TASK-009` |
| `INIT-016` | M3 | `TASK-059`, `TASK-069` |
| `INIT-017` | M1 | `TASK-014`, `TASK-020`, `TASK-025`, `TASK-068` |
| `CFG-001` | M1 | `TASK-010`, `TASK-063` |
| `CFG-002` | M1 | `TASK-010`, `TASK-063` |
| `CFG-003` | M1 | `TASK-010`, `TASK-012` |
| `CFG-004` | M1 | `TASK-010` |
| `CFG-005` | M1 | `TASK-010` |
| `CFG-006` | M1 | `TASK-010` |
| `CFG-007` | M1 | `TASK-010` |
| `CFG-008` | M1 | `TASK-010` |
| `CFG-009` | M1 | `TASK-010` |
| `CFG-010` | M1 | `TASK-011` |
| `CFG-011` | M1 | `TASK-011`, `TASK-072` |
| `CFG-012` | M1 | `TASK-011` |
| `CFG-013` | M1 | `TASK-013`, `TASK-026` |
| `CFG-014` | M1 | `TASK-026` |
| `CFG-015` | M1 | `TASK-011`, `TASK-061`, `TASK-072` |
| `CFG-016` | M1 | `TASK-013`, `TASK-045` |
| `CFG-017` | M1 | `TASK-015` |
| `CFG-018` | M1 | `TASK-010` |
| `CFG-019` | M1 | `TASK-011`, `TASK-045` |
| `CFG-020` | M1 | `TASK-010` |
| `RUN-001` | M1 | `TASK-006`, `TASK-009`, `TASK-061` |
| `RUN-002` | M1 | `TASK-024`, `TASK-056`, `TASK-061` |
| `RUN-003` | M1 | `TASK-036` |
| `RUN-004` | M1 | `TASK-036` |
| `RUN-005` | M2 | `TASK-042`, `TASK-073` |
| `RUN-006` | M2 | `TASK-044` |
| `RUN-007` | M3 | `TASK-059`, `TASK-069`, `TASK-073`, `TASK-074` |
| `RUN-008` | M2 | `TASK-044`, `TASK-045` |
| `RUN-009` | M1 | `TASK-007` |
| `RUN-010` | M1 | `TASK-007` |
| `RUN-011` | M3 | `TASK-059`, `TASK-074` |
| `RUN-012` | M2 | `TASK-043` |
| `RUN-013` | M2 | `TASK-044`, `TASK-068` |
| `RUN-014` | M1 | `TASK-026`, `TASK-052` |
| `PRJ-001` | M1 | `TASK-015` |
| `PRJ-002` | M1 | `TASK-015` |
| `PRJ-003` | M1 | `TASK-016` |
| `PRJ-004` | M1 | `TASK-016`, `TASK-020` |
| `PRJ-005` | M1 | `TASK-015` |
| `PRJ-006` | M1 | `TASK-015`, `TASK-018`, `TASK-066` |
| `PRJ-007` | M1 | `TASK-018` |
| `PRJ-008` | M1 | `TASK-018` |
| `PRJ-009` | M1 | `TASK-017` |
| `PRJ-010` | M1 | `TASK-017` |
| `PRJ-011` | M1 | `TASK-016` |
| `PRJ-012` | M1 | `TASK-020`, `TASK-029` |
| `PRJ-013` | M1 | `TASK-019` |
| `PRJ-014` | M1 | `TASK-019` |
| `PRJ-015` | M1 | `TASK-019` |
| `PRJ-016` | M1 | `TASK-015`, `TASK-017`, `TASK-050` |
| `PRJ-017` | M1 | `TASK-018` |
| `PRJ-018` | M1 | `TASK-018`, `TASK-066` |
| `PRJ-019` | M1 | `TASK-019`, `TASK-029` |
| `PRJ-020` | M1 | `TASK-019` |
| `PRJ-021` | M1 | `TASK-017` |
| `PRJ-022` | M1 | `TASK-016`, `TASK-017`, `TASK-020`, `TASK-050` |
| `VLT-001` | M1 | `TASK-012` |
| `VLT-002` | M1 | `TASK-012`, `TASK-021` |
| `VLT-003` | M1 | `TASK-021` |
| `VLT-004` | M1 | `TASK-022` |
| `VLT-005` | M1 | `TASK-022` |
| `VLT-006` | M1 | `TASK-022` |
| `VLT-007` | M1 | `TASK-022` |
| `VLT-008` | M1 | `TASK-023` |
| `VLT-009` | M1 | `TASK-030` |
| `VLT-010` | M2 | `TASK-046` |
| `VLT-011` | M1 | `TASK-032` |
| `VLT-012` | M1 | `TASK-024`, `TASK-032` |
| `VLT-013` | M1 | `TASK-024` |
| `VLT-014` | M1 | `TASK-024`, `TASK-035` |
| `VLT-015` | M1 | `TASK-023` |
| `VLT-016` | M1 | `TASK-023` |
| `VLT-017` | M1 | `TASK-023` |
| `VLT-018` | M1 | `TASK-023` |
| `VLT-019` | M1 | `TASK-021`, `TASK-026`, `TASK-052`, `TASK-063` |
| `VLT-020` | M1 | `TASK-022` |
| `VLT-021` | M1 | `TASK-024`, `TASK-029`, `TASK-035` |
| `VLT-022` | M1 | `TASK-003`, `TASK-024`, `TASK-035` |
| `VLT-023` | M1 | `TASK-025`, `TASK-034`, `TASK-044`, `TASK-055` |
| `VLT-024` | M1 | `TASK-012`, `TASK-021` |
| `HND-001` | M1 | `TASK-027` |
| `HND-002` | M1 | `TASK-029` |
| `HND-003` | M1 | `TASK-028` |
| `HND-004` | M1 | `TASK-028` |
| `HND-005` | M1 | `TASK-027` |
| `HND-006` | M1 | `TASK-029` |
| `HND-007` | M1 | `TASK-027` |
| `HND-008` | M1 | `TASK-029`, `TASK-035` |
| `HND-009` | M1 | `TASK-029` |
| `HND-010` | M1 | `TASK-030` |
| `HND-011` | M1 | `TASK-030` |
| `HND-012` | M1 | `TASK-030` |
| `HND-013` | M1 | `TASK-028` |
| `HND-014` | M1 | `TASK-028`, `TASK-033` |
| `HND-015` | M1 | `TASK-032` |
| `HND-016` | M1 | `TASK-028` |
| `HND-017` | M1 | `TASK-028`, `TASK-080`, `TASK-081` |
| `HND-018` | M1 | `TASK-029` |
| `HND-019` | M1 | `TASK-028` |
| `HND-020` | M1 | `TASK-030`, `TASK-080`, `TASK-081` |
| `HND-021` | M1 | `TASK-033` |
| `HND-022` | M1 | `TASK-033` |
| `HND-023` | M1 | `TASK-029`, `TASK-084` |
| `HND-024` | M1 | `TASK-030` |
| `HND-025` | M1 | `TASK-028`, `TASK-081` |
| `HND-026` | M1 | `TASK-038`, `TASK-039`, `TASK-082` |
| `REV-001` | M1 | `TASK-027` |
| `REV-002` | M1 | `TASK-031` |
| `REV-003` | M1 | `TASK-031` |
| `REV-004` | M1 | `TASK-031` |
| `REV-005` | M1 | `TASK-031` |
| `REV-006` | M1 | `TASK-031` |
| `REV-007` | M1 | `TASK-031` |
| `REV-008` | M1 | `TASK-032` |
| `REV-009` | M1 | `TASK-032` |
| `REV-010` | M1 | `TASK-032` |
| `REV-011` | M1 | `TASK-032` |
| `REV-012` | M1 | `TASK-032` |
| `REV-013` | M1 | `TASK-032` |
| `REV-014` | M1 | `TASK-031` |
| `REV-015` | M1 | `TASK-031`, `TASK-049` |
| `REV-016` | M1 | `TASK-031` |
| `REV-017` | M1 | `TASK-032` |
| `LIFE-001` | M1 | `TASK-033` |
| `LIFE-002` | M1 | `TASK-033` |
| `LIFE-003` | M1 | `TASK-033` |
| `LIFE-004` | M1 | `TASK-033` |
| `LIFE-005` | M1 | `TASK-033` |
| `LIFE-006` | M1 | `TASK-033` |
| `LIFE-007` | M1 | `TASK-034` |
| `LIFE-008` | M1 | `TASK-034` |
| `LIFE-009` | M1 | `TASK-034` |
| `LIFE-010` | M1 | `TASK-034` |
| `LIFE-011` | M1 | `TASK-034`, `TASK-049` |
| `LIFE-012` | M1 | `TASK-034`, `TASK-049` |
| `LIFE-013` | M1 | `TASK-034` |
| `LIFE-014` | M1 | `TASK-034` |
| `LIFE-015` | M1 | `TASK-034` |
| `LIFE-016` | M1 | `TASK-034` |
| `LIFE-017` | M1 | `TASK-028`, `TASK-033` |
| `LIFE-018` | M1 | `TASK-028`, `TASK-034`, `TASK-081` |
| `CLI-001` | M1 | `TASK-005`, `TASK-036`, `TASK-081` |
| `CLI-002` | M1 | `TASK-005`, `TASK-036`, `TASK-075`, `TASK-077`, `TASK-081` |
| `CLI-003` | M1 | `TASK-005`, `TASK-036` |
| `CLI-004` | M1 | `TASK-004`, `TASK-037`, `TASK-081` |
| `CLI-005` | M1 | `TASK-005`, `TASK-037` |
| `CLI-006` | M3 | `TASK-055`, `TASK-065` |
| `CLI-007` | M1 | `TASK-029` |
| `CLI-008` | M1 | `TASK-029` |
| `CLI-009` | M1 | `TASK-030`, `TASK-067` |
| `CLI-010` | M1 | `TASK-030` |
| `CLI-011` | M1 | `TASK-031` |
| `CLI-012` | M1 | `TASK-032` |
| `CLI-013` | M1 | `TASK-033` |
| `CLI-014` | M1 | `TASK-005`, `TASK-013`, `TASK-034` |
| `CLI-015` | M1 | `TASK-040`, `TASK-064` |
| `CLI-016` | M1 | `TASK-037`, `TASK-040` |
| `CLI-017` | M1 | `TASK-018`, `TASK-036` |
| `CLI-018` | M1 | `TASK-036` |
| `CLI-019` | M1 | `TASK-013`, `TASK-017`, `TASK-026`, `TASK-031`, `TASK-034`, `TASK-036`, `TASK-057` |
| `CLI-020` | M1 | `TASK-018`, `TASK-036` |
| `CLI-021` | M1 | `TASK-029` |
| `CLI-022` | M4 | `TASK-080`, `TASK-081`, `TASK-082` |
| `CLI-023` | M4 | `TASK-080`, `TASK-081` |
| `API-001` | M2 | `TASK-042` |
| `API-002` | M2 | `TASK-046` |
| `API-003` | M2 | `TASK-047`, `TASK-084` |
| `API-004` | M2 | `TASK-046` |
| `API-005` | M2 | `TASK-045`, `TASK-046`, `TASK-070`, `TASK-084` |
| `API-006` | M2 | `TASK-042` |
| `API-007` | M2 | `TASK-046`, `TASK-048` |
| `API-008` | M2 | `TASK-046`, `TASK-067` |
| `API-009` | M2 | `TASK-046`, `TASK-060` |
| `API-010` | M2 | `TASK-048`, `TASK-060` |
| `API-011` | M2 | `TASK-046` |
| `API-012` | M2 | `TASK-046` |
| `API-013` | M5 | `TASK-084` |
| `WEB-001` | M2 | `TASK-048` |
| `WEB-002` | M2 | `TASK-048`, `TASK-058`, `TASK-079` |
| `WEB-003` | M2 | `TASK-048`, `TASK-067`, `TASK-079` |
| `WEB-004` | M2 | `TASK-048`, `TASK-079` |
| `WEB-005` | M2 | `TASK-048` |
| `WEB-006` | M2 | `TASK-048`, `TASK-060` |
| `WEB-007` | M2 | `TASK-047`, `TASK-084` |
| `WEB-008` | M2 | `TASK-047`, `TASK-084` |
| `WEB-009` | M2 | `TASK-050` |
| `WEB-010` | M2 | `TASK-050` |
| `WEB-011` | M2 | `TASK-049` |
| `WEB-012` | M2 | `TASK-045` |
| `WEB-013` | M2 | `TASK-045` |
| `WEB-014` | M2 | `TASK-045` |
| `WEB-015` | M2 | `TASK-045` |
| `WEB-016` | Deferred | None |
| `WEB-017` | M2 | `TASK-048`, `TASK-084` |
| `WEB-018` | M2 | `TASK-051`, `TASK-079` |
| `WEB-019` | M5 | `TASK-084` |
| `BKP-001` | M3 | `TASK-053` |
| `BKP-002` | M3 | `TASK-056` |
| `BKP-003` | M3 | `TASK-052` |
| `BKP-004` | M3 | `TASK-053` |
| `BKP-005` | M3 | `TASK-052` |
| `BKP-006` | M3 | `TASK-054`, `TASK-061` |
| `BKP-007` | M3 | `TASK-052` |
| `BKP-008` | M3 | `TASK-052` |
| `BKP-009` | M3 | `TASK-054` |
| `BKP-010` | M3 | `TASK-054` |
| `BKP-011` | M3 | `TASK-057` |
| `BKP-012` | M3 | `TASK-057` |
| `BKP-013` | M3 | `TASK-054` |
| `BKP-014` | M3 | `TASK-057` |
| `BKP-015` | M3 | `TASK-056` |
| `BKP-016` | M3 | `TASK-055` |
| `BKP-017` | M3 | `TASK-055`, `TASK-057` |
| `BKP-018` | M3 | `TASK-058` |
| `BKP-019` | M3 | `TASK-058` |
| `BKP-020` | M3 | `TASK-058`, `TASK-065` |
| `BKP-021` | M3 | `TASK-052` |
| `BKP-022` | M3 | `TASK-053` |
| `BKP-023` | M3 | `TASK-052` |
| `BKP-024` | M3 | `TASK-052`, `TASK-054` |
| `BKP-025` | M3 | `TASK-057` |
| `BKP-026` | M3 | `TASK-056` |
| `SEC-001` | M2 | `TASK-042` |
| `SEC-002` | M2 | `TASK-043`, `TASK-068` |
| `SEC-003` | M2 | `TASK-043` |
| `SEC-004` | M1 | `TASK-013`, `TASK-018`, `TASK-057`, `TASK-060`, `TASK-071` |
| `SEC-005` | M1 | `TASK-013`, `TASK-018`, `TASK-057`, `TASK-060`, `TASK-071` |
| `SEC-006` | M1 | `TASK-023`, `TASK-060` |
| `SEC-007` | M1 | `TASK-023`, `TASK-060` |
| `SEC-008` | M1 | `TASK-006`, `TASK-028`, `TASK-061` |
| `SEC-009` | M1 | `TASK-024`, `TASK-035`, `TASK-061` |
| `SEC-010` | M1 | `TASK-007`, `TASK-060` |
| `SEC-011` | M1 | `TASK-007`, `TASK-052`, `TASK-060` |
| `SEC-012` | M1 | `TASK-027`, `TASK-028` |
| `SEC-013` | M1 | `TASK-028`, `TASK-041`, `TASK-060` |
| `SEC-014` | M1 | `TASK-025`, `TASK-052` |
| `SEC-015` | M2 | `TASK-044`, `TASK-061` |
| `SEC-016` | M1 | `TASK-006`, `TASK-011`, `TASK-061`, `TASK-063` |
| `SEC-017` | M2 | `TASK-042`, `TASK-060`, `TASK-071` |
| `SEC-018` | M2 | `TASK-042`, `TASK-060` |
| `SEC-019` | M2 | `TASK-043`, `TASK-060` |
| `SEC-020` | M2 | `TASK-043`, `TASK-060`, `TASK-070` |
| `SEC-021` | M1 | `TASK-028`, `TASK-040`, `TASK-060` |
| `NFR-001` | M1 | `TASK-001` |
| `NFR-002` | M1 | `TASK-002` |
| `NFR-003` | M1 | `TASK-004`, `TASK-005`, `TASK-051`, `TASK-065`, `TASK-073`, `TASK-075`, `TASK-077`, `TASK-078` |
| `NFR-004` | M3 | `TASK-062` |
| `NFR-005` | M1 | `TASK-022`, `TASK-047`, `TASK-084` |
| `NFR-006` | M1 | `TASK-004`, `TASK-030`, `TASK-062` |
| `NFR-007` | M1 | `TASK-004` |
| `NFR-008` | M1 | `TASK-003`, `TASK-004` |
| `NFR-009` | M1 | `TASK-006`, `TASK-015`, `TASK-027`, `TASK-063` |
| `NFR-010` | M1 | `TASK-014`, `TASK-037` |
| `NFR-011` | M1 | `TASK-004`, `TASK-036` |
| `NFR-012` | M1 | `TASK-001`, `TASK-041`, `TASK-064`, `TASK-073`, `TASK-077`, `TASK-078` |
| `NFR-013` | M1 | `TASK-001`, `TASK-041`, `TASK-064`, `TASK-077`, `TASK-078` |
| `NFR-014` | M1 | `TASK-002` |
| `NFR-015` | M1 | `TASK-008`, `TASK-065`, `TASK-076`, `TASK-080`, `TASK-083` |
| `NFR-016` | M1 | `TASK-001`, `TASK-002`, `TASK-003`, `TASK-074`, `TASK-076`, `TASK-078` |
| `NFR-017` | M1 | `TASK-001`, `TASK-064` |

## 4. Task review requirement

Every Task review records the following list, and a review that omits an item is incomplete rather than lenient.

- Canonical Task identifier and its parent Epic identifier.
- Milestone and Task class, one of Chore, Standard, or Contract, as defined in section 9 of [../governance/README.md](../governance/README.md).
- Requirement identifiers implemented, which MUST equal the `Requirements` cell of the Task row in [../roadmap/README.md](../roadmap/README.md).
- Requirement identifiers tested, with the test layer for each, one of `test-unit`, `test-int`, `test-contract`, or `test-e2e`.
- Requirement identifiers deliberately unaffected that a reader might expect this Task to touch, with the reason.
- Architecture decisions changed or newly relied upon, by ADR identifier.
- Contract snapshots changed, meaning protocol DTOs, CLI JSON envelopes, HTTP DTOs, the error table, `schemas/config.schema.json`, or the `doctor` catalog, each classified explicitly as breaking or non-breaking.
- Migration impact, including the schema version reached, whether the captured upgrade fixture still passes, and whether a configuration migration is required.
- Design Gate impact, which is `Not required` for every Task in this repository because no Design Gate registry is enrolled, recorded rather than left empty.
- Remaining known gaps, each either a new Task appended to the Active Epic or an explicit statement that the gap is out of the current milestone's scope.

A Contract Task additionally records the reviewed snapshot diff, and a Task that reports a breaking contract change without an accepted architecture decision MUST NOT reach `Completed`.

## 5. Merge rule

A code change that cannot be mapped to a requirement identifier in [required-specification.md](required-specification.md) or to an approved maintenance Task in [../roadmap/README.md](../roadmap/README.md) MUST NOT merge.

The remedy is to update the Source of Truth or to append a Task, not to merge the change and reconcile the documents afterwards.

This rule is what makes section 3 meaningful: if every merged change carries a requirement, then a requirement with no citing Task is genuinely unimplemented rather than merely undocumented.
