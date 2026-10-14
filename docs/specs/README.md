# Specifications

This directory defines required Sorage behavior and the contracts implemented by the repository.

- [Required Specification](required-specification.md) is the highest product authority.
- [Interfaces and Operations](interfaces-and-operations.md) defines configuration, CLI, HTTP, Web, Vault, backup, and diagnostic contracts. Operational procedures are indexed separately in [Operations](../ops/README.md).
- [Project Memos](project-memos.md) defines the M7 reminder domain, lifecycle, bounded CLI/API/Web contracts, and migration/backup behavior. It is required design; implementation readiness is recorded only in the roadmap.
- [Security and Reliability](security-reliability.md) defines the local trust boundary and recovery guarantees.
- [Testing and Acceptance](testing-and-acceptance.md) defines acceptance journeys and release gates.
- [Requirement Traceability](traceability.md) maps requirements to roadmap work and evidence.
- [Examples](examples/) and [schemas](schemas/) support the contracts and have the lowest SOT precedence.

## M8 contract entrypoints

[Required Specification sections 19 and 20](required-specification.md#19-installation-preflight-milestone-m8) and GEN-016 through GEN-020 own installation preflight, non-executing send recovery and shipped agent decisions. [Interfaces sections 36 and 37](interfaces-and-operations.md#36-installation-preflight-milestone-m8) own the detailed CLI/report/error contracts, with no new document authority tier. The design is adopted for intended v0.1.3; availability and delivery status remain exclusively in [the roadmap](../roadmap/README.md). Current v0.1.2 behavior and historical M7 Memo qualification are not rewritten by this adoption.
