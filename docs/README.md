# Sorage documentation

The repository root [README](../README.md) introduces Sorage to users. The root [CHANGELOG](../CHANGELOG.md) records concise shipped outcomes and the planned next stable release. This directory is for maintainers and contributors. It contains the implementation contracts, architecture, decisions, development guidance, operations, and delivery state.

## Documentation profile

- **Profile:** `single-scope`
- **Delivery scope:** Sorage
- **Canonical roadmap:** [roadmap/README.md](roadmap/README.md)
- **Language:** English for the root README, changelog, and all Markdown under `docs/`
- **Source of Truth version:** `0.6.0`

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

## Source of Truth precedence

When documents conflict, apply this order:

1. [specs/required-specification.md](specs/required-specification.md)
2. Accepted decisions in [architecture-decision-records/README.md](architecture-decision-records/README.md)
3. [architecture/README.md](architecture/README.md)
4. [specs/interfaces-and-operations.md](specs/interfaces-and-operations.md)
5. [specs/security-reliability.md](specs/security-reliability.md)
6. [specs/testing-and-acceptance.md](specs/testing-and-acceptance.md)
7. [specs/traceability.md](specs/traceability.md)
8. [roadmap/README.md](roadmap/README.md)
9. [implementation-tips/README.md](implementation-tips/README.md)
10. Examples and schemas under [specs/examples/](specs/examples/) and [specs/schemas/](specs/schemas/)

The product charter and future-work catalog provide context but cannot settle a conflict. An implementation cannot silently override a higher-authority document.

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
