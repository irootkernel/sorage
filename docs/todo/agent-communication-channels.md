# Agent communication channels and shared content storage

This is the execution dossier for [EPIC-016](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage). The roadmap alone records lifecycle state, ordering and eligibility. [Proposed ADR-0030](../architecture-decision-records/README.md#adr-0030-agent-communication-channels-and-shared-content-storage-in-m9) records the material design proposal. This dossier preserves the approved planning direction; it does not override the current [required specification](../specs/required-specification.md), accepted decisions, or detailed Handoff and Memo contracts. TASK-105 must reconcile those authorities before product implementation.

## Problem and product outcome

A separate test pilot sent Worker/Judge messages into an Orchestrator's prompt input, where they could be interpreted as user instructions. This is Master's reported pilot observation, not a reproduced defect in a published Aquarium release. The consumer under discussion is an unreleased Aquarium candidate.

Provide one durable upstream communication channel per orchestration invocation. One main receives reports, questions and peer-relay requests from multiple registered Workers/Judges, reads them as tool-result data and decides what happens next. Main-to-agent instructions remain on the consumer's supported direct instruction surface. Lower agents do not need inbox handlers or polling loops. Source attribution improves interpretation; received content cannot grant new user authority or become trusted merely because Sorage delivered it.

Use one content storage interface for Handoff Artifact bodies, Project Memo bodies and Channel message bodies. Short text uses the existing SQLite database; long text and binary content use managed Vault files. Metadata and processing state stay in SQLite. Recording a message or delivering a report does not execute its contents, establish correctness, advance a roadmap, or complete a Podway node.

## Channel ownership and workflow context

- One orchestration invocation owns one channel and one main. Worker/Judge participants belong to that channel and retain distinct participant IDs and roles. Tie messages to registered participation rather than trusting a role or display name written in the message body.
- Retain available native agent handles as provenance without making unavailable private executor identity or model telemetry a new prerequisite. Existing SEC-013 remains in force: Sorage does not isolate AI processes running as the same OS user.
- Associate a message with its assigned work and available external workflow context, including Podway session, node and attempt. The consumer supplies observed context through the public Sorage interface; Sorage does not read or mutate Podway state to discover it.
- An Epic invocation may use several Podway sessions. Keep the same channel through member Goals, corrections, internal validation and resumption while retaining each message's original context. Do not create a new channel merely because a Podway node or member session changes.
- Worker/Judge reports, questions and requests to contact another participant go upstream through the channel. Main decides whether to relay, request clarification, reject or issue a new assignment. Preserve the original source when relaying; distinguish referenced report content from main's operative instruction.
- Persist messages and processing decisions across restart. Reading does not imply handling. A wait must account for already-pending messages as well as subsequent arrivals; do not inherit legacy Handoff wait's new-items-only behavior without an explicit Channel contract.
- Delivery and external effects have separate outcomes. Re-reading a message must not silently redispatch work. A lost direct-instruction response remains uncertain until the consumer reconciles the same operation; a Sorage processing record cannot prove an external effect happened exactly once.

Channel creation and its ongoing operations must be covered by the explicitly authorized consumer workflow. That authority is confined to its channel; it does not grant general Handoff/Memo discovery, unrelated channel access, user approval, commit or publication authority. The shipped skill must distinguish these scopes.

## Shared content representation

Use the following proposed internal representation for an authoritative body:

```ts
type StoredContent =
  | { content: string; storageKey: null }
  | { content: null; storageKey: string };
```

Enforce mutual exclusion in the database as well as application validation: exactly one field is non-null. A Vault key must be nonempty and pass managed-key validation. Empty inline text is a present value, not null; preserve each domain's existing rules about whether an empty body is allowed. Do not store a second authoritative body in the other field.

The initial routing policy is text of at most 65,536 UTF-8 bytes inline, larger accepted text in the Vault, and binary content in the Vault regardless of size. This is a design default aligned with the current Memo size boundary, not a measured SQLite performance guarantee. TASK-105 must define domain-wide total input bounds, accepted text-file decoding, errors and transport limits; the threshold is not permission for unbounded input or whole-file buffering.

Preserve the exact accepted bytes, including line endings and Unicode, and record byte size and SHA-256 for either representation. Store a managed Vault-relative `storageKey`, never an absolute path that becomes authority after a Vault move. The common application interface resolves content without requiring callers to select or inspect its physical backend. Lists expose bounded previews and metadata; full reads use the accepted complete-content interface.

Reuse core/adapters boundaries, synchronous transactions, WAL writer coordination, fences, staging, checksum validation and intent recovery. Generalize the existing Handoff-specific ownership assumptions only where needed for Memo and Channel content. SQLite and the filesystem do not share a transaction, so Vault content needs durable staging, committed intent, activation and reference-aware cleanup. A metadata commit alone cannot claim that its file is readable.

## Existing behavior and migration obligations

Handoffs keep their identity, exactly one current Artifact, Revision, review and acceptance relationships. New inline Artifact bodies require an explicit change to the current Vault-only rules and `send --body` materialization contract. Preserve source boundaries, sender identity and binary import behavior. The existing fetch contract returns a readable local path; TASK-105 must define inline fetch materialization, path lifetime and cleanup. A derived read-only fetch file is not a second authoritative stored body.

Memos retain Project identity, lifecycle, User provenance, observed-version updates, empty-body behavior and non-executing replay-only recovery. Large-body support changes the current 65,536-byte rejection contract. Preserve literal substring search over either backend, original historical receipt outcomes, and the Web unknown-attempt gate. Merely moving a live body to a file while serializing another complete copy in SQLite receipts would defeat the proposed storage policy; define how immutable referenced content remains available for retained historical responses.

Keep existing file-backed Handoffs and inline Memos readable. Do not automatically repack historical bodies solely to satisfy the new routing threshold. TASK-105 must specify the next unused schema migration, updated protocol/snapshot formats, supported upgrade and restore inventory, handling of old receipts and pending intents, and rollback refusal. No schema, snapshot or public DTO change is made by this registration.

Backups and restore must preserve logical content, exact bytes, storage references and identity coherently. Define Channel inclusion and retention explicitly before implementation; neither channel completion nor a missing receipt proves that content can be deleted. Cleanup must preserve every live or retained-response reference and every pending filesystem operation. Keep missing/corrupt bytes and uncertain operation outcomes visible rather than synthesizing success or retrying work.

## Ordered work and acceptance

| Owner | Deliverable and evidence |
|---|---|
| TASK-105 | Finalize the material change and all affected canonical authorities; accept or revise ADR-0030; define Channel operations/states, participant and assignment binding, input bounds, public DTOs/errors, recovery, retention, fetch/search and migration/backup contracts; adopt requirements, acceptance journeys and all six Task citations with matching traceability. Independent review classifies the proposed contract and format changes before product implementation. |
| TASK-106 | Deliver the shared application/storage interface and migration with real SQLite/filesystem evidence for XOR constraints, exact bytes, threshold boundaries, concurrent writes, crash recovery, existing-data access and reference-aware cleanup. No transport or later domain adoption is needed to satisfy its gate. |
| TASK-107 | Adopt shared storage for Handoffs across existing transports and backup/restore, preserving identity, review, acceptance, source policy and uncertain-send recovery. Test inline fetch materialization and complete content delivery as well as Vault and binary paths. |
| TASK-108 | Adopt shared storage for Memos across existing transports and backup/restore. Test literal search, empty and large bodies, updates in both directions across the threshold, historical replay-only results and Web uncertainty handling. |
| TASK-109 | Deliver the Channel domain, registered participants, attributed messages, durable processing, CLI submission/reads/waiting/recovery and the selected backup behavior. Update the shipped skill and public consumer guidance; observe its actual channel authority and untrusted-content behavior independently. |
| TASK-110 | Qualify the assembled M9 outcomes, supported legacy upgrades/restores, restart and lost-response recovery, previous journeys and public consumer walkthrough; promote lasting information to canonical owners and prepare separate Epic acceptance. |

Each implementation Task runs focused meaningful checks followed by `make test` and its independent Contract review. TASK-105 is design-only and uses `bun run check:sot`, `git diff --check` and independent contract review, with a recorded explanation for inapplicable runtime tests. TASK-110 requires the full code gate and independent whole-Epic assessment. No Task may rely on a later Task to fix its current correctness or acceptance gaps.

## Verification scenarios

- Exact threshold-minus-one, threshold and threshold-plus-one UTF-8 byte cases, including multibyte characters, unchanged line endings and each domain's empty-body rules; binary content always remains file-backed.
- Reject both-present and both-absent authoritative body fields and invalid managed keys; preserve exact size/hash and accessible content after successful commit and restore.
- Concurrent submissions, retained duplicate-request results, failed staging, interrupted activation, corrupt/missing files, storage replacement in either direction and safe cleanup while references or intents remain live.
- Handoff identity/Revision/review/acceptance, inline fetch, source policy, content endpoint rendering, legacy receipts and send recovery; Memo search, version conflicts, original-outcome replay, large bodies and browser uncertainty handling.
- Existing pending messages before waiting, arrivals during wait, timeout, restart after read but before handling, duplicate processing attempts, late old-assignment reports and unrelated channel separation; unknown external dispatch never triggers blind repeat.
- Supported existing database and snapshot generations, coherent new backups/restores and explicit unsupported-downgrade refusal; no real developer Sorage home is accessed.
- A public main/Worker/Judge workflow in which main reads reports as tool results, makes a peer-relay decision and issues a bounded followup. Record actual installed-consumer observations separately; a CLI fixture or prepared skill walkthrough does not establish Aquarium or Herdr activation.

## Delivery boundaries

First delivery adds Channel CLI operations and main-side polling/waiting. Automatic wake-up, new Channel HTTP/Web screens and multi-machine synchronization remain later work. Maintain existing Handoff/Memo HTTP/Web support when adopting shared storage. A future wake-up integration must preserve the report/data boundary and must not submit report bodies through the main's user-input surface.

Sorage remains independently usable without Aquarium, Podway or Herdr. Consumer integration is separately owned and calls public interfaces. This Epic does not edit ecosystem repositories or installed tools. Registration allocates no product version or publication date and starts no managed workflow. Stage, commit, install, consumer activation and publication remain separate authorized actions.

At Epic closeout, promote lasting information to its canonical owners, remove this temporary dossier and its TODO entry, and replace the roadmap's Detailed SOT link with Canonical Outcomes. Do not put lifecycle status or raw runtime identities in this dossier.
