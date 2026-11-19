# Sorage Exchange: Requirements and Implementation Dossier

**Status:** Registered design proposal for [EPIC-021](../roadmap/README.md#epic-021-exchange-peer-collaboration-between-projects) under [Proposed ADR-0037](../architecture-decision-records/README.md#adr-0037-exchange-as-a-separate-peer-collaboration-domain-in-m10); not adopted. Current specifications and accepted decisions remain authoritative until TASK-139 adopts the change. Source baseline `e440b47`. This dossier reflects the Exchange review and the [registration record](#registration-record). The [canonical roadmap](../roadmap/README.md#2-active-pointer) owns delivery status.

## Purpose and scope

Exchange is a durable conversation for registered Projects collaborating as peers within one Sorage Installation. A server, several clients, and another Project can exchange directed requests, results, and evidence while verifying a shared change. One Exchange ID identifies the work across agent sessions, model changes, Aquarium upgrades, and machine restarts.

Exchange is a fourth domain alongside Handoff, Project Memo, and Channel. Handoff owns document delivery and review. Channel owns upstream reports and relays through a `main` participant. Exchange has its own membership, requester acceptance, unanimous completion, and retention rules. Reuse Project resolution, body handling, transactions, read-only storage, polling, and MCP infrastructure where their contracts fit. The [Channel schema](../../packages/adapters/src/sqlite/migrations.ts) and [snapshot validators](../../packages/core/src/channel-snapshot.ts) enforce upstream reporting. A Channel mode would extend those contracts, a Handoff thread would extend a document-review contract, and a skill-only workflow would lack durable acceptance and completion state. Separate Exchange records preserve the existing contracts.

The first version uses the CLI and MCP on one Installation. It supports concurrent requests between Projects. Shared message sequences order the history, and reply links express dependencies. The agents and their existing tools own external execution, cancellation, and side-effect reconciliation. Sorage records collaboration and enforces its own transitions.

## Collaboration requirements

### Start, join, and participation

- The user supplies a goal, participating Projects, and a completion criterion. Resolve the starting Project from its [registered workspace](../architecture/README.md#222-resolution-order). Creation requires at least two Projects including the creating Project, persists the Exchange and initial roster without acquiring a session claim, and returns the ID immediately for the user to share.
- Any current member can relay the user's authorized roster change. Adding a Project grants access to the existing working history and participation in completion. Removing a Project revokes access and its session claim, preserves relevant attribution, and takes it out of future votes. At least one Project must remain. Item ownership changes explicitly when a removed Project had unfinished responsibilities.
- Use `start-exchange` for creation followed by the common join path, and `join-exchange <ID>` for late entry, reconnection, or user-authorized resumption. The join view returns the goal, roster, outstanding requests and acceptance obligations, and current completion state. The same Project keeps its messages, accepted results, and valid vote when its agent or model changes.

### Read-only and Plan-mode agents

Authorized agents can create and join, exchange messages, retrieve shared material, confirm receipt, report and accept results, and propose and vote on completion through MCP in supported read-only and Plan-mode harnesses. Broker writes and session support run on the MCP side. The caller needs neither project write access nor a local spool, state file, or shell keeper to communicate. Carry forward the existing internal-communication annotations and result envelope under [MCP-003](../specs/required-specification.md#22-mcp-access-and-zero-write-reads-milestone-m9) and the [MCP interface](../specs/interfaces-and-operations.md#39-mcp-adapter-milestone-m9). A harness refusal remains a refusal and must be reported.

History, inspection, bounded retrieval of local material, and wait are physically read-only. Receipt confirmation and other durable transitions are explicit mutations after successful delivery. A peer's message supplies context. User authorization governs project edits, test execution, file access, and lifecycle controls. Continue already authorized work without requesting another approval merely because a communication record will be persisted. Preserve the [same-OS-user trust boundary](../specs/security-reliability.md#17-m9-messaging-trust-boundary-and-writable-storage).

### Requests, reports, and requester acceptance

Each actionable request records its accountable requester, current assignee, requested condition, and relevant criteria. Messages identify their sender, recipient when addressed, sequence, and the sequence they answer. Progress, clarification, inability to proceed, completion reporting, and acceptance have distinct meanings.

| State | Meaning and next action |
|---|---|
| In progress | The assignee is expected to answer or report the outcome. An incomplete or unfulfillable request needs an explicit reassignment, cancellation, or agreed follow-up. |
| Completion reported | The current assignee provided a versioned result. The requester can verify the conditions through later authorized work or a focused assessment of the supplied evidence. |
| Resolved | The responsible requester explicitly accepted the specific report version after checking it. A later finding opens linked follow-up work. |

A report should briefly give the condition addressed, result, actual checks and observations, relevant limitations, and evidence references. A server pagination change, for example, can be accepted using a subsequent client test that exercises multiple pages and checks for missing or duplicate results. A test of one ordinary request provides evidence for that path. A duplicate-handling request needs evidence covering duplicates. A focused diff, existing test, response example, or relevant log excerpt may be sufficient, and a documentation correction may only require reading the corrected passage.

The requester can begin the task that will verify the result while acceptance is pending. Record acceptance only after the relevant conditions have actually been checked. The requester can include explicit request/report version acceptances in a subsequent report, relevant response, or final vote. Such a mutation checks each named version atomically. A new report version requires its own acceptance. Routine acceptance needs no separate human approval, independent review, or redundant test.

Preserve the original requester and assignee in history. Removing or reassigning an assignee leaves the original result and obligations visible and requires explicit assignment of further work. Removing a requester leaves an explicit acceptance-owner vacancy. A remaining member can take over or reassign that responsibility within the authorized scope. Claim and observed assignment/report versions fence late reports and acceptances. A membership change does not establish acceptance. Record any cancellation or transfer as a disposition with its reason.

### Completion, pause, and resumption

Any current Project can propose completion with the concise summary to retain, the criteria, and the request/report versions supporting it. The proposer and every other current Project explicitly vote on that exact proposal. An objection states the outstanding check or evidence gap. Participants can verify it together or explain why existing evidence covers it. The objecting Project decides whether to change its vote.

| State | Permitted behavior |
|---|---|
| Active | Members can communicate, work on requests within user authorization, report and accept results, propose and vote, and use applicable membership and pause controls. |
| Paused | Members can inspect records, relay authorized roster and ownership corrections, and resume through user-requested join with any required decision. Pending work and material remain available. Messages, reports, acceptance, proposals, and votes require resumption. |
| Completed | Members can inspect the approved summary and compact retained records. The collaboration outcome is immutable. Cleanup bookkeeping can advance. Follow-up work starts in another Exchange that can reference this one. |

An explicit user stop through any current member pauses the Exchange, records the reason, and revokes active session claims without a vote. An agent-initiated pause with a specific question requiring the user's decision requires that agent's current claim in the Active state. An explicit user-requested join is the single resumption entry point. Resume atomically matches the observed pause version, records the actual decision when one was requested, and establishes the initiating Project's new claim; it does not require the revoked claim. A stale request cannot override a newer pause. The first Project can resume before other Projects join. A reboot or agent change while active uses the same join entry point. Joining a completed Exchange returns the retained outcome.

### State and authority

Skills determine whether the current user instructions authorize a lifecycle or membership control, carrying existing authorization forward. The broker checks the resolved Project, current membership and access, legal state transition, observed versions, and the claim required by the operation. A user-authorization field is not independent proof of human approval within the existing same-OS-user trust boundary.

| Operation | State and authority | Claim requirement |
|---|---|---|
| Creation | Registered creating Project and authorized initial roster including that Project. | No prior claim required; creation does not establish a claim. |
| Inspection, history, material retrieval, wait, and replay-only recovery | Current membership and access; completed reads expose only retained material. Creation recovery is discoverable by the creating Project, with current Exchange access checked before returning Exchange records. | No live claim; physically read-only. |
| Join, claim acquisition, or replacement | Active; atomically check the slot. A live competing claim requires user-approved replacement against the exact observed claim. | No prior owned claim is required to acquire or replace one. |
| Join of a completed Exchange | Completed; check current membership and return the retained outcome. | No claim is acquired or renewed; physically read-only. |
| Participant work, including messages, material registration, request assignment or disposition, read confirmations, reports, acceptance, proposals, votes, and notice reporting | Active; check current membership, applicable request ownership, and observed record versions. | Current claim required. |
| User-directed stop or pause, roster change, and correction of ownership vacancies | Active or Paused as applicable; check current membership and observed state, roster, and ownership versions. | No prior live claim required. These controls cannot post reports, accept results, or cast votes as side effects. |
| User-requested resumption through join | Paused; check membership, the observed pause version, and any requested decision. | Atomically establish a new claim with resumption. |
| Agent-initiated pause to request a user decision | Active; record the specific unresolved question. | Current claim required; a stale agent cannot use this path. |
| Lease renewal and cleanup recovery | Renewal applies to an Active session; cleanup follows committed cleanup intent. | Renewal checks the current claim. Broker cleanup does not require a participant claim. |

## Implementation contract

### Message bodies, material, and retrieval

| Form | Behavior |
|---|---|
| Message body | Preserve the accepted logical content and support bounded, lossless retrieval. Use 65,536 UTF-8 bytes as the shared inline routing threshold. Larger bodies use file-backed storage within the existing accepted-body limit. |
| Managed working copy | Import an authorized, identifiable version of a document, report, or selected evidence. Retain that copy for the active or paused collaboration. |
| Original reference | Record the source, access method, applicable range, and identity needed to recognize the intended version. Mark live references as live. An external reference can carry a URL, run ID, or retrieval query for an already authorized tool. |

Reuse the [shared content interface and input bounds](../specs/interfaces-and-operations.md#382-input-bounds-and-classification) where their assumptions remain valid for the Exchange storage scope defined under working retention. Use bounded file import or a suitable original reference when transport or configured `artifact.maxBytes` limits apply. Publish enough metadata for incremental retrieval and return exact ranges or an equivalent lossless stream with a clear end. A preview indicates that more content is available. A limit violation or unavailable source produces a clear outcome.

Register local sources from the sharing Project using the existing workspace confinement rules. Record the owning Project, authorized workspace root and source location, applicable range, and live or versioned identity. Authorize later retrieval by current Exchange membership and registered material ID. Resolve and revalidate live local sources against their recorded owner and scope on every open, including symlink and filesystem escape protection. A missing source, escaped path, revoked membership, or changed version of a versioned reference returns a clear outcome; never silently substitute changed content. Live references explicitly report the source identity and observed version or change marker on retrieval. A recipient can read shared material through MCP without shell access to the sender's repository. An arbitrary recipient-supplied path never grants broker access. [MCP-004](../specs/required-specification.md#22-mcp-access-and-zero-write-reads-milestone-m9) currently accepts a file argument only inside the call workspace and refuses an escape before any child process. Adoption defines the Exchange extension in that row and in the [MCP interface](../specs/interfaces-and-operations.md#39-mcp-adapter-milestone-m9): the supplying Project registers a source inside its own call workspace, retrieval names the registered material ID, live and versioned local paths share one revalidation, a changed or lost source authorization has a defined outcome, and no tool takes a raw recipient path. Remote command execution, credential management, and general-purpose log collection stay outside the first version.

Structured local-reference paths and workspace roots follow `gitBackup.snapshot.redactWorkspacePaths` under the [existing backup and binding contract](../specs/interfaces-and-operations.md). A full Installation restore does not restore Project directory bindings or establish access to a local source, even when unredacted path strings are present. Mark restored local references unavailable until the owning Project is rebound and the reference is explicitly revalidated or re-registered within its authorized scope. Ordinary restart with intact state and bindings does not require re-registration.

### Working retention, cleanup, and backup

Detailed working material, including message bodies, files, report versions, and detailed proposal bodies, remains available through reporting, requester verification, ordinary restarts, and pauses. Active or Paused Exchanges retain this material until completion; elapsed time alone does not retire it, so an unfinished Exchange can continue to occupy storage. Store disposable inline bodies in Installation state and disposable files under its state directory outside the Vault Git worktree. The adoption contract defines this state-scoped disposable storage and its retention classification as an Exchange extension of the shared content contract. SHR-001 and SHR-003 address Handoff Artifact, Project Memo, and Channel message bodies, and the Vault storage behavior of those three domains is preserved. SHR-002 is written for every domain: it routes each larger accepted text body and all binary content to the Vault and bounds every accepted body by `artifact.maxBytes`. Adoption must therefore amend SHR-002's scope or state the Exchange exception in that row, and keep the inline threshold, the mid-stream `artifact.maxBytes` bound and the binary classification for Exchange bodies stored in the state directory. Storage-key resolution must distinguish the storage scope: a resolver that requires managed Vault-relative keys cannot be reused unchanged for state-directory files. Reuse shared body handling and bounds only where their assumptions remain valid, and never route disposable file-backed bodies through Vault `content/`. Existing backups stage [the managed Git pathspecs](../../packages/core/src/git.ts), including `content/` itself. Keeping disposable files out of snapshot JSON alone would still allow that path to be committed.

| Material class | Working storage | Permanent backup | After completion | Size and retrieval rule |
|---|---|---|---|---|
| Message and report bodies, including inline bodies | Installation state database or files outside the Vault worktree. | Compact identity, version, state, and retrieval metadata only; no body bytes. | Retire disposable bodies and retain essential associations. | Shared accepted-body and configured storage bounds; bounded, lossless retrieval. |
| Managed copies, logs, evidence, and detailed proposal bodies | Durable working files outside the Vault worktree. | Inventory and source metadata only; no copied payloads. | Release references and delete unreferenced disposable files. | Configured import bounds; use an original reference when a copy is unsuitable. |
| Original references | Owner, authorized scope, source, range, and version metadata in Installation state. | Compact reference metadata, with structured local paths subject to workspace-path redaction. | Retain references needed to interpret the summary; never delete external originals. | Authorized bounded retrieval; full restore requires binding and reference revalidation. |
| Concise workflow descriptions and decision reasons | Text fields in the relevant Exchange, request, disposition, pause, or vote record. | Include the text needed to understand and resume the workflow. Earlier compact revisions may remain in Git history. | Retain only text needed to interpret the approved outcome and its essential associations. | At most 8,192 UTF-8 bytes in aggregate across the free-text fields of one logical workflow record; see the field classification below. |
| Concise candidate and final summaries | Compact workflow records, distinct from detailed proposal bodies. | Current candidate and final summary; earlier compact candidate revisions may remain in Git history. | The current completed view retains the approved summary and minimal proposal associations. No Git history rewrite is required for earlier compact summaries. | A separate v1 retained-summary budget of 65,536 UTF-8 bytes per candidate or final summary. |
| Read progress | Compact Project-scoped working state that preserves gaps in confirmed sequences. | Current compact progress for Active or Paused Exchanges, without per-call receipt or event history. | Drop progress not needed to interpret the retained outcome. | Store confirmed sequences or ranges without implying unread messages were read. |
| Workflow identity and business-operation recovery records | Typed state, IDs, versions, fingerprints, and outcome references. | Included without body bytes, copied evidence, or credentials. | Retain the minimal records needed for interpretation and recovery. | Typed fields under the adopted schemas; any free text uses the bounded workflow-text class above, with no arbitrary payload field. |

The retained workflow-text class includes the goal and completion criterion, each request's requested condition and criteria, cancellation or transfer reasons, pause reasons and questions, resumption decisions, and objections. Its v1 budget is 8,192 UTF-8 bytes summed over all such fields in a single logical record, including every element of any text collection; separate requests and decision records have their own budgets. Candidate and final summaries use only their separate 65,536-byte budget, not both budgets. Retained descriptions must explain the obligation or decision without requiring the omitted detailed body merely to identify what is pending. Longer explanation and evidence belong in working bodies or references. Reject oversized retained descriptions with a clear request to shorten them and reference detail; never truncate them. Classify this concise text as retained metadata at ingestion, so its compact historical versions may remain in Git.

Classify disposable material at ingestion. Keep its bytes out of the Git worktree and out of permanent snapshot bodies, event payloads, and operation receipts. A concise candidate summary is retained metadata from its creation, even if later superseded; it is not a disposable detailed proposal body. The retained-summary budget is independent of message capacity and happens to reuse the inline threshold's value. Reject an oversized retained summary with a clear request to shorten it and reference the detailed working material; never truncate it or silently persist the excess as retained evidence. Ordinary messages and shared material retain the existing body, transport, and reference paths without a new Exchange-specific small message cap.

Backup retains compact workflow and progress records, the concise descriptions and decision reasons above, the current concise proposed summary, and finalized summaries. Detailed active working bodies may be missing after full Installation restore. The restored join view must still explain the goal, requested conditions, acceptance criteria, and pending decisions rather than exposing only IDs and states. Restore the retained records and label working content as present, omitted from backup, or intentionally retired. Recovery can reacquire a source or obtain new authorized evidence for pending verification. Missing detailed evidence does not establish acceptance. Preserved acceptance is historical evidence tied to the report actually accepted.

The completion proposal contains the exact concise summary participants will retain. It captures the goal and outcome, important decisions, concise verification results, limits and unresolved concerns with their disposition, agreed follow-up, participant agreement, and relevant contributions and objections, including those of former members. Retain only the associations needed to interpret that summary and recover committed operations. Completed inspection shows the compact representation.

Commit final agreement and a durable cleanup intent together. Release disposable references and complete physical cleanup through reference-aware recovery. Protect shared content still in use, independently retained artifacts, source files, and external originals. Expose pending and retryable cleanup after completion, and distinguish intentionally retired payloads from integrity errors. The [existing deletion and Git history contract](../specs/interfaces-and-operations.md#33-deletion-and-git-history) applies to committed bytes. The Exchange rule prevents disposable bytes from being committed in the first place.

Append a database migration and introduce the next global backup format with the Exchange representation inside that format, without an independent per-domain snapshot version: [SHR-010](../specs/required-specification.md) supplies that invariant of one global snapshot format. HPR-012 in the same specification establishes the current baseline of schema 12 and global backup format 4, so schema 13 and format 5 are the expected next targets if that baseline is unchanged. Reconfirm both at adoption and at implementation; they are not reserved, and they are not the final schema version of every later Exchange increment. Ship the corresponding inventory validators, exporters, and importers with the first implementation slice that persists Exchange records; an exporter must not silently omit Exchange metadata while claiming the old format. Restore Project and workflow associations, compact outcomes and receipts, and current collaboration state. Restore session leases and active notice claims empty; restore no Project directory bindings. Validate the new inventory and associations before import. Continue importing legacy backup formats and preserve existing-domain behavior; older executables are not required to read the new global format. A build that predates the new format must refuse it before import with `VAULT_SCHEMA_UNSUPPORTED` and import nothing, as SHR-010 and the [migration and backup contract](../specs/interfaces-and-operations.md#387-migration-backup-and-supported-inventory) require, and the same refusal applies to a later incompatible representation under the new format. Classify that operational break separately from the additive commands. Verify the refusal at the format switch; a legacy restore and a matched-binary rollback do not prove it. Verify upgrade and round-trip recovery, with rollback through the matching prior executable and a verified pre-upgrade backup restored into a separate home.

### Atomic completion and operation recovery

Use a per-Exchange sequence and transactionally commit messages, transitions, and their related records. Bind each completion proposal to its roster version, criteria and summary, and substantive work revision covering the request and report versions being approved. A new actionable request or a change to substantive results, evidence, criteria, assignments, proposal, or roster invalidates current approval. Heartbeats, read confirmations, routine explanation, votes, and acceptance of an unchanged report already covered by the proposal preserve it.

The final vote transaction checks the current proposal, roster, and substantive work revision, applies any explicitly named requester acceptances, and accounts for every actionable request recorded in the Exchange, not only requests enumerated by the proposer. Each request must have its current report version accepted by the responsible requester or an explicit cancellation or transfer disposition, with its reason and any follow-up ownership, covered by the current unanimous agreement. Unassigned, unreviewed, or omitted requests block completion unless they have that agreed disposition. Informational messages do not create work obligations. A new request committed first invalidates the earlier votes. If completion commits first, a later request is refused on the completed Exchange. Silence, timeouts, and disconnection leave votes unchanged.

Give each intended durable business mutation a caller-supplied operation ID independent of its normalized input. Lease renewal and read confirmation use the operational paths specified below rather than this permanent business-operation receipt contract. The lookup key is the Installation, acting Project, Exchange, and operation ID; creation uses the Installation, creating Project, and operation ID until the outcome supplies an Exchange ID. Keep operation kind and normalized business input, including relevant target and observed versions, in a separately stored request fingerprint. Session claims and transport details are not business identity. Session replacement therefore preserves the operation ID and fingerprint.

| Operation ID and fingerprint | Result |
|---|---|
| Same lookup key and same fingerprint | Return the committed historical outcome without executing again. |
| Same lookup key and different fingerprint | Return a conflict; do not execute. |
| Different operation ID and same fingerprint | Treat as a distinct intended operation, subject to normal state rules. Identical message content may be posted more than once intentionally. |

Store compact operation IDs, fingerprints, and committed outcome references for recovery, including in Exchange backups. Retain these business-operation records for the lifetime of the retained Exchange record, including completion and compaction, rather than expiring them with a short operational retry window. Read confirmations retain compact progress without permanent per-call operation receipts. Lease heartbeats and other transient maintenance do not require permanent business-operation receipts. Preserve existing-domain operational receipt behavior. The [current restore implementation](../../packages/adapters/src/backup-command-ports.ts) clears operational idempotency receipts, so Exchange needs its own retained recovery records.

Expose read-only discovery of the acting Project's operation IDs and compact outcomes through join or recovery inspection, without relying on an earlier agent's memory or local files. Creation recovery is discoverable by the creating Project before an Exchange ID is known. Discovery returns only records the caller is currently authorized to inspect and never infers identity from similar message content. An operation that was never recorded cannot be reconstructed merely by searching for its input.

For business-operation recovery, separate fresh mutation from replay-only inspection. Check current membership and access for either path and apply the state and claim requirements in the authority table to fresh work. Creation recovery checks the creating Project's identity and current access to any committed Exchange. Matching recovery returns the historical result, with an availability marker for omitted or retired payloads. Changed input conflicts. An absent receipt or a backup that predates the operation leaves the outcome unknown, with zero execution on a replay miss. The skill reconciles uncertain earlier work before any new operation.

### Sessions, waiting, and notice ownership

Maintain one renewable lease per Exchange and Project. Use an opaque claim ID as a fencing token. An empty or expired lease can be claimed atomically. A live competing claim requires user-approved replacement against the exact observed claim. Renewal and fresh participant work check the current claim according to the authority table; user-directed controls do not require an already revoked claim. Pause or removal revokes applicable claims in the same transaction. Resume and replacement preserve the Project's acceptance and vote records.

Lease renewal itself updates runtime session state only. It does not append a retained collaboration event, advance the substantive work revision, change exported business timestamps or metadata, or change canonical snapshot output. A renewal process may still recover a pending business operation through the existing startup recovery path; legitimate changes from that recovery are not heartbeat effects and remain subject to the normal event and backup contracts.

The [current MCP server](../../apps/cli/src/mcp-server.ts) launches a child per command. The MCP server must own the session keeper's scheduling and process lifetime, as a timer in its process or as an owned CLI child; a per-call CLI child is not the session owner. Accepted tool calls remain per-call CLI child invocations. Keeper renewal and release use the common CLI operations, and the MCP server acquires no domain or storage implementation of its own. A dated amendment clarifies this keeper lifecycle; owning a timer or a CLI child is not a second implementation of domain behavior and creates no exception permitting in-process domain behavior. This preserves the single behavior source of [MCP-002](../specs/required-specification.md#22-mcp-access-and-zero-write-reads-milestone-m9). The supported CLI path needs an explicit long-running session owner using the same renewal and release operations. A one-shot CLI invocation cannot promise continued autonomous renewal after it exits. Keeper lifetime must be bounded by its owner; owner loss stops renewal and permits bounded lease expiry.

Qualify these ownership contracts before ADR acceptance using actual Plan-mode and read-only MCP communication, normal waiting, long authorized work, tool cancellation, agent-turn completion with a surviving connection, shutdown, keeper failure, and replacement. The qualification result must name the owner and CLI entry point, observable lifecycle signals, cancellation and shutdown behavior, supported harness modes, renewal cadence, and lease duration. If only transport connection is observable, the lease proves that connection signal, not agent activity or turn lifetime. Do not infer automatic departure from an unobservable turn-end event. A path that cannot maintain the promised lifecycle is unsupported for that guarantee, and a path requiring caller-side writes or a shell keeper cannot qualify as read-only MCP support. At least the intended primary read-only and Plan-mode harness path must actually pass; a support disclaimer does not satisfy that requirement. Renewal runs outside read and wait calls. These measurements and the concrete runner remain an outstanding adoption gate; this proposal does not claim successful runtime qualification.

Include renewal cost in that same qualification: measure process startup and renewal latency, actual log growth, and lock contention or missed renewals at the expected concurrent session count, then use those observations to select the cadence and lease duration. In an isolated home without pending recovery intents, repeated renewal alone must leave retained event count and canonical snapshot bytes unchanged, and backup must report no change. Reuse the normal qualification tools and focused checks; a separate benchmark framework is not required.

Reuse zero-write [storage admission](../../packages/adapters/src/read-storage.ts) and applicable polling and deadline primitives. The existing waits are `waitForChannelMessages` in [the Channel core](../../packages/core/src/channels.ts) and `waitForNewInboxItems` in [the Handoff read core](../../packages/core/src/handoff-read.ts). Implement Exchange-specific history cursors and wake conditions so that already delivered, unchanged pending work does not repeatedly wake the waiter. The existing Channel `afterSeq` filter and Handoff pagination cursors are not that history cursor, and the existing Channel wait is pending-inclusive, so its wake rule cannot be reused unchanged. Surface previously undelivered relevant records, new addressed messages and replies, and relevant state or membership changes. Keep unresolved requests and reports awaiting acceptance separately queryable.

Read confirmation is an explicit Active-state participant mutation requiring the current claim. It merges only the message sequences or ranges actually confirmed by that Project into compact progress; a cursor must preserve any unread gaps. After authority checks, repeating an already confirmed set is a no-op. Keep this state across ordinary restart and pause, and include current compact progress in Active and Paused backups, without a permanent per-call operation receipt or collaboration event. Resolve an uncertain confirmation by inspecting progress or repeating the same merge under a valid claim, not by creating a business-operation recovery record. Confirmation proves reading, not requester acceptance. Completion can discard progress not needed for the retained outcome.

Use the following notice terms.

| Term | Meaning |
|---|---|
| Opening Project | The Project that created the Exchange. It has finite reporting priority while eligible, without additional control authority. |
| Eligible participant | A current member with a valid session claim in an Active Exchange, authorized to report the incident. |
| Incident | One uninterrupted notice condition for a response obligation, affected Project, and notice kind. Recovery ends that episode; a later recurrence has a new incident identity. |
| Report destination | The reporting agent's user-facing harness session. Identify the Exchange, affected Project, notice kind, and pending response. Acknowledgement records that the notice was issued, not that the user read it. |

Check for notices five minutes after a response becomes necessary. Pausing suspends response notices and resumption resets the availability boundary. Lease expiry controls reclaimability; the five-minute threshold controls notice eligibility. Qualification must choose a lease duration that expires no later than the five-minute missing-heartbeat boundary, with renewal safely inside that duration. Expiry alone does not emit a notice, reset the response clock, approve work, or pause the Exchange. Classify no active claim and no heartbeat for five minutes since the later of availability or last heartbeat as a connection check. Classify a live claim with no read confirmation five minutes after availability as unread delivery. A read item with a live connection continues waiting for work. Give the eligible opening Project a finite priority window; if it is ineligible, allow another eligible participant immediately, and otherwise allow fallback after that window even if the opener's connection survives. Acquire an expiring atomic reporting claim before issuing the user-facing notice and acknowledge the incident after issue. A fresh outage after recovery can create a new incident. Related notices may be grouped for display while preserving item-level records.

### CLI, MCP, and skills

Add an `exchange` command group and matching MCP operations for creation, membership, join and replacement, inspection and history, wait, posting, read confirmation, reporting and acceptance, material registration and retrieval, proposals and votes, pause and stop, notice reporting, and replay-only recovery. Use the same application operations and JSON envelope across both transports.

Ship independently invocable `start-exchange` and `join-exchange` skills from one canonical loop reference source. Package an identical `references/exchange-loop.md` inside each skill directory and resolve it relative to that installed or copied skill. Produce both copies from the canonical source; do not maintain separate loop instructions or require the source checkout or a sibling skill to resolve the reference. GEN-011's obligation to ship the existing policy at `skills/use-sorage/SKILL.md` is preserved, and the canonical guidance is extended to cover the two Exchange skills. No generator for the bundled copies exists today. TASK-145 owns maintaining the one canonical loop-reference source, producing identical bundled copies for both skills, and verifying that each skill works when installed or copied independently; a generic skill-packaging framework is not required. The start entry point creates and reports the ID, then uses the common join path to acquire the creating Project's claim. The join entry point resolves membership and claims or recovers the session. The shared loop covers material retrieval, evidence-conscious result reporting, lightweight requester acceptance, wait cursors, restart recovery, notice escalation, and retained summaries.

## Adoption and acceptance

1. Register the planned Epic, Proposed ADR, and an adoption Task that owns the pre-adoption qualification, following the [existing adoption precedent](../governance/README.md). Select the milestone, reserve available ADR and requirement identifiers and the requirement namespace, and declare each Task's class according to its actual scope. Contract-changing implementation Tasks use the Contract class; documentation or probe Tasks are not automatically Contract. If a new milestone is chosen, update the milestone order and accepted syntax in `scripts/sot-check.ts` and the related governance and checks before relying on that milestone in registration. At registration, place this dossier under `docs/todo/`, repair its relative links, and connect the TODO index and Epic's Detailed SOT as required by the [documentation index](../README.md). Assign an owning Task to each acceptance area, including the global backup-format transition and integrated qualification.
2. In the adoption Task, qualify actual Plan-mode and read-only MCP communication, session ownership, and renewal effects and costs. Record the observed lifecycle, supported MCP and CLI paths, failure behavior, and timing defaults before ADR acceptance. Isolated probes can establish the intended transport and keeper mechanics; they do not claim acceptance of the unimplemented Exchange workflow.
3. Adopt the requirements and ADR under the [material-change process](../governance/README.md#4-material-change-control). Update the canonical interfaces, architecture, security, testing, and traceability, and revise the root agent guidance so that its skill ownership description includes the two new Exchange skills. Record dated amendments for the affected accepted decisions and rows: ADR-0007, extending its domain-specific lift of the MCP deferral to Exchange while preserving the CLI as the single behavior source, the CLI child-process adapter boundary, and an application layer free of MCP types; MCP-001 and the public tool catalogue, whose domain scope must explicitly expand to include Exchange; the MCP-002 keeper-lifecycle clarification; the MCP-004 extension for material registration; the Exchange storage scope beside SHR-001, SHR-002 and SHR-003; the fail-closed refusal of the new backup format by earlier builds under SHR-010; and the GEN-011 extension to the two Exchange skills. Record these classifications in the reviewed contract snapshot diff and migration record that [the Contract class](../governance/README.md#93-contract) requires. Planned registration is not ADR acceptance or the start of product implementation; implementation follows accepted contracts and the canonical roadmap's eligibility rules.
4. Deliver the two-Project path for creation, join, request, report, requester acceptance, material sharing, and restart recovery together with the required migration and global backup-format support.
5. Deliver roster changes, pause and resume, unanimous completion, compaction and cleanup, notices, and replay recovery. Extend storage and backup support as each further durable state is introduced.
6. Qualify both independently distributed skills and transports with a server and two clients. Reuse applicable focused evidence and run the integrated `make test` gate.

### Registration record

Master's 2026-11-19 direction selected milestone M10 because Exchange introduces a new domain and substantial new contracts. Registration records [EPIC-021](../roadmap/README.md#epic-021-exchange-peer-collaboration-between-projects) with TASK-139 through TASK-146 and [Proposed ADR-0037](../architecture-decision-records/README.md#adr-0037-exchange-as-a-separate-peer-collaboration-domain-in-m10), and reserves the `EXC` requirement namespace in the proposal documents. No `EXC` requirement exists until TASK-139 adopts it, so the registered Tasks use `None` in their Requirements cells until then. Registration also adds M10 recognition to the documentation checker and makes it report malformed or duplicate Task, requirement and reverse-index rows and unsupported milestone values instead of skipping those rows. The stricter row check exposed an unescaped pipe in the accepted CHN-003 requirement row, and registration escapes it so that the row renders in full; no requirement changes.

Registration checks establish only that the planning records are well formed. They do not establish actual read-only or Plan-mode Exchange participation; keeper lifetime across calls, cancellation, shutdown, or surviving connections; renewal cost, lock contention, or the absence of heartbeat-induced backup changes; or the correctness of the complete Exchange workflow. Those remain qualification and implementation obligations of the owning Tasks.

### Evidence by acceptance area

Use isolated Sorage homes and collect the following evidence in the owning Tasks. The adoption Task establishes the pre-adoption mechanisms; the remaining workflow evidence is collected as the corresponding implementation is delivered. TASK-140 owns the global backup-format transition, each later Task extends storage and backup for the durable state it introduces, and TASK-146 owns integrated qualification of the assembled candidate. Each bound and each retained or disposable classification is verified by the Task that first writes and first exports the record. A foundation fixture in an earlier Task yields to the end-to-end evidence of the Task that delivers the real producer, and every case below is due at the gate of its owning Task rather than first at TASK-146.

| Area | Owning Task | Required evidence |
|---|---|---|
| Read-only participation | TASK-142; voting in TASK-143; assembled evidence in TASK-146; pre-adoption mechanism in TASK-139 | A supported Plan-mode or read-only agent joins, sends, retrieves material, reports or accepts a result, and votes through actual MCP without caller-side writes or shell keeper setup. Record Plan mode and a read-only caller as separate observations, even when one run covers both. History, inspection, retrieval, and wait write zero state. |
| State and authority | TASK-141; pause and completed states in TASK-143 | Creation returns an ID without a claim; start acquires it through common join. Completed join returns the retained result with zero writes. Pause revokes all claims; an authorized member can still correct the roster or an ownership vacancy and resume with the observed pause version. Refuse paused participant work, stale autonomous pause, stale resumption, and writes from a replaced claim. |
| Large material | TASK-141; storage bounds in TASK-140 | A body above 64 KiB and a managed copy remain complete through bounded retrieval. Verify live, missing, version-changed, and escaping local references, and enforce configured storage and transport bounds. |
| Working recovery | TASK-141; pause preservation in TASK-143 | Ordinary restart and pause preserve material, obligations, and gap-preserving read progress. A late Project receives its pending requests. Other Projects continue independently. A performer's report leaves evidence available for requester verification. |
| Requester acceptance | TASK-141 | A report remains pending until its named version is accepted. Reuse an actual subsequent check where applicable, and verify focused evidence assessment without a redundant test. An announced check and an unrelated test leave the report pending. Bundled acceptance affects only explicitly checked versions. |
| Reassignment | TASK-143 | Remove requester and assignee Projects in separate cases, explicitly transfer their responsibilities, and fence stale reports and acceptances that arrive after each removal. Preserve evidence and outstanding dispositions. |
| Final agreement | TASK-143 | Observe objections and fresh unanimous votes after changed work or membership. An existing actionable request omitted from the proposal still blocks completion unless accepted or covered by an agreed cancellation or transfer. Race the final vote against a new actionable request, a roster change, or stop. Routine bookkeeping preserves approvals. |
| Retention and cleanup | TASK-143 for summaries, decision-reason fields, compaction and cleanup; workflow-text bounds and classification of goals, criteria and requests in TASK-141, their first writer; disposable-byte exclusion in TASK-140 with foundation fixtures and in TASK-141 with real payloads | Retain the exact approved summary and essential attribution. Enforce the separate summary and workflow-text budgets, including aggregate text collections, without truncation or restricting ordinary message capacity. Retire detailed bodies and copies while preserving originals and material with other live references. Recover interrupted cleanup visibly. Inspect Git history, snapshots, and receipts for exclusion of disposable bytes; earlier compact candidate summaries and workflow descriptions are permitted metadata. |
| Backup and retries | TASK-140 for the format transition and old-reader refusal; replay, discovery, gap-preserving progress and exported path redaction in TASK-141; restored join, rebinding and omitted or retired states in TASK-143; each later Task for the refusal of a representation it adds that an earlier build of the same format cannot import | Upgrade the current schema, restore a legacy backup, verify that a build predating the new format refuses it without a partial import, and round-trip active, paused, and completed Exchanges through the new global format. A restored join view explains goals, conditions, criteria, and pending decisions despite omitted detailed bodies. Verify local-path redaction and unavailable restored references until rebinding and authorized revalidation, even when paths were exported. Verify omitted and retired payload states, empty restored leases, same-ID replay, changed-input conflict, and distinct IDs for identical messages. Discover prior operations after session replacement and creation response loss. Preserve compact recovery through completion and restore; replay misses never execute. |
| Sessions, waits, and notices | TASK-142; notices in TASK-144; pre-adoption measurements in TASK-139 | Measure supported MCP and CLI owner lifetimes through normal waiting and long authorized work, cancellation of one call while the connection and owner survive, stopping of the owner, surviving connections, shutdown, and keeper failure and replacement, first with the TASK-139 probes and again with the delivered keeper and CLI session owner in TASK-142. Record renewal cost, log growth, and contention at expected concurrency. Renewal alone in a home without pending intents leaves retained events and canonical snapshot output unchanged and backup reports no change. Fence replaced agents and rejoin through reboot or authorized resumption. Repeated read confirmations merge exact progress without per-call permanent receipts or events and never mark gaps as read. Verify no busy loop on unchanged pending work, separate lease and notice clocks, suspended paused notices, finite opener priority, ineligible-opener fallback, fallback after the opener's window while its connection survives, at most one concurrent holder of a reporting claim, reclaim of an expired unacknowledged claim, incident acknowledgement, reconnect, and a new incident after recovery. |
| Distribution and compatibility | TASK-145; assembled evidence in TASK-146 | Install or copy each skill independently and exercise its bundled canonical reference through supported CLI and MCP. Preserve Handoff, Memo, Channel, and legacy backup import behavior. |

## Execution design

EPIC-021 is executed through an explicitly invoked Aquarium Epic handler. This section records how the Epic uses that handler: role duties, the gates each member Task passes, the Goal Procedure adaptation that enforces a plan assessment, and the review intensity per Task. It is execution guidance for this Epic only. It defines no product behavior, grants no authority, and expires with this dossier. The root agent guidance remains the single binding to Aquarium tooling, and the handler keeps its own review topology, assessment budgets and lifecycle rules under [governance section 18.1](../governance/README.md#181-proportionate-verification-and-review).

The design borrows the stage structure of Aquarium's Epic Squad: a Task plan is assessed before implementation starts, and the same Evaluator follows the Epic across its Tasks. The installed handler does not support Squad review panels, a separate Task Evaluator or per-role execution profiles, so those are not part of this design.

### Roles

| Squad role | In this Epic's handler execution |
|---|---|
| Coordinator | The session running the Epic handler. It owns scope, dispatch, every Decision, the plan followup and work-entry records, delegated acceptance and commits. It does not take over technical diagnosis or repair design from the Executor. |
| Epic Evaluator | The handler's single retained Evaluator, report-only. For each goal it assesses the plan, the delivered candidate, the fidelity and completeness of the admitted technical-review evidence, and the final goal outcome. It stays with the Epic through member Tasks, corrections, internal validation and closeout, and carries Epic direction, earlier outputs and downstream handoffs from one Task to the next. |
| Task Evaluator | Not available under the handler. Plan detail is covered by the plan assessment, and result detail by the Epic Evaluator's work and technical-evidence checkpoints. |
| Task Operator, author | The Executor that produces the plan and then the work. Only one Executor writes to the shared checkout at a time. |
| Task Operator, independent review | The review team of the selected technical-review route. It is separate from the implementing session and is never an Evaluator. |
| Support Operator | An optional report-only helper assignment inside one Action, used for factual investigation or assigned checks. It is not a Procedure node and returns no verdict. |

### Gates for each goal

1. Plan, at `record-plan`. The Executor records a bounded plan: the Task's requirements and acceptance gate, handoffs from completed Tasks, affected boundaries, risk, checks and failure paths, documentation, the commit boundary, and the review route selected for this goal's envelope. The Coordinator narrows this assignment to planning only, because the handler copies the ordinary Executor authority into every Executor dispatch. The step grants no implementation authority.
2. Plan assessment, at `evaluator-plan` and `decide-plan-assessment`. The Evaluator assesses the exact plan against the Task's criteria and against Epic direction and downstream obligations. Its checkpoint covers the plan obligations due now; implementation and test criteria that cannot be met yet stay recorded as unmet or unverified in the global verdict and do not block this checkpoint. A failed checkpoint goes to `record-plan-followup` and an inconclusive one to `record-plan-evidence`, where the Coordinator must record existing authority before the plan returns to its author. Without that authority the goal stays blocked at this stage.
3. Work entry, at `prepare-work-entry`. The Coordinator binds the work to the current plan and its passing assessment.
4. Implementation, at `complete-work`. The Executor delivers the candidate with its own verification and documentation under [the proportionate verification policy](../governance/README.md#181-proportionate-verification-and-review).
5. Work assessment. The Evaluator assesses the delivered candidate from original evidence, with the plan and its assessment in front of it.
6. Technical review and its evidence assessment. The selected route reviews the exact candidate, and the Evaluator then assesses whether the admitted review evidence is faithful and complete. A waiver does not satisfy the Reviewer requirement for a Standard or Contract Task.
7. Final goal assessment. The Evaluator assesses the goal with the plan evidence, the work evidence and the review evidence in front of it.
8. Acceptance and commit. Member Tasks use the delegated acceptance and the one commit per Task that the approved execution envelope grants. Epic closeout needs Master's own acceptance.

### Goal Procedure adaptation

The managed Aquarium Goal Procedure, version 37, has no Evaluator checkpoint before implementation. The managed Aquarium Task Procedure, version 34, has a complete plan stage, and Aquarium publishes operation contracts for its definitions: the plan record's output is a task plan rather than product work, and its assessment is a plan checkpoint. The adaptation places that Task plan stage in front of the Goal's first work node. It copies seven Task definitions with their bodies unchanged, so each keeps its published contract, and it changes no managed definition. Neither managed file under `.podway/procedures/` is edited; the adaptation is a separate definition with its own identity.

| Definition in the adaptation | Managed Task definition it copies | Placements |
|---|---|---|
| `plan-record` | `plan-record` | `record-plan` |
| `plan-evaluator-assessment-record` | `evaluator-assessment-record` | `evaluator-plan` |
| `semantic-plan-decision` | `semantic-plan-decision` | `decide-plan-assessment` |
| `semantic-plan-followup` | `semantic-plan-followup` | `record-plan-followup`, `record-plan-evidence` |
| `semantic-plan-followup-authority` | `semantic-plan-followup-authority` | `confirm-plan-followup-authority` |
| `semantic-plan-followup-authority-evidence` | `semantic-plan-followup-authority-evidence` | `confirm-plan-evidence-authority` |
| `implementation-entry-record` | `implementation-entry-record` | `prepare-work-entry` |

The Goal already has a definition named `evaluator-assessment-record` with a different body, so the Task's assessment definition takes the name `plan-evaluator-assessment-record`. The copied text still names the Task handler and asks for Task review fields. The handler's assignment defines the goal scope, not the node wording, and the Coordinator states in the plan assignment what the required review fields carry for a goal: the route and review team already approved in the Epic envelope, the current pinned baseline, and the planned review scope, with the actual candidate evidence still due at the work record. A closeout goal carries its real approved review context and the identity of the validated implementation, uses the validated-closeout substitute, and records no new provider review, ordinal or waiver.

| Change | Content |
|---|---|
| Identity | A new `aquarium-adapt-goal-<token>` id at version `1`, with its own name, purpose and description |
| Entry | `complete-work` becomes `record-plan` |
| New placements | The eight plan-stage placements below |
| Placement `complete-work` | Reads the current plan summary and work-entry record, and the handoff plan when one is attached |
| Placements `evaluator-work`, `evaluator-goal`, `evaluator-stopped-goal` | Each reads the plan, the plan assessment with its applicability and checkpoint result, and the work-entry record |
| Manual rework | `record-plan`, `evaluator-plan`, `record-plan-followup`, `record-plan-evidence` and `prepare-work-entry` join the allowed targets |
| Everything else | Unchanged: all 62 managed Goal definitions and the other 88 managed placements, including every declared rework route, review routing, assessment ordinals, correction handling, final assessment, acceptance and closeout |

The eight placements, added at the start of `graph.nodes` with `graph.entry: record-plan`:

```yaml
    - id: record-plan
      use: plan-record
      next: evaluator-plan
    - id: evaluator-plan
      use: plan-evaluator-assessment-record
      evidence_from:
        - node: record-plan
          required: true
          items:
            - plan-summary
            - review-route
            - review-target-scope
            - review-selection-summary
            - plan-handoff-artifact
            - executor-handoff
      next: decide-plan-assessment
    - id: decide-plan-assessment
      use: semantic-plan-decision
      evidence_from:
        - node: evaluator-plan
          required: true
          items:
            - evaluator-assessment
            - evaluator-verdict
            - evaluator-unmet-criteria
            - evaluator-unverified-criteria
            - evaluator-applicability
            - evaluator-summary
            - evaluator-checkpoint-result
      routes:
        passed:
          to: prepare-work-entry
          effect: advance
        inapplicable:
          to: evaluator-plan
          effect: rework
        rework:
          to: record-plan-followup
          effect: advance
        evidence-needed:
          to: record-plan-evidence
          effect: advance
    - id: record-plan-followup
      use: semantic-plan-followup
      evidence_from:
        - node: evaluator-plan
          required: true
          items:
            - evaluator-assessment
            - evaluator-verdict
            - evaluator-unmet-criteria
            - evaluator-unverified-criteria
            - evaluator-applicability
            - evaluator-summary
      next: confirm-plan-followup-authority
    - id: confirm-plan-followup-authority
      use: semantic-plan-followup-authority
      evidence_from:
        - node: record-plan-followup
          required: true
          items:
            - semantic-authority
            - semantic-followup-summary
      routes:
        authorized:
          to: record-plan
          effect: rework
        blocked:
          to: record-plan-followup
          effect: rework
    - id: record-plan-evidence
      use: semantic-plan-followup
      evidence_from:
        - node: evaluator-plan
          required: true
          items:
            - evaluator-assessment
            - evaluator-verdict
            - evaluator-unmet-criteria
            - evaluator-unverified-criteria
            - evaluator-applicability
            - evaluator-summary
      next: confirm-plan-evidence-authority
    - id: confirm-plan-evidence-authority
      use: semantic-plan-followup-authority-evidence
      evidence_from:
        - node: record-plan-evidence
          required: true
          items:
            - semantic-authority
            - semantic-followup-summary
      routes:
        authorized:
          to: record-plan
          effect: rework
        blocked:
          to: record-plan-evidence
          effect: rework
    - id: prepare-work-entry
      use: implementation-entry-record
      evidence_from:
        - node: record-plan
          required: true
          items:
            - plan-summary
        - node: evaluator-plan
          required: true
          items:
            - evaluator-verdict
            - evaluator-applicability
            - evaluator-checkpoint-result
        - node: record-plan
          required: false
          items:
            - plan-handoff-artifact
      next: complete-work
```

The `complete-work` placement after the change:

```yaml
    - id: complete-work
      use: work-record
      evidence_from:
        - node: record-plan
          required: true
          items:
            - plan-summary
        - node: prepare-work-entry
          required: true
          items:
            - implementation-entry-summary
        - node: record-plan
          required: false
          items:
            - plan-handoff-artifact
      next: evaluator-work
```

The evidence rows added in front of the existing rows of `evaluator-work`, `evaluator-goal` and `evaluator-stopped-goal`:

```yaml
        - node: record-plan
          required: true
          items:
            - plan-summary
            - executor-handoff
        - node: evaluator-plan
          required: true
          items:
            - evaluator-assessment
            - evaluator-verdict
            - evaluator-applicability
            - evaluator-checkpoint-result
            - evaluator-summary
        - node: prepare-work-entry
          required: true
          items:
            - implementation-entry-summary
```

### Binding

The binding is the one Aquarium publishes for the managed Goal, with every inherited node, obligation, goal-assessment and closeout record unchanged, plus the records Aquarium publishes for the copied Task definitions.

| Placement | Kind | Role | Effects | Capability |
|---|---|---|---|---|
| `record-plan` | action | executor | work | None |
| `evaluator-plan` | action | evaluator | None | `aquarium.task.phase-assessment/v2` |
| `decide-plan-assessment` | decision | coordinator | None | None |
| `record-plan-followup`, `record-plan-evidence` | action | coordinator | work | None |
| `confirm-plan-followup-authority`, `confirm-plan-evidence-authority` | decision | coordinator | None | None |
| `prepare-work-entry` | action | coordinator | work | None |

The `work` effect on the three Coordinator records is the coarse declaration of the published Task binding; their operation contracts classify them as evidence records. The binding adds one obligation, the published Task obligation for `evaluator-plan`: its producers are the `record-plan` items, its evidence is its own assessment, and its consuming Decision is `decide-plan-assessment`.

### Plan handoff

`plan-handoff` applies only when Master explicitly selects that mode. Its mapping attaches the approved Epic plan at the plan record and stops before the first product work:

```json
{"attachment": {"node": "record-plan", "item": "plan-handoff-artifact"}, "first_work": ["complete-work"]}
```

The plan record admits a Markdown artifact, and because its output is a task plan, `complete-work` remains the only first-work placement. `prepare-work-entry` and `complete-work` select the attached plan, so the work boundary can verify it. A session prepared in this mode therefore records and assesses its plan before it stops, so the handoff operations Master approves include that scoped planning dispatch and its assessment. Every later member, remediation, validation and closeout session attaches the same plan under the handler's existing handoff rules.

### Plan currency and returns to work

`complete-work` cannot run without a current plan summary and a current entry record, and the work assessment and both final assessments read the plan and the assessment it passed under. No managed route changes. A declared return to work still targets `complete-work`, where the managed work record binds the rework cause to that attempt, and it keeps the plan, its assessment and the entry record. Whether that is right depends on what the return changes, and the Coordinator decides it before dispatching the work again:

- The assessed plan is preserved for evidence repair, an unchanged scope, and a bounded correction that the plan already covers under the same adopted contracts, the same review route and the same review target scope. Reviewed byte changes inside that planned scope preserve it.
- The plan returns to its author through manual rework to `record-plan` when the correction changes the scope, an adopted contract or requirement the plan relied on, the reading of the acceptance gate, the review target scope, or the planned review route. An approved `change-route` direction therefore re-enters at `record-plan` whenever it changes the route the plan recorded.
- The plan is reassessed through manual rework to `evaluator-plan` when its bytes stand but the basis of its assessment changed, such as a criterion, a parent constraint or the authority it assumed.
- The entry record is renewed through manual rework to `prepare-work-entry` when only the entry basis changed.

Manual rework needs existing authority; a negative verdict grants none, and no re-entry creates a review ordinal, a correction grant or a new acceptance. Rework invalidates the target and everything after it, and it reverses no product or Git effect, so the affected work, review and acceptance evidence is verified again after the re-entry. On a manual re-entry the Coordinator records the source Decision and attempt, the cause, the candidate, the effective review route, the consumed review ordinals and the remaining grants, at the entry record or at the node it re-enters. A `changes-requested` return after closeout approval stays within the same goal only for record-only closeout changes or the correction of a stopped outcome; a change to validated implementation settles the closeout session and returns through owned correction and renewed validation, as the handler already requires.

### Stops during planning

A recoverable gap keeps the current attempt: the blocked option of each followup Decision returns to its own record until authority or evidence arrives. The managed stopped-goal path starts after delivered work and needs that work's evidence, so it does not represent a stop before work. When Master stops a goal during planning, the handler uses its existing in-progress stop choices: leave the session for a later resume, or cancel it under Master's explicit authorization with its history preserved. Neither records a goal outcome, completes the Task or permits a commit, and the `passed` route is never taken only to reach closeout.

### Goal kinds

The plan stage applies to every goal the handler runs with this definition. A pre-validation remediation goal records a bounded correction plan under its existing correction grant and budget. A closeout goal records a short record plan after successful internal validation and keeps its validated-closeout substitute, its focused closeout checks and Master's own acceptance. Each successor session keeps its actual goal kind and selected review context.

### Draft and its checks

A draft of the complete source and its binding mapping is kept as an ignored local candidate under `.podway/procedures/.local/`, generated from the managed Goal and Task bytes. It is not tracked and is not an admitted definition. With Podway v0.2.17 the draft passes the authoring checks with warnings as errors and previews as admissible. With Aquarium 0.1.23, for the member-task, pre-validation-remediation and epic-closeout goal kinds and the `herdr` and `subagent-review` routes, it passes structural qualification with `complete-work` as the only first-work placement, as the unchanged managed Goal does; the handoff consumer's static checks accept the mapping above; and the changed-basis recovery finds `evaluator-plan` as the planning Evaluator. The qualification and recovery results also hold with the bootstrap placements inserted. These checks show that the definition is well formed. They are not a suitability assessment, and they are not evidence of preparation, retention, an attached plan, a rework invalidation or any handler run.

### Review intensity

Risk decides the recommended review route. The final choice belongs to the handler's plan and execution-envelope approval.

| Task | Risk | Recommended route | Reason |
|---|---|---|---|
| TASK-139 | Elevated | `herdr` | Adopts public contracts and decides the keeper lifecycle from qualification evidence |
| TASK-140 | Elevated | `herdr` | Schema migration and a global backup format shared by every domain |
| TASK-141 | Elevated | `herdr` | Core authority rules, CLI contract and business-operation recovery |
| TASK-142 | Elevated | `herdr` | Changes the MCP server process that every published tool shares |
| TASK-143 | Elevated | `herdr` | Atomic completion, races and cleanup of retained evidence |
| TASK-144 | Standard | `subagent-review` | Bounded notice rules on top of settled sessions |
| TASK-145 | Standard | `subagent-review` | Skills and guidance without a new storage or transport contract |
| TASK-146 | Standard | `subagent-review` | Qualification of an assembled candidate without new behavior |

### What the handler session still owns

The ignored draft is an input to authoring. It becomes usable only through the handler's own preparation and qualification, inside the plan and execution envelope Master approves.

- Disclose the adaptation in the handler's procedure plan for the Goal family and the Epic handler entrypoint: the exact managed Goal bytes as its base, the complete source, the binding mapping and the reason. Record why the unchanged managed Goal is not adequate here, which is that the roadmap's execution policy requires the plan assessment.
- Supply coverage that maps every original criterion and part of the EPIC-021 roadmap section and of this dossier to a binding obligation, with the actual goal kind, the selected review and the expected outcome as qualification context.
- Use only the preparation roots, write root and native authoring that the approved envelope discloses. Preparation may assign a different identity token, and bootstrap preparation of a new definition inserts a suitability-import record and its applicability Decision ahead of the plan stage.
- Obtain the independent suitability assessment for the exact prepared bundle and retain the qualified bundle before the first session starts. Registration performs neither.
- Use the managed Validation Procedure unchanged for the internal Epic validation.
- If the adaptation cannot be qualified against the installed Aquarium contract, stop before work and report to Master. The roadmap's execution policy requires the plan assessment, so running member Tasks on the unchanged managed Goal is a different execution envelope that needs Master's explicit approval and a matching edit of that policy. Do not edit a managed file to add the stage.
