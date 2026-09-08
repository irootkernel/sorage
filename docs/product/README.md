# Product Charter

This document is non-normative context: it states the problem, the goals, and the deliberate exclusions that the normative documents implement, and it never overrides a normative document or settles a conflict.

## 1. Problem

A local machine may contain many software projects developed by separate AI sessions, and those projects occasionally need to request interfaces, design changes, implementation support, contract updates, or review from one another.

Without Sorage the User must manually create files, locate target workspaces, copy or move documents, transfer paths or identifiers, monitor feedback, and remember which revision was agreed; the work is repetitive, error-prone, and impossible to audit afterwards.

Delivery alone does not solve it, because the loop has to close on the receiving side as well: an AI session that is never told a document arrived will never look, so discovery must be a product feature rather than a hope.

The layouts that actually exist on a development machine make this harder than a single directory per project suggests: git worktrees and monorepo checkouts are normal, and a design that treats each checkout as a separate stranger excludes exactly the review sessions that most need to receive a Handoff.

## 2. Mission

Sorage gives local projects and workspaces a small, reliable custodian for project-to-project document handoffs.

It makes the following facts explicit:

- Who sent the document
- Which Project must review it
- What the current document is
- Whether feedback exists
- Whether the current Artifact has been fetched, through `firstFetchedAt`
- Who must act next
- How many document revisions occurred
- Which Revision was accepted, or whether it was declined or withdrawn
- Whether the Handoff should be retained, archived, or deleted
- Whether the Vault has been backed up

## 3. Product position

Sorage is a document-handoff and review broker.

It is not:

- A collaborative editor
- A Git replacement
- A general document management platform
- A ticket tracker
- A chat or discussion service
- A multi-agent orchestrator
- An MCP server in the MVP
- A remote file synchronization service in the MVP

### 3.1 Ecosystem position

Sorage is a standalone repository, `irootkernel/sorage`, holding both its code and its Source of Truth, and it builds, tests, and packages from its own root.

Aquarium, Podway, Mulgae, Gaori, and Sanho are development tooling for this repository; none of them is a source dependency of any Sorage package, and Sorage requires no change to any of them.

Discovery ships as the `use-sorage` skill at `skills/use-sorage/SKILL.md` in this repository, which states the explicit-request broker policy that closes the loop described in G-01.

The named integration seam for another tool that needs to point at a Handoff is the Podway `ExternalReference` artifact slot; a tool references a Handoff by its UUID through the public CLI or the local API and never by importing a Sorage package.

Adjacent uses of the same word are out of scope and are not Sorage Handoffs: the Aquarium plan handoff moves an approved plan between agent sessions, the Podway `handed_off` task state records that a workflow reached an external result, the dolgorae writer handoff is that tool's internal file convention, and Sanho documentation sync is a commit-boundary concern.

## 4. Goals

### G-01: Eliminate manual project-to-project transfer

A sender creates a Handoff with one command or one Web action, and the recipient session learns of it through the `use-sorage` policy, `inbox --wait`, or the optional inbox marker, never through a manually copied file path.

### G-02: Preserve clear responsibility

Every Handoff derives and exposes its next actor:

- Recipient review while the state is `awaiting_recipient`
- Sender revision while the state is `changes_requested`
- No action once the state is `accepted`, `declined`, or `withdrawn`, or once the Handoff is a tombstone
- The User in addition, whenever a deletion request is pending or an integrity or configuration failure is recorded

### G-03: Keep review semantics small

A Handoff carries one current Review Note rather than a comment thread, and the sender answers by revising the document itself.

Small does not mean stuck, so the state machine has bounded escape hatches that need no human: the recipient may withdraw the current Note whichever actor authored it, the sender may record one no-change resolution with a reason, the recipient may decline with a reason, and the sender may withdraw a Handoff the recipient has neither fetched nor reviewed.

### G-04: Support safe local operation

The MVP runs on one macOS machine for one operating-system user, in three milestones: `M1` delivers the CLI, SQLite, and the Vault with no network listener at all; `M2` adds the loopback daemon, the local HTTP API, and the Web UI behind Host validation and bearer authentication; `M3` adds Git backup, the scheduler, the LaunchAgent, and packaging.

### G-05: Provide recoverable storage

The User can connect the Vault to Git and enable daily backup; Sorage exports deterministic metadata snapshots and the event ledger, verifies current Artifacts, and commits only managed paths.

Recovery is a command rather than a manual reconstruction: `sorage backup restore --from <vault-path>` rebuilds Projects, Handoffs, Review Notes, and lifecycle state into an empty installation and verifies every checksum.

The limit is stated rather than hidden: Sorage keeps only the current Artifact, so a Revision created and replaced between two backup runs is not preserved anywhere.

### G-06: Preserve an expansion path

Storage, Project identity, actor context, and the API boundary must allow later Linux and multi-machine support without redefining the Handoff domain.

The seam that makes this possible is the CLI transport adapter: commands call a use-case interface, and whether that interface is satisfied by a direct in-process call or by an HTTP client is an adapter choice invisible to the command implementations.

### G-07: Integrate cleanly with the Root Kernel ecosystem

Sorage must build, test, and package from its own repository root through `make`, without changing any ecosystem tool.

Delivery is driven by the Aquarium roadmap handlers against the single active pointer in `../roadmap/README.md`, and interoperability is provided by the shipped `use-sorage` skill rather than by a handler inside another repository.

## 5. Primary actors

| Actor | Description |
|---|---|
| Registered Project | A logical project with at least one directory binding on this Installation; every git worktree of a registered repository resolves to it |
| Agent session acting as a Project | An AI coding session whose working directory resolves to a registered Project, which is how nearly every Handoff is created, reviewed, revised, and accepted |
| Unregistered Workspace | A directory that is not bound to any Project; it may send a Handoff and list its own outbox, but it may not receive one |
| Recipient Project | The one active registered Project assigned to review a Handoff |
| Local User | The human operator, who holds administrative authority and acts through the Web UI or through `--as-user` |
| Sorage Daemon | The milestone M2 process that serves the Web UI and the local API, runs the scheduler, and runs garbage collection |
| Git Backup Scheduler | The milestone M3 daemon-owned job that exports snapshots and commits backup state |

## 6. Key use cases

### UC-01: Registered Project sends to registered Project

Project A sends a design request to Project B; Project B finds it in its inbox, fetches the managed Artifact, requests changes, and later accepts the revised document at a named Revision.

### UC-02: Unregistered Workspace sends to a Project

An experimental directory sends a request to a registered Project, Sorage records the sender as an unregistered Workspace, and the same workspace later finds its outbox by its stable workspace key.

### UC-03: One source targets several recipients

Project A targets Projects B, C, and D; Sorage creates three independent Handoffs in one Dispatch Group, and each recipient may produce different feedback, revisions, and decisions.

### UC-04: User uploads through the Web

The User uploads a document, selects a sender identity, selects recipient Projects, and creates independent Handoffs, each with its own displayed UUID.

### UC-05: Review and revision

The recipient adds one Review Note; the sender either imports a changed document with `revise --file`, which atomically increments Revision and removes the Note, or records `revise --no-change --reason <text>` when the Note is answered without a content change, which leaves Revision unchanged, is available only while a Note is outstanding, and is allowed only once in a row.

### UC-06: Accept and retain

The recipient accepts a specific Revision with the expected Revision and Row Version, after which the content is immutable; the User may pin the Handoff for long-term retention and archive it out of the default operational view.

### UC-07: User-approved deletion

A Project requests deletion, which it may file in any state that is not already a tombstone, and the User approves or rejects it.

Approval is allowed only once the Handoff has reached a terminal review state, so no exchange is ever deleted out from under a participant who is still waiting; approval then detaches the current Artifact and the Review Note and leaves a minimal tombstone plus an event.

Every tombstone is therefore terminal, and it refuses every content and review operation while remaining readable, listable, and available for pin, unpin, archive, and unarchive.

### UC-08: Daily Git backup

The daemon exports consistent current snapshots and the event ledger, commits only changed managed paths, and optionally pushes fast-forward only, with no force, merge, or rebase behavior.

### UC-09: Decline or withdraw

The recipient ends a Handoff it will not take with `decline --reason <text>`, or the sender recalls a Handoff sent by mistake with `withdraw`.

Withdrawal is deliberately narrow: it is blocked as soon as the recipient has engaged with the Handoff, meaning it has fetched the Artifact or written a Review Note, so a document somebody has already read or answered can never be silently recalled.

Both states are terminal and record who ended the exchange; decline additionally records the recipient's reason, and neither state leaves the other side waiting.

### UC-10: Worktree participant

A review session running in a git worktree of a registered repository resolves to that same Project, so it sees the same inbox and the same outbox as the main checkout, without registering the worktree as a separate Project.

## 7. Success criteria

The MVP is successful when:

1. A fresh macOS installation can be initialized without manual file creation.
2. A registered Project can send a document to another registered Project.
3. The recipient discovers the Handoff through `sorage inbox` without receiving a manually copied path.
4. A single Review Note can be created and atomically resolved by a revision.
5. An accepted Revision cannot be silently changed.
6. Multiple recipients produce independent Handoffs.
7. Unregistered Workspaces can send and resolve their own outbox.
8. The Web dashboard accurately shows awaiting recipient, changes requested, accepted, declined, withdrawn, pinned, archived, deleted, and deletion-requested Handoffs.
9. Configuration can be inspected and safely edited through CLI and Web.
10. A scheduled Git backup can complete, report status, and fail safely, demonstrated by AJ-14.
11. No manual copy or move is needed during the normal Handoff workflow.
12. All MVP acceptance journeys pass on a clean macOS user account: AJ-01 to AJ-10 at the M1 gate, AJ-11 to AJ-13 at the M2 gate, and AJ-14 to AJ-16 at the M3 gate.
13. Sorage builds and tests from the repository root through `make test` on a clean checkout.
14. The `use-sorage` skill closes the discovery loop, demonstrated by AJ-04 and AJ-07.
15. All user-facing and machine-facing identifiers use the canonical Sorage naming system.
16. A git worktree of a registered repository sends and receives as that Project, demonstrated by AJ-03.
17. A declined or withdrawn Handoff is terminal, is refused by every content operation, and stays visible in listings and on the dashboard, demonstrated by AJ-07.
18. `sorage backup restore` into a clean account reproduces every recorded checksum, demonstrated by AJ-15.

## 8. Non-goals

The MVP excludes:

- Linux packaging and service integration
- Multiple machines
- Remote server mode
- Remote user accounts and authentication
- MCP
- Webhooks, desktop notifications, and any notification beyond the optional inbox marker and `inbox --wait`
- Comment threads
- Multiple Review Notes
- Multiple recipients inside one Handoff
- Native historical Artifact retention
- Full-text search engine
- Collaborative editing
- Git conflict resolution
- Git history rewriting
- End-to-end encryption
- Directory or archive bundle upload
- A YAML editor in the Web UI, which offers a read-only view of the canonical file instead
- A Web Vault relocation screen, because relocation uses `sorage vault move --to <path>`
- Single-phase deletion, because deletion is always request plus User approval and always leaves a tombstone
- Handlers inside the Aquarium repository, or any other change to an ecosystem tool
