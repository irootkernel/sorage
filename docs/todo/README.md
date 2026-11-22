# TODO

This directory stores future epic-sized candidates and temporary dossiers for registered or adopted Epics that have not closed. Only [the roadmap](../roadmap/README.md) records lifecycle status.

## Future candidates

- [Future Work](future-work.md) records non-normative ideas that have not been adopted into the roadmap.

When a registered or adopted Epic closes, move lasting information to its role owner. Then remove the dossier and its index entry, and replace the roadmap's `Detailed SOT` link with `Canonical Outcomes` links.

## Registered Epic dossiers

- [M11 architecture hardening and modernization dossier](m11-architecture-refactoring-dossier.md) holds the verified findings, baseline protocol, constraints and per-Task execution guidance for [EPIC-022](../roadmap/README.md#epic-022-m11-non-breaking-defect-fixes-hot-path-performance-and-v17-indexes), [EPIC-023](../roadmap/README.md#epic-023-m11-golden-preserving-internal-architecture-cleanup) and [EPIC-024](../roadmap/README.md#epic-024-m11-targeted-contract-modernizations-and-qualification). Its contracts require adoption under [proposed ADR-0038](../architecture-decision-records/README.md#adr-0038-m11-non-breaking-hardening-v17-index-migration-and-internal-architecture-cleanup), [proposed ADR-0039](../architecture-decision-records/README.md#adr-0039-daemon-http-idempotency-unification-onto-core-sqlite-receipts) and [proposed ADR-0040](../architecture-decision-records/README.md#adr-0040-separated-web-ui-assets-with-minimal-build-time-embedding); the roadmap alone owns delivery status.

## Adopted design references

M8 installation preflight and Handoff recovery/agent policy are adopted in [the canonical roadmap](../roadmap/README.md#epic-014-non-mutating-installation-preflight), with their design in [the specification owners](../specs/README.md#m8-contract-entrypoints). They are not future-work candidates and do not need a duplicate lifecycle list here.
