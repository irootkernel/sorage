# Safe Handoff recovery and agent policy

This is the execution context for [EPIC-015](../roadmap/README.md#epic-015-safe-handoff-recovery-and-agent-policy). The roadmap alone records lifecycle state. [Interface section 37](../specs/interfaces-and-operations.md#37-send-replay-only-and-agent-policy-milestone-m8), [ADR-0029](../architecture-decision-records/README.md#adr-0029-non-executing-send-recovery-and-agent-policy-in-m8), and the cited requirements and acceptance journeys remain authoritative.

## Product outcome

Inspect an uncertain CLI send without executing it again. The shipped skill must preserve explicit user intent, native deletion and pinned decisions, observed versions, original send material, Project identity, and untrusted-content boundaries.

## Ordered work

- TASK-101 (Contract): implement core recovery inputs, checked historical outcomes and errors, adapters receipt reads over the accepted coherent snapshot boundary, and matching CLI/daemon error-catalog fixtures. Expose no CLI recovery mode yet.
- TASK-102 (Contract): expose CLI send --replay-only before operational initialization, migration, startup drain, body staging, logging, and marker refresh; add contextual errors, help, completion, and compiled AJ-25 checks.
- TASK-103 (Standard): update the shipped skill, standalone copied-directory resource validation and relevant guidance; perform the actual independent AJ-26 walkthrough against the frozen candidate.
- TASK-104 (Standard): qualify the assembled recovery and policy behavior, preflight integration and prior regressions; reuse owning-Task observations only when the relevant candidate bytes are unchanged.

## Implementation boundaries

Reuse existing request hashing and verified legacy sender compatibility. Filter receipt expiry without cleanup, sample the lookup Clock inside the consistent snapshot, and validate historical outcomes and every referenced Handoff's immutable ownership. Preserve actual sender and source guards. Missing or expired receipts and later errors retain uncertainty and never authorize execute fallback or another key.

Preserve the original Installation, Vault, receipts, pending intents and bound Project markers. Bounded private snapshot writes and cleanup remain permitted under interface section 36.2. Keep the existing preflight report and ordinary command behavior. No HTTP/Web recovery, doctor rewrite, configuration or persisted-format migration, Memo mode change, installation, product version change, or publication is included.

## Verification and handoff

Run focused behavioral checks, then make test and git diff --check before completion review. AJ-25 covers original-request receipt recovery and unchanged managed state; AJ-26 requires a separate observer using native commands and a standalone skill copy outside the checkout. All product checks use isolated temporary Installations. Contract review classifies additive snapshots and migration impact. Main records delegated Task acceptance after independent Judge and two non-author Worker reviews; overall Epic acceptance belongs to Master.

Retain lasting implementation decisions, examples and qualification explanations under their canonical documentation owners, then remove this temporary dossier at Epic closeout.
