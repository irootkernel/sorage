# Required Specification

## 1. Scope

This document is the normative product requirement set for the Sorage (소라게) MVP and is the highest authority in the Source of Truth.

Sorage is developed, tested, and released from the standalone repository `irootkernel/sorage`; ecosystem tools are used only as development tooling and are never source dependencies.

The MVP is delivered in three milestones: `M1` CLI core, `M2` daemon with local HTTP API and Web UI, and `M3` Git backup, scheduling, and packaging.

Every requirement row carries a `Milestone` value of `M1`, `M2`, `M3`, or `Deferred`; the value names the release gate at whose passing the requirement MUST be fully satisfied, and `Deferred` marks work outside the MVP.

A requirement whose clauses span gates carries the earliest of them and phrases the later clause conditionally, as in "once the daemon exists".

The MVP is complete when the M3 MVP release gate passes; passing the M1 CLI release gate or the M2 daemon and Web release gate does not complete it.

Section 17 summarizes the milestones, their requirement scope, and their release gates.

## 2. Product and installation

| ID | Milestone | Requirement |
|---|---|---|
| GEN-001 | M1 | The official product name MUST be `Sorage` with Korean name `소라게`; the executable name MUST be `sorage`. |
| GEN-002 | M1 | The MVP MUST support macOS as its release platform. |
| GEN-003 | M1 | The implementation MUST use TypeScript for daemon, CLI, shared libraries, and Web application code. |
| GEN-004 | M1 | The MVP MUST run as a local application for one operating-system user. |
| GEN-005 | M2 | The daemon MUST bind only to loopback interfaces. |
| GEN-006 | M2 | The MVP MUST provide CLI, local HTTP API, and Web UI. |
| GEN-007 | M1 | MCP MUST NOT be included in the MVP. |
| GEN-008 | M1 | The product MUST NOT require a cloud service for any MVP workflow. |
| GEN-009 | M1 | Sorage MUST be developed, tested, and released from the standalone repository `irootkernel/sorage`, and no Sorage package MUST declare an ecosystem tool as a source dependency, verified by the dependency-boundary check in `make test-prepare`. |
| GEN-010 | M1 | Sorage core MUST run with no ecosystem tool installed, verified by executing `make test-int` against a clean temporary `SORAGE_HOME`. |
| GEN-011 | M1 | Sorage MUST NOT require any change to the Aquarium repository or to any other ecosystem tool, and MUST ship its own agent policy as `skills/use-sorage/SKILL.md` in this repository. |
| GEN-012 | M1 | Epic identifiers `EPIC-NNN` and globally sequential Task identifiers `TASK-NNN` MUST be immutable once committed to this repository. |
| GEN-013 | M1 | The MVP MUST be delivered in the three milestones defined in section 17, each closed by its own release gate. |
| GEN-014 | M1 | The `use-sorage` skill MUST start broker operations only on explicit user request, MUST NOT trigger inbox or outbox checks at session start, task or turn boundaries, or from Sorage mentions or code work, and MUST limit checks to reporting the requested results without processing Handoffs. It MUST permit continuation of an authorized operation to completion without resuming discovery during later unrelated work, MUST require an explicit request for inbox waiting or Handoff processing, and MUST forbid editing managed Vault files directly. |

## 3. Initialization

| ID | Milestone | Requirement |
|---|---|---|
| INIT-001 | M1 | The default Sorage home directory MUST be `~/.sorage`. |
| INIT-002 | M1 | The canonical configuration file MUST be `~/.sorage/config.yaml`. |
| INIT-003 | M1 | `sorage init` MUST create the required directories, configuration, installation identity, operational database, and Vault marker, and from milestone M2 MUST also create the local API token at `~/.sorage/state/api-token`. |
| INIT-004 | M3 | `sorage init` MUST support an interactive mode. |
| INIT-005 | M1 | `sorage init` MUST support a fully non-interactive mode with explicit flags. |
| INIT-006 | M1 | Initialization MUST be idempotent and MUST NOT overwrite an existing valid installation without explicit reconfiguration or repair. |
| INIT-007 | M3 | Initialization MUST offer optional Git repository initialization for the Vault. |
| INIT-008 | M3 | Initialization MUST offer optional daily Git backup configuration. |
| INIT-009 | M3 | Initialization MUST offer optional macOS LaunchAgent installation. |
| INIT-010 | M3 | Initialization SHOULD offer optional first Project registration. |
| INIT-011 | M1 | Before initialization, only `init`, `help`, `version`, `completion`, and `doctor` MAY run. |
| INIT-012 | M1 | Other pre-initialization commands MUST return `NOT_INITIALIZED`, the expected config path, and `sorage init` as the suggested command. |
| INIT-013 | M1 | A malformed existing configuration MUST NOT be destructively replaced by normal `init`. |
| INIT-014 | M1 | `doctor` MUST be usable before and after initialization. |
| INIT-015 | M1 | Every command MUST honor `SORAGE_HOME` as the home-directory override and MUST fall back to `~/.sorage` when the variable is unset. |
| INIT-016 | M3 | `sorage uninstall` MUST require `--as-user --confirm`, MUST remove the LaunchAgent, `~/.sorage/state`, `~/.sorage/run`, `~/.sorage/logs`, and `~/.sorage/config.yaml`, MUST NOT delete the Vault, and MUST print the retained Vault path. |
| INIT-017 | M1 | `sorage doctor` MUST emit a stable check catalog in which every check carries a canonical dotted `id` such as `vault.marker`, a `severity` of `ok`, `warning`, or `blocking`, a `message`, and an optional `recovery`, MUST exit 0 when no check is `blocking`, and MUST carry that catalog in the versioned CLI JSON contract. |

## 4. Configuration

| ID | Milestone | Requirement |
|---|---|---|
| CFG-001 | M1 | Configuration MUST have numeric `schemaVersion`. |
| CFG-002 | M1 | Configuration MUST have monotonic `configRevision`. |
| CFG-003 | M1 | Configuration MUST contain stable UUID `installationId`. |
| CFG-004 | M1 | Configuration MUST contain the Vault path. |
| CFG-005 | M1 | Configuration MUST contain loopback server settings. |
| CFG-006 | M1 | Configuration MUST contain sender policy and Artifact limits. |
| CFG-007 | M1 | Configuration MUST contain Git backup settings. |
| CFG-008 | M1 | Secrets, Git credentials, and access tokens MUST NOT be stored in `config.yaml`. |
| CFG-009 | M1 | Configuration loading MUST expand `~`, normalize paths, and validate the complete schema. |
| CFG-010 | M1 | Writes MUST use locking, a temporary file, `fsync`, atomic rename, and permission restoration. |
| CFG-011 | M1 | The configuration file MUST use owner-only permissions where supported. |
| CFG-012 | M1 | CLI and Web writes MUST use optimistic concurrency through `configRevision` or ETag. |
| CFG-013 | M1 | Generic editing MUST NOT directly move a non-empty Vault. |
| CFG-014 | M1 | Vault relocation MUST use the dedicated migration operation `sorage vault move --to <path>`. |
| CFG-015 | M1 | Invalid changes MUST leave the previous valid configuration active. |
| CFG-016 | M1 | Web and CLI MUST use one shared Config Service, which the Web UI MUST use once it exists. |
| CFG-017 | M1 | Project registrations and directory bindings MUST be stored in SQLite, not `config.yaml`. |
| CFG-018 | M1 | `sorage config set` and `sorage config edit` MUST preserve existing comments and key order in `config.yaml`, verified by a round-trip diff over an annotated fixture. |
| CFG-019 | M1 | Once the daemon exists it MUST be the only writer of `config.yaml` while it is running and the CLI MUST route writes through `PUT /api/v1/config`; otherwise the CLI MUST write while holding `~/.sorage/run/config.lock`, and the ETag MUST be the content hash of the canonical file. |
| CFG-020 | M1 | Every configuration leaf except `installationId` MUST declare a normative fixed default in `schemas/config.schema.json`; `installationId` MUST be generated by `sorage init`, and `sorage config show --json` on a fresh installation MUST return the generated identifier together with exactly the declared defaults. |

## 5. Runtime and daemon

| ID | Milestone | Requirement |
|---|---|---|
| RUN-001 | M1 | Every writer MUST mutate state through the shared application layer, and concurrent mutations MUST be serialized by SQLite write transactions together with the committed filesystem intent log. |
| RUN-002 | M1 | Every Sorage process MUST drain outstanding `pending_fs_ops` intents at start before executing a command, and once the daemon exists it MUST be the only process that runs scheduled backup and garbage-collection jobs. |
| RUN-003 | M1 | The CLI MUST invoke application use cases in-process and MUST NOT require a running daemon for any domain operation. |
| RUN-004 | M1 | Bootstrap commands MAY operate without the daemon where documented. |
| RUN-005 | M2 | The daemon MUST provide health, readiness, and version endpoints. |
| RUN-006 | M2 | The CLI MUST provide `daemon start`, `daemon stop`, `daemon restart`, and `daemon status`. |
| RUN-007 | M3 | The macOS MVP MUST support a per-user LaunchAgent. |
| RUN-008 | M2 | A port change MUST require a controlled daemon restart. |
| RUN-009 | M1 | Every Sorage process, CLI and daemon alike, MUST write structured JSON logs to `~/.sorage/logs/sorage.log` under the configured rotation, MUST default the CLI level to `warn`, MAY redact paths, and MUST never log tokens. |
| RUN-010 | M1 | No telemetry MUST be sent by default. |
| RUN-011 | M3 | The canonical macOS LaunchAgent label MUST be `xyz.rootkernel.sorage` unless superseded by an accepted architecture decision. |
| RUN-012 | M2 | `sorage web` MUST start the daemon when it is not already running and MUST open the browser at a URL whose fragment carries a one-time secret. |
| RUN-013 | M2 | Daemon start MUST fail with `PORT_IN_USE` when the configured port is already bound, the daemon MUST write `~/.sorage/run/daemon.json` atomically at bind, and the CLI MUST discover the daemon through that file and confirm `installationId` through `GET /api/v1/health`. |
| RUN-014 | M1 | While `vault-move.lock` is held by a Vault move or, once restore exists, by `backup restore`, any other process attempting a domain mutation MUST fail with `SERVICE_PAUSED` and MUST return recovery guidance. |

## 6. Project registry

| ID | Milestone | Requirement |
|---|---|---|
| PRJ-001 | M1 | A Project MUST have stable UUID, unique slug, display name, and lifecycle state. |
| PRJ-002 | M1 | A Project MAY hold zero or more directory bindings for the current Installation, and a Project with zero bindings MUST NOT be selected as a recipient. |
| PRJ-003 | M1 | `sorage project add --name <name> [--slug <slug>] --dir <path>` MUST register Project name and first directory binding. |
| PRJ-004 | M1 | `sorage project` MUST provide `add`, `list`, `show`, `rename`, `bind`, `unbind`, `archive`, `unarchive`, and `resolve`. |
| PRJ-005 | M1 | Project slugs MUST be unique under case-insensitive comparison, and a colliding slug MUST fail with `PROJECT_SLUG_CONFLICT`. |
| PRJ-006 | M1 | Directory bindings MUST use normalized real paths. |
| PRJ-007 | M1 | Workspace resolution MUST select the longest matching binding directory, comparing against the git common directory when the working directory is inside a git repository, and MUST prefer a `git_repository` binding over a `directory` binding when both match. |
| PRJ-008 | M1 | Nested bindings MUST be permitted, resolution inside a nested binding MUST select the deepest matching binding, two matches of the same binding kind at the same depth MUST fail with `AMBIGUOUS_PROJECT` naming both Projects, and `--as <project-slug>` MUST disambiguate. |
| PRJ-009 | M1 | An archived Project MUST NOT receive new Handoffs. |
| PRJ-010 | M1 | `sorage project unbind <project> --dir <path>` MUST remove the local binding without destroying historical Project identity. |
| PRJ-011 | M1 | A Project referenced by Handoffs MUST NOT be physically deleted. |
| PRJ-012 | M1 | A recipient MUST be an active registered Project. |
| PRJ-013 | M1 | A sender MAY be a registered Project, unregistered Workspace, or User. |
| PRJ-014 | M1 | An unregistered Workspace identity MUST use a stable key derived from Installation identity and normalized path. |
| PRJ-015 | M1 | Original sender kind and path snapshot MUST remain historically accurate after later registration. |
| PRJ-016 | M1 | One Project MUST be able to hold many directory bindings on one Installation, constrained only by `UNIQUE(installationId, directory)`, and a bind of an already-bound directory or of a directory inside an already-bound repository MUST fail with `BINDING_DUPLICATE`. |
| PRJ-017 | M1 | A binding of kind `git_repository` MUST store the git common directory so that every worktree of a registered repository resolves to that Project, verified by `sorage project resolve --path <worktree-path>`. |
| PRJ-018 | M1 | `--as <project-slug>` MUST override working-directory resolution, MUST fail with `PROJECT_NOT_FOUND` for an unknown slug, and MUST fail with `PROJECT_UNBOUND` when the Project has no binding on this Installation. |
| PRJ-019 | M1 | The workspace root of a binding MUST be its stored directory for a `directory` binding and the main working tree for a `git_repository` binding, a send that resolves to an unregistered Workspace from a directory that is an ancestor of any workspace root, or that lies inside a workspace root yet resolves to no Project because it is a nested independent git repository, MUST fail with `SENDER_IDENTITY_DOWNGRADE` unless `--allow-unregistered` is supplied, and a directory inside any worktree of a bound repository MUST resolve to that Project without downgrading. |
| PRJ-020 | M1 | When a Workspace directory is later bound to a Project, that Project MUST inherit sender authority over Handoffs previously sent from the Workspace while `senderKind` and `senderPathSnapshot` remain unchanged. |
| PRJ-021 | M1 | An archived Project MUST retain `fetch`, `review set`, `review withdraw`, `accept`, and `decline` on Handoffs already in its inbox, and MUST reject new incoming Handoffs with `PROJECT_ARCHIVED`. |
| PRJ-022 | M1 | A Project with zero bindings MUST be flagged as unbound by `sorage project list` and `sorage doctor` and MUST fail as a recipient with `PROJECT_UNBOUND`, and a `sorage project unbind` that would leave a Project with open Handoffs — those in `awaiting_recipient` or `changes_requested` that are not deleted — unbound MUST require `--confirm` and MUST otherwise fail with `CONFIRMATION_REQUIRED`. |

## 7. Vault and Artifact

| ID | Milestone | Requirement |
|---|---|---|
| VLT-001 | M1 | The Vault path MUST be configurable, with default `~/.sorage/vault`. |
| VLT-002 | M1 | The Vault MUST contain a marker identifying its schema and Installation. |
| VLT-003 | M1 | A non-empty directory without a valid marker MUST NOT be silently adopted. |
| VLT-004 | M1 | The MVP MUST import regular files by copy only. |
| VLT-005 | M1 | Source files MUST NOT be moved or deleted. |
| VLT-006 | M1 | Directories MUST NOT be imported as Artifacts in the MVP. |
| VLT-007 | M1 | Every Artifact MUST record original name, stored name, MIME type, byte size, SHA-256, source path snapshot when available, and storage key. |
| VLT-008 | M1 | Managed Artifact files MUST be read-only after import where supported. |
| VLT-009 | M1 | Current Artifact metadata and local materialized path MUST be retrievable through `sorage fetch <id>`. |
| VLT-010 | M2 | The daemon MUST provide safe content streaming for Web preview and download. |
| VLT-011 | M1 | The MVP MUST retain only the current Artifact per live Handoff. |
| VLT-012 | M1 | Replacement MUST stage a new immutable Artifact before switching the Handoff reference. |
| VLT-013 | M1 | Old unreferenced files MUST be deleted after commit or by garbage collection. |
| VLT-014 | M1 | Crash recovery MUST tolerate orphaned staged and unreferenced files. |
| VLT-015 | M1 | Import MUST reject unreadable files, special files, and configured size violations. |
| VLT-016 | M1 | A file outside the resolved sender workspace MUST require the explicit `--allow-external-source` override and MUST otherwise fail with `SOURCE_OUTSIDE_WORKSPACE`. |
| VLT-017 | M1 | Vault and Project directory containment cycles MUST be rejected with `VAULT_CONTAINMENT`. |
| VLT-018 | M1 | Stored file names MUST be sanitized without changing recorded original names. |
| VLT-019 | M1 | A Vault marker whose `installationId` differs from the current Installation MUST block mutation with `VAULT_INTEGRITY_ERROR` and MUST be adoptable only through the audited `sorage backup restore --from <vault-path> --as-user --confirm`, which emits `VAULT_ADOPTED`; a marker `schemaVersion` newer than the running build MUST fail with `VAULT_SCHEMA_UNSUPPORTED`. |
| VLT-020 | M1 | Every Artifact MUST be stored at `artifacts/<handoff-id>/<artifact-id>/<stored-name>` relative to the Vault, and `storageKey` MUST be the sole authority for that path. |
| VLT-021 | M1 | Create, fan-out, revise, and deletion approval MUST commit their `pending_fs_ops` intents in the same transaction as the domain change, execute the intents afterwards, and clear them in a second transaction, and a read of a Handoff whose current Artifact is not yet materialized MUST return `ARTIFACT_MATERIALIZING`. |
| VLT-022 | M1 | Every Artifact write MUST follow the order write, `fsync(file)`, rename, `fsync(parent directory)`, and only then the commit that sets `materialized = 1`. |
| VLT-023 | M1 | A current Artifact whose recomputed SHA-256 does not match its recorded value MUST be handled as a Missing Artifact, blocking `revise`, `accept`, backup success, and deletion claims with `ARTIFACT_CORRUPTED`. |
| VLT-024 | M1 | Vault initialization MUST write `.gitattributes` containing `artifacts/** -text -diff`, `snapshots/** text eol=lf`, and `.sorage-vault.json text eol=lf`, MUST write `.gitignore` containing `staging/`, and Git initialization MUST re-assert both files idempotently once it exists. |

## 8. Handoff

| ID | Milestone | Requirement |
|---|---|---|
| HND-001 | M1 | A Handoff MUST have UUID, title, sender identity, exactly one recipient Project, Revision, Row Version, review state, and timestamps, and MUST reference a current Artifact unless it is a tombstone. |
| HND-002 | M1 | A title MUST be non-empty after trimming. |
| HND-003 | M1 | A new Handoff MUST start at Revision 1. |
| HND-004 | M1 | A new Handoff MUST start in `awaiting_recipient`. |
| HND-005 | M1 | A Handoff MUST have exactly one recipient. |
| HND-006 | M1 | A send with several recipients MUST create one independent Handoff per recipient. |
| HND-007 | M1 | Fan-out Handoffs MUST share a nullable Dispatch Group UUID. |
| HND-008 | M1 | Fan-out creation MUST be all-or-nothing. |
| HND-009 | M1 | Each fan-out Handoff MUST own an independent Artifact copy and lifecycle. |
| HND-010 | M1 | `sorage inbox` MUST list Handoffs for the resolved recipient Project. |
| HND-011 | M1 | `sorage outbox` MUST list Handoffs for the resolved sender Project or Workspace. |
| HND-012 | M1 | Only the first `fetch` or Artifact preview by the recipient Project or the User MUST record `ARTIFACT_FETCHED_FIRST_TIME` and set `firstFetchedAt`; a sender fetching its own Handoff MUST NOT set it or record an event, `get` MUST NOT record an event, and reads MUST NOT change review state. |
| HND-013 | M1 | The system MUST derive and expose the next actor. |
| HND-014 | M1 | Row Version MUST be enforced whenever an expected value is supplied, and MUST always be required and enforced for `accept` and `decline`. |
| HND-015 | M1 | A revise whose new content has the same SHA-256 as the current Artifact MUST fail with `NO_CONTENT_CHANGE` and MUST NOT change Revision unless it is invoked as `revise --no-change --reason <text>`, which MUST be valid only in `changes_requested` and MUST otherwise fail with `NO_REVIEW_NOTE`. |
| HND-016 | M1 | State-changing operations MUST emit metadata events in the same database transaction. |
| HND-017 | M1 | Events MUST NOT contain historical Artifact bytes. |
| HND-018 | M1 | A new Handoff MAY reference a previous Handoff through `--supersedes`, whose target MUST exist and MUST be in a terminal state, need not share the recipient, MAY be cited by every Handoff of one fan-out, and MAY be a tombstone, while a missing target MUST fail with `HANDOFF_NOT_FOUND` and a non-terminal target with `HANDOFF_NOT_TERMINAL`. |
| HND-019 | M1 | Dispatch Groups MUST NOT have shared review state, shared Revision, or bulk revise semantics. |
| HND-020 | M1 | Public Handoff representations MUST expose state, Revision, Row Version, next actor, participants, Artifact metadata, and retention flags, and a read by an actor that is neither the sender, the recipient, nor the User MUST fail with `HANDOFF_NOT_FOUND` so that existence is not disclosed. |
| HND-021 | M1 | `sorage withdraw <id>` MUST be permitted to the sender or the User only from `awaiting_recipient` while both `firstFetchedAt` and `reviewEngagedAt` are null, setting `reviewState` to `withdrawn`, and MUST otherwise fail with `HANDOFF_ALREADY_FETCHED` when the recipient has fetched or reviewed the Handoff, `REVIEW_NOTE_PRESENT` when a Review Note exists, or `HANDOFF_TERMINAL` when the Handoff is already terminal. |
| HND-022 | M1 | The recipient MUST be able to end a Handoff through `sorage decline <id> --reason <text> --expected-row-version <n>` from `awaiting_recipient` or `changes_requested`, setting `reviewState` to `declined` and recording `declineReason` and `declinedAt`. |
| HND-023 | M1 | `sorage send --body <text>` MUST materialize the supplied text as a Markdown Artifact so that every non-tombstone Handoff still has exactly one current Artifact. |
| HND-024 | M1 | Public Handoff representations MUST expose `firstFetchedAt`. |
| HND-025 | M1 | Row Version MUST increment on every state-changing operation and MUST NOT increment on reads, `fetch`, preview, or their events, and an expected Row Version MUST be the value the client currently holds. |
| HND-026 | M1 | When the global configuration key `handoff.inboxMarker`, which defaults to `false` and has no per-Project override, is enabled, every Handoff creation and every state change MUST rewrite the derived inbox marker `.sorage/INBOX.md` under each recipient binding directory. The marker MUST never be treated as authoritative. Independently of `handoff.inboxMarker`, the `use-sorage` skill MUST instruct agents performing requested Sorage project setup to ensure `.sorage/` is ignored in the Project's `.gitignore` by default, preserving existing entries and avoiding duplicates; this setup policy does not require automatic CLI edits. |

## 9. Review and revision

| ID | Milestone | Requirement |
|---|---|---|
| REV-001 | M1 | A Handoff MUST have at most one current Review Note. |
| REV-002 | M1 | Only the recipient Project or User MAY create or update the Review Note. |
| REV-003 | M1 | A recipient Project MUST NOT remove the Review Note by any path other than `sorage review withdraw <id>`. |
| REV-004 | M1 | A sender MUST NOT create a Review Note on its own Handoff. |
| REV-005 | M1 | A Review Note MUST record its target Revision. |
| REV-006 | M1 | Note creation or update MUST fail with `REVISION_CONFLICT` when the target Revision is stale. |
| REV-007 | M1 | Creating a Review Note MUST set state to `changes_requested`. |
| REV-008 | M1 | Sender revision MUST import a valid changed Artifact before incrementing Revision. |
| REV-009 | M1 | If a Review Note exists, revision MUST remove it in the same logical operation and MUST emit `REVIEW_NOTE_RESOLVED` in that transaction. |
| REV-010 | M1 | The sender MUST NOT remove a Review Note except through a successful content revision or the bounded no-change resolution of REV-017. |
| REV-011 | M1 | The sender or the User MAY revise in `awaiting_recipient` as a proactive correction, subject to Row Version. |
| REV-012 | M1 | Proactive correction MUST remain `awaiting_recipient`. |
| REV-013 | M1 | Revision resolving a Note MUST return state to `awaiting_recipient`. |
| REV-014 | M1 | Sorage MUST NOT provide native historical Review Note versions. |
| REV-015 | M1 | The User MUST be able to remove the current Review Note through `sorage review remove <id> --as-user --confirm`, which MUST emit `REVIEW_NOTE_REMOVED`, MUST return the Handoff to `awaiting_recipient`, and MUST be audited. |
| REV-016 | M1 | The recipient Project MUST be able to withdraw the current Review Note, whichever actor authored it, through `sorage review withdraw <id>`, returning the Handoff to `awaiting_recipient` with Revision unchanged and emitting `REVIEW_NOTE_WITHDRAWN`; the User removes a Note only through REV-015. |
| REV-017 | M1 | The sender or the User MUST be able to resolve a Review Note without a content change through `sorage revise <id> --no-change --reason <text>`, returning the Handoff to `awaiting_recipient` with Revision unchanged and emitting `HANDOFF_NO_CHANGE_RESOLVED`, and a second consecutive no-change resolution MUST fail with `NO_CHANGE_LIMIT`. |

## 10. Accept, retention, and deletion

| ID | Milestone | Requirement |
|---|---|---|
| LIFE-001 | M1 | Only the recipient Project or User MAY accept a Handoff. |
| LIFE-002 | M1 | Accept MUST identify the exact current Revision through `--expected-revision <n>` and MUST fail with `ARTIFACT_MATERIALIZING` when the current Artifact is not yet materialized. |
| LIFE-003 | M1 | Accept MUST fail with `REVIEW_NOTE_PRESENT` while a Review Note exists. |
| LIFE-004 | M1 | Accept MUST set `reviewState` to `accepted` and record `acceptedRevision` and `acceptedAt`. |
| LIFE-005 | M1 | A Handoff in a terminal state MUST be immutable in Artifact content, Revision, and Review Note, while retention changes and approved deletion remain permitted and MUST increment Row Version. |
| LIFE-006 | M1 | Any further change after a terminal state MUST use a new Handoff, normally linked through `supersedesHandoffId`. |
| LIFE-007 | M1 | Pinning MUST be independent of review state. |
| LIFE-008 | M1 | Archiving MUST be allowed only for a Handoff in a terminal state, and any other attempt MUST fail with `HANDOFF_ARCHIVE_INVALID`. |
| LIFE-009 | M1 | Archived Handoffs MUST remain listable through `--include-archived` and restorable through `sorage unarchive <id>`. |
| LIFE-010 | M1 | Projects, Workspaces, and User MAY request deletion of a Handoff in any state that is not already a tombstone. |
| LIFE-011 | M1 | Only the User MAY approve or reject deletion. |
| LIFE-012 | M1 | Approving deletion of a pinned Handoff MUST require the distinct `--confirm-pinned <id>` argument in addition to `--confirm`, and MUST otherwise fail with `PINNED_DELETE_CONFIRMATION`. |
| LIFE-013 | M1 | Approved deletion MUST remove current Artifact and current Review Note. |
| LIFE-014 | M1 | Approved deletion MUST leave a minimal tombstone and event. |
| LIFE-015 | M1 | Deletion MUST NOT claim to purge prior Git history, and every deletion approval MUST present the warning that prior Git commits may retain earlier content. |
| LIFE-016 | M1 | Rejected deletion MUST retain the Handoff and record the decision. |
| LIFE-017 | M1 | A Handoff in a terminal state that is not a tombstone MUST reject `revise`, `review set`, `review withdraw`, `review remove`, `accept`, `decline`, and `withdraw` with `HANDOFF_TERMINAL`, and MUST continue to allow pin, unpin, archive, unarchive, and the deletion request, approve, and reject operations. |
| LIFE-018 | M1 | Deletion approval MUST require a terminal review state and MUST otherwise fail with `HANDOFF_NOT_TERMINAL`, so that every tombstone is terminal, and a tombstone MUST reject `fetch`, `revise`, `review set`, `review withdraw`, `review remove`, `accept`, `decline`, `withdraw`, and `delete request` with `HANDOFF_DELETED` while `get`, listing, pin, unpin, archive, and unarchive remain allowed. |

## 11. CLI

| ID | Milestone | Requirement |
|---|---|---|
| CLI-001 | M1 | All domain commands MUST support machine-readable JSON output. |
| CLI-002 | M1 | JSON mode MUST emit only JSON to standard output. |
| CLI-003 | M1 | Human diagnostics MUST use standard error in JSON mode. |
| CLI-004 | M1 | Errors MUST have stable symbolic codes. |
| CLI-005 | M1 | Exit codes MUST be documented and stable within the MVP major version. |
| CLI-006 | M3 | Commands MUST cover initialization, daemon, config, Project, Handoff, review, revision, acceptance, retention, deletion, Vault, and backup. |
| CLI-007 | M1 | `send` MUST support one or more `--to` options. |
| CLI-008 | M1 | `send` MUST return every generated Handoff UUID. |
| CLI-009 | M1 | `inbox` and `outbox` MUST support the documented filters and cursor pagination, and MUST reject a cursor that does not match its filters with `CURSOR_INVALID`. |
| CLI-010 | M1 | `fetch` MUST return current Artifact metadata and local path. |
| CLI-011 | M1 | `review set` MUST accept inline text or a file. |
| CLI-012 | M1 | `revise` MUST accept either a source path through `--file <path>` or a no-change resolution through `--no-change --reason <text>`. |
| CLI-013 | M1 | `accept` MUST require both `--expected-revision <n>` and `--expected-row-version <n>`. |
| CLI-014 | M1 | Destructive User operations MUST require interactive confirmation or an explicit confirmation flag. |
| CLI-015 | M1 | Shell completion generation MUST be available. |
| CLI-016 | M1 | Help text MUST show the next valid command after common errors. |
| CLI-017 | M1 | Commands MUST resolve the acting identity from the current working directory as provenance rather than authorization, unless `--as <project-slug>` or `--as-user` is supplied. |
| CLI-018 | M1 | The CLI MUST perform every mutation through the shared application layer and MUST NOT execute raw SQL or write managed Vault paths directly. |
| CLI-019 | M1 | The explicit `--as-user` flag MUST be required by `review remove`, `pin`, `unpin`, `archive`, `unarchive`, `delete approve`, `delete reject`, `project archive`, `project unarchive`, `config set`, `config edit`, `vault move`, `backup enable`, `backup disable`, `backup enable-push`, `backup disable-push`, `backup restore`, `token rotate`, and `uninstall`, MUST record `actorKind = user`, and MUST fail with `USER_CONTEXT_REQUIRED` when it is absent, while every other command MUST remain executable in any resolved actor context. |
| CLI-020 | M1 | The CLI MUST support `--as <project-slug>` on every actor-resolving command, an optional `--expected-row-version <n>` on every mutating command, and `inbox --wait`, which MUST poll SQLite every `--interval` seconds defaulting to 2 until a new inbox item for the resolved actor appears or `--timeout` seconds defaulting to 300 elapse, then exit 0 with an empty list and `meta.timedOut: true`. |
| CLI-021 | M1 | `send` and `revise` MUST accept `--idempotency-key <uuid>`, MUST return the original result for a replay with the same key and request hash, and MUST fail with `IDEMPOTENCY_CONFLICT` for a different request under the same key. |

## 12. Local HTTP API

| ID | Milestone | Requirement |
|---|---|---|
| API-001 | M2 | The API MUST use versioned `/api/v1` prefix. |
| API-002 | M2 | The API MUST use JSON for metadata operations. |
| API-003 | M2 | Browser uploads MUST use streaming multipart or equivalent. |
| API-004 | M2 | Path-based imports MUST be accepted only from authenticated local CLI context. |
| API-005 | M2 | Mutating requests MUST carry Row Version or `If-Match` where the operation defines one, and MUST honour `Idempotency-Key` when it is present. |
| API-006 | M2 | Error bodies MUST contain symbolic code, message, details, and recovery fields when applicable. |
| API-007 | M2 | The API MUST expose Project, Handoff, Review Note, lifecycle, config, backup, health, diagnostics, and Artifact operations. |
| API-008 | M2 | The API MUST enforce the same application use cases as CLI and Web. |
| API-009 | M2 | The API MUST NOT expose arbitrary filesystem browsing. |
| API-010 | M2 | Preview endpoints MUST enforce ownership and safe MIME handling. |
| API-011 | M2 | The mapping from symbolic error code to HTTP status MUST be published in `interfaces-and-operations.md` and MUST be verified by `make test-contract`. |
| API-012 | M2 | Endpoints that accept `Idempotency-Key: <uuid>` MUST evaluate replay detection before the Row Version check. |

## 13. Web UI

| ID | Milestone | Requirement |
|---|---|---|
| WEB-001 | M2 | The daemon MUST serve the Web UI locally. |
| WEB-002 | M2 | Dashboard MUST show awaiting recipient, changes requested, accepted, declined, withdrawn, pinned, archived, deleted, deletion requested, recent updates, and, once Git backup exists, backup health. |
| WEB-003 | M2 | Handoff lists MUST support sender, recipient, state, retention, and date filters. |
| WEB-004 | M2 | Detail MUST show UUID, participants, Revision, Row Version, state, next actor, Artifact, Review Note, and timeline. |
| WEB-005 | M2 | Web MUST provide Markdown and safe text preview. |
| WEB-006 | M2 | Unsupported binary formats MUST show metadata and download or reveal actions without unsafe inline rendering. |
| WEB-007 | M2 | User MUST be able to create Handoffs through upload. |
| WEB-008 | M2 | Multi-recipient creation MUST create independent Handoffs and display every UUID. |
| WEB-009 | M2 | Web MUST provide Project registration and management. |
| WEB-010 | M2 | Unregistered Workspaces MUST be shown separately. |
| WEB-011 | M2 | Web MUST provide the User-admin actions review remove, accept, decline, pin, unpin, archive, unarchive, and deletion decisions. |
| WEB-012 | M2 | Settings MUST show canonical config file path. |
| WEB-013 | M2 | Settings MUST provide typed configuration forms. |
| WEB-014 | M2 | Settings MUST provide a read-only view of the canonical YAML file, and the Web UI MUST NOT provide a YAML editor. |
| WEB-015 | M2 | Saves MUST validate schema and detect ETag conflict. |
| WEB-016 | Deferred | A dedicated Web Vault relocation screen MAY be added after the MVP, and within the MVP relocation MUST use `sorage vault move --to <path>`. |
| WEB-017 | M2 | The MVP Web UI MUST NOT provide an embedded Artifact editor. |
| WEB-018 | M2 | Web SHOULD meet basic keyboard, semantic labeling, focus, contrast, and error-announcement requirements, checked by axe-core in `make test-e2e` as engineering practice rather than as a release gate. |

## 14. Git backup

| ID | Milestone | Requirement |
|---|---|---|
| BKP-001 | M3 | Vault Git integration MUST be optional and recommended during init. |
| BKP-002 | M3 | Daily backup MUST be independently enabled or disabled. |
| BKP-003 | M3 | Backup MUST export a consistent current-state snapshot before Git operations, and while `gitBackup.snapshot.redactWorkspacePaths`, which defaults to `true`, is enabled the export MUST redact `senderPathSnapshot`, binding directories, and every path field inside event `metadataJson`. |
| BKP-004 | M3 | SQLite, WAL, SHM, logs, tokens, and credentials MUST NOT be committed. |
| BKP-005 | M3 | Backup MUST include current Artifacts, the Vault marker, `.gitattributes`, and the current metadata snapshots including `snapshots/events.jsonl`. |
| BKP-006 | M3 | Backup MUST run under one backup lock. |
| BKP-007 | M3 | Snapshot export MUST use a consistent SQLite read transaction. |
| BKP-008 | M3 | Snapshot writes MUST use temporary files and atomic rename. |
| BKP-009 | M3 | Backup MUST commit only when managed content changed. |
| BKP-010 | M3 | Commit messages MUST use a configurable template. |
| BKP-011 | M3 | Remote push MUST be optional. |
| BKP-012 | M3 | Git credentials MUST use external Git and SSH credential mechanisms. |
| BKP-013 | M3 | Sorage MUST NOT force push, rebase, merge, or automatically resolve conflicts. |
| BKP-014 | M3 | Non-fast-forward push MUST fail safely with `GIT_BACKUP_CONFLICT` and require manual intervention. |
| BKP-015 | M3 | A missed daily schedule MAY run once after daemon startup when catch-up is enabled. |
| BKP-016 | M3 | `sorage backup status` MUST expose last attempt, success, commit, push, and failure. |
| BKP-017 | M3 | `sorage backup run`, `status`, `enable`, `disable`, `verify`, and `restore` MUST exist. |
| BKP-018 | M3 | Web MUST show whether protection is local-only or includes remote. |
| BKP-019 | M3 | Deletion messaging MUST state that Git history may retain deleted content. |
| BKP-020 | M3 | Git history purge MUST NOT be implemented in the MVP. |
| BKP-021 | M3 | `sorage backup restore --from <vault-path> --dry-run --as-user` MUST perform the complete validation without writing, while `sorage backup restore --from <vault-path> --as-user --confirm` MUST rebuild Projects, Handoffs, Review Notes, and lifecycle state into an empty installation, inherit `installationId` from the Vault marker, regenerate the API token, verify every checksum, and fail with `RESTORE_TARGET_NOT_EMPTY` against a populated installation. |
| BKP-022 | M3 | Git initialization of the Vault MUST set `core.autocrlf=false` in the Vault repository, and `sorage backup verify` MUST check that setting together with the `.gitattributes` and `.gitignore` required by VLT-024. |
| BKP-023 | M3 | Backup MUST export the append-only event ledger to `snapshots/events.jsonl`. |
| BKP-024 | M3 | Snapshot export MUST be deterministic through stable sort keys, LF line endings, and no wall-clock timestamps, and the decision to commit MUST use `git diff --cached --quiet` over the managed pathspecs. |
| BKP-025 | M3 | Every Git invocation MUST run in batch mode with `GIT_TERMINAL_PROMPT=0` and SSH `BatchMode=yes` under a 60-second timeout, MUST fail with `GIT_AUTH_REQUIRED` when credentials are missing, push MUST use `git push --atomic`, and push MUST be controlled by `sorage backup enable-push`/`disable-push` and the matching `POST /api/v1/backup/enable-push` and `POST /api/v1/backup/disable-push` endpoints. |
| BKP-026 | M3 | The scheduler MUST evaluate the next due run on a 60-second tick, MUST run a scheduled local time that does not exist on a DST transition day at the next valid instant, and MUST run a local time that occurs twice at its first occurrence. |

## 15. Security and reliability

| ID | Milestone | Requirement |
|---|---|---|
| SEC-001 | M2 | Daemon MUST reject non-loopback bind addresses. |
| SEC-002 | M2 | CLI API access MUST use an Installation-local bearer token stored outside `config.yaml` with owner-only permissions. |
| SEC-003 | M2 | Web mutations MUST be authenticated by the session bearer token in the `Authorization` header and MUST NOT rely on any ambient credential. |
| SEC-004 | M1 | External commands MUST use argument-array execution, never constructed shell strings. |
| SEC-005 | M1 | User-controlled names and paths MUST NOT be interpolated into shell commands. |
| SEC-006 | M1 | Path validation MUST resolve symlinks and prevent managed-path escape. |
| SEC-007 | M1 | Special files, sockets, devices, and named pipes MUST be rejected as Artifacts. |
| SEC-008 | M1 | Database mutations MUST use explicit transactions. |
| SEC-009 | M1 | Multi-step file and database operations MUST be crash-recoverable. |
| SEC-010 | M1 | Errors and logs MUST NOT expose bearer tokens or credentials. |
| SEC-011 | M1 | Logs SHOULD support path redaction while retaining stable IDs. |
| SEC-012 | M1 | Domain mutations MUST create append-only metadata events. |
| SEC-013 | M1 | The product MUST NOT claim isolation between AI processes running as the same operating-system user. |
| SEC-014 | M1 | Restore and integrity checks MUST verify SHA-256, and once the daemon exists a periodic daemon sweep bounded to 64 MiB per garbage-collection tick MUST verify current Artifact checksums. |
| SEC-015 | M2 | Daemon MUST gracefully stop accepting mutations before storage shutdown. |
| SEC-016 | M1 | Configuration and schema migration failure MUST preserve the last known valid state. |
| SEC-017 | M2 | The daemon MUST validate the `Host` header against the allowlist `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` on every request before routing and MUST reject every other value with `HOST_NOT_ALLOWED`. |
| SEC-018 | M2 | Every daemon response MUST carry `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. |
| SEC-019 | M2 | Sorage MUST NOT use cookies, and browser authentication MUST use a one-time secret delivered in the URL fragment and exchanged at `POST /api/v1/session` for a session token sent in `Authorization: Bearer`, and a request carrying no `Authorization` header or presenting a refused one-time secret MUST fail with `UNAUTHENTICATED`. |
| SEC-020 | M2 | The API token MUST be at least 32 random bytes encoded base64url, stored with `0600` permissions at `~/.sorage/state/api-token`, compared in constant time, replaceable through `sorage token rotate --as-user`, and a presented but invalid or rotated token MUST be rejected with `TOKEN_INVALID`. |
| SEC-021 | M1 | The permission matrix and the `--as-user` help text MUST state that User-admin rows express workflow intent and that any process able to read the API token or run the CLI as this operating-system user can assert User context. |

## 16. Non-functional requirements

| ID | Milestone | Requirement |
|---|---|---|
| NFR-001 | M1 | TypeScript strict mode MUST be enabled. |
| NFR-002 | M1 | Domain logic MUST NOT depend directly on Web, CLI, SQLite, YAML, Git, or macOS APIs. |
| NFR-003 | M1 | Public JSON contracts MUST be versioned and contract-tested. |
| NFR-004 | M3 | Metadata operations SHOULD feel immediate for at least 10,000 Handoffs on a normal development machine. |
| NFR-005 | M1 | Large Artifact copies MUST stream with bounded memory. |
| NFR-006 | M1 | Pagination MUST be deterministic. |
| NFR-007 | M1 | Timestamps MUST be stored in UTC and rendered in the configured or system timezone. |
| NFR-008 | M1 | UUIDs MUST use a standard random UUID format. |
| NFR-009 | M1 | Database MUST use migrations and schema version tracking, schema migration MUST run at process start while holding `~/.sorage/run/migration.lock` for the whole run, that lock MUST be treated as stale only when the recorded pid is dead, and a process that waited for it MUST re-check `schema_migrations` after acquiring it. |
| NFR-010 | M1 | User-visible failures MUST include recovery guidance when available. |
| NFR-011 | M1 | Web and CLI MUST use one shared protocol model. |
| NFR-012 | M1 | Release builds MUST be reproducible from locked dependencies and a pinned toolchain. |
| NFR-013 | M1 | Build, test, and package MUST run from the repository root through `make`. |
| NFR-014 | M1 | Domain and application code MUST NOT import adapter packages or any ecosystem tool, enforced by a lint rule executed in `make test-prepare`. |
| NFR-015 | M1 | Markdown in this repository MUST satisfy the Aquarium documentation rules, which forbid hard-wrapped prose and require every relative link to resolve. |
| NFR-016 | M1 | `make` MUST provide at least the targets `test-prepare`, `test-unit`, `test-int`, `test-contract`, `test-e2e`, `test`, `build`, and `package`, with `make test` as the single verification gate. |
| NFR-017 | M1 | The Bun version MUST be pinned in the repository and the build MUST fail on a version mismatch. |

## 17. Milestone summary

| Milestone | Requirement scope | Release gate |
|---|---|---|
| M1 | GEN-001..004, GEN-007..014; INIT-001..003, INIT-005, INIT-006, INIT-011..015, INIT-017; CFG-001..020; RUN-001..004, RUN-009, RUN-010, RUN-014; PRJ-001..022; VLT-001..009, VLT-011..024; HND-001..026; REV-001..017; LIFE-001..018; CLI-001..005, CLI-007..021; SEC-004..014, SEC-016, SEC-021; NFR-001..003, NFR-005..017 | M1 CLI release |
| M2 | GEN-005, GEN-006; RUN-005, RUN-006, RUN-008, RUN-012, RUN-013; VLT-010; API-001..012; WEB-001..015, WEB-017, WEB-018; SEC-001..003, SEC-015, SEC-017..020 | M2 daemon and Web release |
| M3 | INIT-004, INIT-007..010, INIT-016; RUN-007, RUN-011; CLI-006; BKP-001..026; NFR-004 | M3 MVP release |
| Deferred | WEB-016 | None; revisited after the MVP |

Release gates close at the end of EPIC-006 for M1, EPIC-007 for M2, and EPIC-009 for M3, as recorded in `../roadmap/README.md`.

The MVP is complete only when the M3 MVP release gate passes with every M1, M2, and M3 requirement satisfied.
