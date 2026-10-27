# Sorage documentation

The repository root [README](../README.md) introduces Sorage to users. The root [CHANGELOG](../CHANGELOG.md) records concise shipped outcomes and the planned next stable release. This directory is for maintainers and contributors. It contains the implementation contracts, architecture, decisions, development guidance, operations, and delivery state.

## Documentation profile

- **Profile:** `single-scope`
- **Delivery scope:** Sorage
- **Canonical roadmap:** [roadmap/README.md](roadmap/README.md)
- **Language:** English for the root README, changelog, and all Markdown under `docs/`
- **Source of Truth version:** `0.10.0`

## Role ownership

| Role | Canonical owner | Responsibility |
|---|---|---|
| Specifications | [specs/README.md](specs/README.md) | Required behavior, interfaces, security, acceptance, traceability, schemas, and examples |
| Architecture | [architecture/README.md](architecture/README.md) | Current components, boundaries, state, storage, and data flow |
| Architecture decision records | [architecture-decision-records/README.md](architecture-decision-records/README.md) | Accepted and superseded decisions with rationale |
| Implementation tips | [implementation-tips/README.md](implementation-tips/README.md) | Non-normative engineering and release guidance |
| Operations | [ops/README.md](ops/README.md) | Local macOS installation, daemon, diagnosis, backup, recovery, and escalation |
| Roadmap | [roadmap/README.md](roadmap/README.md) | Epic and Task identity, dependencies, ordering, status, and active pointers |
| TODO | [todo/README.md](todo/README.md) | Future candidates and temporary active-Epic dossiers |
| Deferred feedback | [deferred-feedback/README.md](deferred-feedback/README.md) | Small actionable findings intentionally postponed |

[governance/README.md](governance/README.md) defines SOT change control and Task completion. [product/README.md](product/README.md) provides non-normative product context. The changelog is a public release-notes document. It is not a Source of Truth role and does not record roadmap status.

## Project Memo design entrypoints

The M7 [Project Memo contract](specs/project-memos.md) defines the independent reminder domain. Its required outcomes are [MEM-001 to MEM-024](specs/required-specification.md#18-project-memos), its material decision is [ADR-0027](architecture-decision-records/README.md#adr-0027-project-memos-as-a-separate-domain-in-m7), and its ordered execution plan is [EPIC-013](roadmap/README.md#epic-013-project-memos). These documents specify required behavior; the roadmap alone determines implementation readiness. The M7 design registration did not allocate a product release or complete any existing work.

## M8 design entrypoints

The [required specification](specs/required-specification.md#19-installation-preflight-milestone-m8) defines PFL-001 through PFL-008, SND-001 through SND-006 and GEN-016 through GEN-020. The [preflight contract](specs/interfaces-and-operations.md#36-installation-preflight-milestone-m8) and [send recovery and agent policy contract](specs/interfaces-and-operations.md#37-send-replay-only-and-agent-policy-milestone-m8) detail their interfaces. ADR-0028 and ADR-0029 record their accepted design. [The roadmap](roadmap/README.md#epic-014-non-mutating-installation-preflight) allocates EPIC-014 and EPIC-015 to shared M8, with AJ-24 through AJ-26 and intended product release v0.1.3.

This adoption changes documents only. It does not implement commands, rewrite the shipped skill, change the executable version, start a Task, or authorize installation or publication. TASK-096 owns support for M8 and scoped checker-status documentation cleanup. The Source of Truth checker now recognizes milestones M1 through M9 and citations of PFL-001 through PFL-008, SND-001 through SND-006, and GEN-016 through GEN-020. It still rejects invalid milestones, missing requirement coverage, forward dependencies, reverse-index mismatches, unresolved links, and bad identifiers. Completed M7 outcomes and past skill evidence remain preserved.

## M9 design entrypoints

[EPIC-016](roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage) delivers agent communication channels and shared SQLite/Vault content storage. Its lasting design and delivery boundaries belong to the canonical owners below. TASK-105 accepted [ADR-0030](architecture-decision-records/README.md#adr-0030-agent-communication-channels-and-shared-content-storage-in-m9) and adopted the normative M9 requirements: SHR-001 to SHR-014 and CHN-001 to CHN-011 in [the required specification](specs/required-specification.md#21-agent-communication-channels-and-shared-content-storage-milestone-m9), with their interfaces in [section 38](specs/interfaces-and-operations.md#38-shared-content-and-agent-communication-channels-milestone-m9). TASK-111 adopted SHR-015 and CHN-012 and amended CHN-006, CHN-007, CHN-010 and CLI-020 under EPIC-017. Every EPIC-016 Requirements cell and traceability row is populated; the [shared-content qualification map](implementation-tips/m9-shared-content-qualification.md), [Channel qualification map](implementation-tips/m9-channels-qualification.md), [independent consumer observations](implementation-tips/use-sorage-acceptance.md#m9-independent-observations-2026-10-20), [EPIC-017 skill re-observations](implementation-tips/use-sorage-acceptance.md#epic-017-independent-observations-2026-10-23), and [upgrade and rollback procedure](ops/README.md#m9-shared-content-upgrade-and-rollback) retain the implementation guidance and its qualification limits. The roadmap alone records delivery status.

The TASK-105 adoption was design only; implementation and qualification belong to its subsequent owning Tasks, and the same holds for TASK-111's EPIC-017 adoption. M9 ships with M8 and EPIC-017 in the one shared v0.1.3 release Master allocated on 2026-10-21 under [ADR-0033](architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release), whose publication is separately authorized. The checker's dynamic requirement parsing recognizes the SHR and CHN identifiers without further checker changes, and dependency, requirement-coverage and reverse-index guards keep operating unchanged.

[EPIC-017](roadmap/README.md#epic-017-channel-adoption-hardening-and-v013-release-readiness) registers release-blocking Channel adoption corrections and the readiness of a shared v0.1.3 release, motivated by Aquarium's 2026-10-20 Channel adoption request. Its lasting design and delivery boundaries belong to the canonical owners: [ADR-0033](architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release), the [EPIC-017 public contract classification](specs/interfaces-and-operations.md#3810-epic-017-public-contract-classification), the Task contract records of [the EPIC-017 roadmap section](roadmap/README.md#epic-017-channel-adoption-hardening-and-v013-release-readiness), [shared-content and candidate qualification](implementation-tips/m9-shared-content-qualification.md), [Channel concurrency qualification](implementation-tips/m9-channel-concurrency-qualification.md), the [EPIC-017 independent observations](implementation-tips/use-sorage-acceptance.md#epic-017-independent-observations-2026-10-23), and [upgrade and rollback operations](ops/README.md#m9-shared-content-upgrade-and-rollback). The roadmap's post-commit defect policy appended TASK-120 on 2026-10-23 from the Epic Evaluator's F-1 ruling on TASK-116's isolated v0.1.2-to-candidate upgrade drill; it corrects the M9 post-upgrade procedure order and the interface's Vault policy-check precision with no behavior, output or migration change. TASK-111 accepted [ADR-0033](architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release) on 2026-10-21 and adopted its contracts into the canonical owners above, including the new SHR-015 and CHN-012 rows, the [EPIC-017 public contract classification](specs/interfaces-and-operations.md#3810-epic-017-public-contract-classification), and the shared v0.1.3 allocation; the roadmap alone records delivery status.

[EPIC-018](roadmap/README.md#epic-018-mcp-access-zero-write-reads-and-channel-rebuild) registers release-blocking work from Master's 2026-10-23 direction, which has two parts:

- Agents send and read Handoffs, Project Memos and Channel messages from any environment, including a fully read-only sandbox, through a `sorage mcp` adapter and read commands that write nothing.
- The Channel surface is rebuilt before the shared v0.1.3 release.

Its canonical outcomes belong to the specification and qualification owners below. TASK-121 accepted [ADR-0034](architecture-decision-records/README.md#adr-0034-sorage-mcp-adapter-zero-write-reads-and-the-channel-rebuild) on 2026-10-24 after recording both feasibility probes, added the dated ADR-0007, ADR-0030 and ADR-0033 amendments, and adopted the contracts into their canonical owners: RDR-001 to RDR-005 and MCP-001 to MCP-006 in [the required specification](specs/required-specification.md#22-mcp-access-and-zero-write-reads-milestone-m9) beside the rewritten CHN-001 to CHN-014, the rebuilt [interface section 38](specs/interfaces-and-operations.md#38-shared-content-and-agent-communication-channels-milestone-m9) with its 38.11 classification and catalogue target, the new [interface section 39](specs/interfaces-and-operations.md#39-mcp-adapter-milestone-m9), the replaced [security-reliability section 17](specs/security-reliability.md#17-m9-messaging-trust-boundary-and-writable-storage), the rewritten AJ-28 and AJ-29 with the new AJ-30, and the extended M9 release-gate rows. The [MCP-first skill qualification guidance](implementation-tips/use-sorage-acceptance.md#mcp-first-skill-qualification) separates copied-resource integrity from actual independent walkthrough evidence and its actor-specific limits. The [assembled MCP and rebuilt Channel qualification map](implementation-tips/mcp-and-channel-qualification.md) records the current journey coverage, native old-binary upgrade/restore/rollback, read-only Codex observations, package binding and limits. The roadmap alone records delivery status.

## Source of Truth precedence

When documents conflict, apply this order:

1. [specs/required-specification.md](specs/required-specification.md)
2. Accepted decisions in [architecture-decision-records/README.md](architecture-decision-records/README.md)
3. [architecture/README.md](architecture/README.md)
4. [specs/interfaces-and-operations.md](specs/interfaces-and-operations.md)
5. [specs/security-reliability.md](specs/security-reliability.md)
6. [specs/project-memos.md](specs/project-memos.md), for the detailed Memo domain and its explicit M7 extensions
7. [specs/testing-and-acceptance.md](specs/testing-and-acceptance.md)
8. [specs/traceability.md](specs/traceability.md)
9. [roadmap/README.md](roadmap/README.md)
10. [implementation-tips/README.md](implementation-tips/README.md)
11. Examples and schemas under [specs/examples/](specs/examples/) and [specs/schemas/](specs/schemas/)

The product charter and future-work catalog provide context but cannot settle a conflict. An implementation cannot silently override a higher-authority document.

The Memo contract owns its detailed lifecycle, CLI/HTTP data, Web pending-attempt gate, and format-2 Memo shard/digest rules. Higher-ranked documents retain common authentication, security, envelopes, and transaction safety and explicitly distinguish Memo extensions from legacy Handoff and format-1 behavior. A Memo-specific document does not implicitly weaken a shared rule. Keep this order aligned with governance and root agent guidance.

## Roadmap identity and dossier lifecycle

The roadmap namespace is `docs/roadmap/README.md`. Epic IDs use `EPIC-NNN`, while Task IDs follow one global, increasing `TASK-NNN` sequence. Once committed, an identifier cannot change or be reused.

Only the roadmap records lifecycle state. The dossier for an active Epic lives under `todo/`, appears in the adopted section of the TODO index, and is linked from the Epic through `Detailed SOT`. When the Epic closes, move lasting information to its canonical owner, remove the dossier and its index entry, and replace `Detailed SOT` with repository-relative `Canonical Outcomes` links.

## Verification

Run the narrowest relevant check first. Run the complete gate before asking for review:

```sh
bun run check:sot
make test
git diff --check
```

`scripts/sot-check.ts` validates relative links, document layout, roadmap identifiers, dependency order, requirement citations, traceability, and the relationship between the configuration schema and its example. The Aquarium documentation inspector checks structure during setup. It does not replace repository checks or a semantic review.
