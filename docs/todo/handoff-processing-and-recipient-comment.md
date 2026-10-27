# Handoff processing and recipient comment

## Purpose and authority

This execution dossier preserves Master's approved direction of 2026-10-27 for [EPIC-019](../roadmap/README.md#epic-019-handoff-processing-status-and-recipient-comment). The roadmap alone owns delivery status, dependencies and eligibility. [Accepted ADR-0035](../architecture-decision-records/README.md#adr-0035-handoff-processing-status-and-recipient-comment) records the adopted material change; canonical specifications and accepted decisions remain authoritative over this execution map.

Master requested documentation and Epic/Task registration first, then approved the Epic execution plan through `$aquarium:epic-handler` with M9/shared v0.1.3 and Subagent Review on 2026-10-27. The original registration boundary below describes that earlier document-only operation. Registration changes no product code, tests, shipped skill, database, backup, executable version, CHANGELOG or release gate. It starts no Task or managed execution session and grants no staging, commit, installation or publication authority.

## Canonical adoption map

TASK-128 adopts HPR-001 to HPR-016 and the amended earlier rows in required-specification section 23, the exact interface section 40 contract, architecture section 28, security-reliability section 18 and AJ-31 to AJ-33. Schema 12 and global format 4 append to immutable prior generations. The current comment replaces the old snapshot reviewNote field rather than duplicating its body. Legacy review show/hasReviewNote project active requests only; comment show includes retained feedback. Mandatory fresh-writer observations preserve original successful-receipt replay. The common use cases own these rules across transports.

TASK-129 supplies storage/backup and compatibility adapters so existing commands stay coherent before report surfaces exist; TASK-130 supplies new-state initialization, public reporting projections, transition semantics and required updates to existing callers. Later Task interfaces and Web/skill behavior remain with their declared owners. Each intermediate candidate passes its own gate; it does not await a later Task to repair it. Detailed field, error, body-validation, replay and transition decisions belong to the canonical interface rather than this dossier.

## Agreed behavior

- The sender owns one current request document. The recipient owns at most one current comment; this is not a conversation thread. Preserve the existing explicit User-proxy authority and provenance rather than adding sender comment authority.
- The recipient can create or replace the comment without changing processing status. Replacing it keeps only the latest body; native comment history and historical request documents are outside this Epic.
- Distinguish a general explanation from an explicit request for the sender to revise the document. Only the latter enters `changes_requested`. A general comment must not block `accept`.
- Resolving or withdrawing a change request clears its active-request meaning without automatically deleting its text. A later recipient comment replaces that text. Preserve its target Revision so readers can recognize feedback about an older document.
- Record current-version reading separately from processing. A successful recipient fetch or Artifact preview confirms reading of that version; an explicit User-proxy fetch or preview follows the existing authority model. Metadata listing, `get`, comment reads and event reads remain zero-write operations and do not confirm reading. Starting or completing work does not manufacture a read receipt.
- Processing has a before-work, in-progress and completed flow, independent of the review state. Permit direct completion without a prior start. `accept` continues to mean acceptance of the exact document Revision, not completion of the requested work; neither operation silently performs the other.
- The recipient can record completion together with an optional replacement comment in one transaction, for example, "Implemented and tested; please check the configuration changes." Omitting a replacement leaves the existing comment in place.
- The request document and current comment remain available after completion. General comments remain writable after acceptance, decline, withdrawal and archive, subject to the existing participant rules. An approved deletion still removes current content and leaves a tombstone; this feature adds no tombstone comment writes.
- An unresolved change request cannot be overwritten with a general comment or bypassed by completion. Resolve or withdraw the request first. Decline also ends its active-request meaning while retaining the original purpose, body and target Revision; it does not relabel that text as a general comment. General reporting after a terminal review state cannot reopen document review.
- A changed document Revision starts with reading unconfirmed and processing not started. Keep the existing comment and its original target Revision. A no-change resolution does not create a Revision and therefore does not reset these records.
- Completion cannot be reversed on the same Revision through a report update. A new document Revision can start a new processing cycle where existing revision rules permit it; accepted, declined or withdrawn document content still requires a new Handoff, normally linked through `supersedes`.
- Decline and withdrawal stop further start/complete operations and must not appear as ongoing work in listings. Keep their existing review outcomes visible rather than reporting them as successful completion.

## Target interfaces and invariants

TASK-128 fixes the exact public fields, codes and snapshots before implementation. The intended CLI additions are `sorage comment show/set` and `sorage processing start/complete`, with corresponding MCP tools and authenticated HTTP endpoints. `comment set` accepts exactly one text/file source; start and complete may carry an optional replacement comment. Every existing and new operation that replaces, removes or resolves the shared comment follows the observation policy below. Comment bodies remain separate from metadata-only `get`, as Review Note bodies are today.

Expose current-version read metadata, processing status and its Revision, and current-comment metadata including purpose and target Revision. Separate the existence of a comment from the existence of an active change request everywhere, including acceptance guards, revision resolution, next-actor derivation, listings, Web controls and the shipped skill. Keep existing review commands as the explicit change-request path; TASK-128 must pin how their reads and `hasReviewNote` project the new single-comment model so existing callers are not silently reinterpreted.

The database must enforce at most one current recipient comment per Handoff. Report changes, optional comment replacement and their metadata events commit together under optimistic concurrency. On a stale observation, stored comment content, review/processing state and domain mutation events stay unchanged; the caller retains its text or source file for deliberate reconciliation. Never refresh expectations and retry automatically or add server-side comment history for rejected proposals. Events record provenance and the changed metadata, not old comment or Artifact bodies.

Retain `firstFetchedAt` as the historical first-fetch record and preserve its existing withdrawal protection. New per-Revision read settlement must use the Artifact actually delivered: a fetch racing with a revision must not mark the newer version read, and a late old-version fetch must not overwrite a newer receipt. Recording reading continues not to increment Row Version. Recipient comments and processing actions must also count as engagement for withdrawal protection, without making metadata reads engagement.

Accepted document bytes and `acceptedRevision` remain immutable. The proposed exception permits progress reports and the single recipient comment after acceptance; it does not permit revising accepted content or reopening review. Current terminal-state rules prohibit some of these operations, so accepted authority must be amended before implementation rather than bypassed in a handler.

## Plan review response (2026-10-27)

F1, F2 and F3 were accepted as planning revisions within the existing sequence and are adopted by TASK-128 in the canonical owners above. This response and its adoption claim no product implementation or runtime verification.

### F1: Observation policy for all comment writers

Apply the policy in the shared application use cases, including legacy commands. Each exposed CLI, HTTP and MCP path must honor it; this does not add User-admin commands to the MCP catalogue or alter their authority requirements.

| Operation | Required caller observation for a fresh mutation |
|---|---|
| `comment set`, `review set` | Current document Revision as the new comment's target, plus the current Row Version. |
| `processing start/complete`, with or without a replacement comment | Current document Revision plus the current Row Version. |
| `review withdraw`, `review remove`, `revise` including no-change, and `delete approve` | Current Row Version, which identifies the Handoff Revision and comment state observed by the caller. |
| `decline` | Keep the mandatory current Row Version; it also guards the end of an active request. |
| `accept` | Keep the mandatory current Revision and Row Version; a general comment alone does not block acceptance. |

Missing required observations refuse a fresh mutation. Never substitute the server's newly loaded Revision or Row Version for a missing caller observation. Stale observations return the adopted Revision/Row Version conflict without applying the proposal. Existing successful-receipt replay remains a return of the recorded outcome rather than a fresh mutation and need not match the current Handoff version; a receipt miss cannot fall through to a fresh mutation without its required observations. TASK-128 pins the exact validation, replay admission and refusal contracts across surfaces.

A retained comment's original `targetRevision` is historical attribution, not the current mutation's authorization token. A legitimate withdrawal, removal or resolution uses the observed current Row Version without requiring the old target to equal the current document Revision. A newly authored replacement is attributed to the explicitly supplied current Revision. Making previously optional observations mandatory is a breaking CLI/HTTP/MCP input-contract change, including existing review, revision and deletion-approval invocations; TASK-128 must classify and document it explicitly.

### F2: Unfinished processing in Project lifecycle and presentation

Extend the existing unbind confirmation protection to the following union of non-deleted recipient Handoffs, counting each Handoff once and preserving the existing scope of binding-removal confirmation, including the last binding:

| Evidence | Contribution to confirmation protection |
|---|---|
| Existing open review work, `awaiting_recipient` or `changes_requested` | Included independently of processing evidence. |
| Accepted document with known not-started or in-progress processing | Included as unfinished work. |
| Accepted document with recorded completed processing | No contribution from the processing dimension. |
| Legacy accepted document without processing evidence | No new contribution; show unrecorded evidence, not an invented pending or completed state. |

Archive does not erase known unfinished processing or remove its contribution; approved deletion removes the live Handoff from the count. Keep existing User authority for archive and deletion rather than adding a new permission model. TASK-128 must amend the affected Project lifecycle authority, including PRJ-022, before implementation.

Keep `reviewNextActor` review-specific. Lists, detail views and skill guidance use processing evidence alongside review state to distinguish an accepted pending request from a completed one. A null review next actor is not proof of completed work. Present the next processing action from the recorded status and show unknown legacy evidence honestly; do not require a new routing subsystem, projection or filter unless the selected interface needs it.

### F3: Decline ends activity without rewriting comment purpose

Declining an active change request ends its active-request meaning in the same logical transition while retaining its body, original change-request purpose and target Revision. If activity is stored separately, its change must commit with decline; a derived representation must expose the same result. Do not reclassify the retained text as a newly authored general comment.

The recipient can subsequently replace that inactive comment with a general explanation using the required current observations. The Handoff remains declined, processing is not restarted, no successful-completion evidence is created, and tombstones remain unwritable. This avoids requiring an impossible terminal `review withdraw/remove` before the permitted general comment update.

## Design-adoption obligations

TASK-128 owns the following completions under [governance section 17](../governance/README.md#17-handoff-processing-registration-boundary):

- Accept or revise ADR-0035 and amend the affected accepted decisions, especially ADR-0008's terminal Review Note immutability. Update the required specification, architecture, interfaces, security/reliability, acceptance journeys and traceability together.
- Pin the processing transition matrix, terminal/cancellation presentation, same-Revision completion rule, comment purpose and active-request representation, review-command projections, engagement/withdrawal guards and conflict behavior. Include User-proxy, archived and tombstone cases.
- Adopt F1's observation requirements for legacy and new writers, distinguish original comment attribution from current mutation authorization, and settle successful-receipt replay versus fresh-mutation admission. Adopt F2's known unfinished-work unbind rule and review-specific presentation, including unrecorded legacy evidence and archive. Adopt F3's decline transition without changing retained comment purpose.
- Classify every changed CLI/HTTP/MCP DTO, command, error, annotation, golden and skill behavior as breaking or non-breaking. Retaining resolved comment text and allowing terminal comment writes are intentional contract changes, not merely new optional fields.
- Settle the database upgrade and new snapshot generation, including supported legacy restore and rollback. Do not rewrite schema 11 or the existing format-3 representation in place. Recheck the then-current version inventory before assigning new numbers.
- Preserve legacy evidence honestly. Convert existing Notes to change-request comments with activity derived from their recorded review state. Do not infer completed work from `accepted`, infer current-version reading from `firstFetchedAt`, or reconstruct Note text already removed. Show unavailable legacy read/processing evidence as unrecorded.
- Settle the intended delivery milestone and release allocation before adopting new requirements. Master selected M9/shared v0.1.3; TASK-128 adopts that release-gate expansion under ADR-0035, retaining separate publication authority.
- Replace every EPIC-019 `Requirements: None` placeholder with accepted requirement citations and matching traceability. Product implementation starts only after this design candidate passes its independent contract review and acceptance gate.

## Delivery ownership

The canonical Task rows and their acceptance gates live in [the roadmap](../roadmap/README.md#epic-019-handoff-processing-status-and-recipient-comment). Execute the dependency chain there; the rows below allocate work, not delivery status.

| Owner | Required outcome |
|---|---|
| TASK-128 | Adopt the material change and pin all contracts, migration and qualification obligations before product work, explicitly including F1's legacy writers and breaking inputs, F2's Project lifecycle/presentation rule and F3's decline transition. |
| TASK-129 | Deliver the storage migration, single-comment constraint, versioned read/processing records, backup export/validation/restore and legacy conversion. Preserve current behavior while later command surfaces are absent. |
| TASK-130 | Deliver the core use cases and CLI, including all legacy/new comment-writer guards, atomic completion/comment updates, version reset, read races, engagement protection, known unfinished-work unbind confirmation and decline's inactive retained request. |
| TASK-131 | Expose the same use cases through HTTP and MCP with honest annotations, workspace/actor boundaries, typed envelopes and matching observation/conflict and decline behavior. |
| TASK-132 | Add Web list/detail indicators and controls for the current document, processing and single comment, including accepted-but-unfinished work, conflict preservation, older-version labels and general comment replacement after decline. The live Web implementation is served by the daemon; the `apps/web` stub is not a second UI to build. |
| TASK-133 | Update public and operations guidance and the copied `use-sorage` skill, including mandatory legacy-writer observations, unrecorded versus unfinished work, and decline's retained request; observe independent sender/recipient use. |
| TASK-134 | Qualify the assembled candidate, F1 to F3 scenarios, upgrade/restore/rollback and applicable earlier journeys; assemble exact-candidate evidence and durable documentation for the Epic handler's separate closeout. |

Keep each intermediate candidate coherent. TASK-130 includes the minimum updates to existing in-tree callers and contract fixtures required by its newly mandatory observations; do not leave existing surfaces broken until a later Task. New HTTP/MCP capabilities and Web feature work remain owned by TASK-131 and TASK-132, respectively. TASK-129 retains its storage-first scope and existing-command compatibility obligation.

## Verification obligations

- Pure domain tests cover normal comment versus change request, one-comment replacement, resolution without text loss, acceptance with a general comment, completion blocked by an active request, and decline ending request activity without changing its original purpose.
- Real SQLite tests cover the unique comment constraint, stale-version rollback, atomic status/comment/event writes, per-Revision read settlement races, engagement guards, and revision resets with the older comment retained.
- Contract tests cover CLI envelopes, HTTP DTOs and codes, MCP inputs/annotations/results, metadata-only reads and the pinned legacy review projections. Exercise missing observations and stale proposals through all supported legacy/new writer surfaces, including an R1 proposal after R2 and competing comments on the same Revision. Test stale withdrawal/removal/resolution, removal of an older retained comment with current observations, and recorded replay versus a receipt miss without observations. Expected-version conflicts must not silently retry external work.
- Project lifecycle tests cover accepted not-started, in-progress, completed and unrecorded legacy processing, plus existing open review protection, the last binding, archive and approved deletion. Verify each live Handoff contributes at most once and that a null review next actor is not presented as processing completion.
- Backup tests cover deterministic new-format snapshots, invalid record rejection, existing snapshot restoration, legacy unknown evidence, and old-reader refusal of newer data. Upgrade and rollback use isolated homes and their matching binaries.
- Browser tests cover readable state labels, accepted-but-unfinished processing, older-version comments, safe untrusted rendering, completion with a comment, updates after completion/acceptance and preservation of typed text on conflict. Cover the full active-request to decline to retained inactive request to general explanation sequence, with the Handoff remaining declined and no processing restart or invented completion.
- Independent skill observations cover a sender request and a recipient reading, starting, commenting and completing it, plus sender discovery of the result. Guidance distinguishes acceptance, completion and unrecorded legacy evidence, requires observations on legacy and new writes, and explains retained inactive requests after decline. Check that an inbox/outbox inspection alone grants no processing authority and that received text grants no additional tool or external-action authority.
- Every code Task runs focused checks first, then `make test`, with the repository's independent review and Contract gates where applicable. Product checks always use a task-owned temporary `SORAGE_HOME`, never the developer's real installation.

Registration and this planning revision are checked with `bun run check:sot` and `git diff --check`. Product tests do not apply to this planning-only change; no runtime behavior or journey execution is claimed by writing this dossier. F1 to F3 add focused cases in the existing infrastructure, not a new harness, validator, review layer or mandatory extra full-suite cycle; retain the existing per-Task verification gates and reuse applicable evidence under the repository workflow.

## Next-session entry

Use `$aquarium:epic-handler` in `/Volumes/RootKernel/RootKernel/aquarium-tools/sorage`, with canonical roadmap `docs/roadmap/README.md` and exactly one Epic, `EPIC-019`. Begin with TASK-128 after reconfirming the roadmap pointer and prerequisites. Follow the installed handler's native planning, execution, review and commit-authorization boundaries; this registration is not an execution envelope or a waiver of them.

At Epic closeout, promote lasting contracts and qualification evidence to their canonical owners, remove this dossier and its TODO entry, and replace the roadmap's `Detailed SOT` link with `Canonical Outcomes` links. Keep runtime identities and paths out of the tracked evidence.
