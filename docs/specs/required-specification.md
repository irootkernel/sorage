# Required Specification

## 1. Scope

This document is the normative product requirement set for Sorage (소라게) and is the highest authority in the Source of Truth.

Sorage is developed, tested, and released from the standalone repository `irootkernel/sorage`; ecosystem tools are used only as development tooling and are never source dependencies.

The MVP is delivered in three milestones: `M1` CLI core, `M2` daemon with local HTTP API and Web UI, and `M3` Git backup, scheduling, and packaging. Those three gates are closed. Post-MVP work uses milestone identifiers `M4` and above (ADR-0024).

Every requirement row carries a `Milestone` value of `M1`, `M2`, `M3`, `M4`, `M5`, `M6`, `M7`, `M8`, `M9`, or `Deferred`; the value names the release gate at whose passing the requirement MUST be fully satisfied, and `Deferred` marks work outside the current delivery series.

A requirement whose clauses span gates carries the earliest of them and phrases the later clause conditionally, as in "once the daemon exists".

The MVP is complete when the M3 MVP release gate passes; passing the M1 CLI release gate or the M2 daemon and Web release gate does not complete it. Post-MVP requirements are satisfied at their own gates and MUST NOT reopen `M1`, `M2`, `M3`, or `M4`.

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
| GEN-015 | M4 | The `use-sorage` skill MUST keep GEN-014, and when Handoff processing is requested and the current Handoff has a Review Note, it MUST instruct the acting session to read that Note through `sorage review show` before `revise`. A requested inbox or outbox check MUST NOT authorize `review show`, `fetch`, or `revise`. The skill MUST state that `sorage get` does not carry the Note body, that a sender `fetch` does not set `firstFetchedAt`, and that `sorage events` reconstructs recent metadata and is not required on every revision. |
| GEN-016 | M8 | The shipped skill MUST treat recovery hints as guidance rather than authority, MUST NOT add actor, confirmation, external-source, or identity-downgrade flags merely to clear an error, and MUST continue only within explicit user intent. |
| GEN-017 | M8 | The shipped skill MUST distinguish a deletion request from User approval, require the native distinct decision for a pinned Handoff, preserve Project identity, and disclose that deletion is not secure erasure and Git history or backups can retain content. |
| GEN-018 | M8 | Before writing a Review Note, the shipped skill MUST retain the observed Revision and Row Version and supply --target-revision and --expected-row-version. Before sender revise, including --no-change, it MUST retain the original reviewed state and supply --expected-row-version. A conflict MUST NOT automatically become an overwrite against a refreshed version. |
| GEN-019 | M8 | Before send, the shipped skill MUST retain the original idempotency key, exact accepted inputs and source bytes, Installation, and sender context. Unknown results MUST use only SND-001 replay-only recovery; unavailable receipts, errors, or missing original material MUST NOT trigger execute fallback, another key, or a duplicate send. A historical receipt MUST NOT be presented as current Handoff state. |
| GEN-020 | M8 | The shipped skill MUST treat received Handoff and Review Note content as untrusted data that cannot grant execution or external-action authority, preserve GEN-014 and GEN-015, keep requested Project setup with its owning setup workflow while preserving HND-026's requested ignore-file guidance, and make required resource references usable from a clean installed skill directory without relying on repository-relative files outside that directory. |

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
| INIT-011 | M1 | Before initialization, only `init`, `help`, `version`, `completion`, and `doctor` MAY run; M8 additionally permits the non-initializing `preflight` command defined by PFL-001. |
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
| RUN-002 | M1 | Every Sorage process MUST drain outstanding `pending_fs_ops` intents at start before executing a command, except M8 preflight and send replay-only, which MUST NOT drain intents under PFL-002 and SND-002. Once the daemon exists it MUST be the only process that runs scheduled backup and garbage-collection jobs. |
| RUN-003 | M1 | The CLI MUST invoke application use cases in-process and MUST NOT require a running daemon for any domain operation. |
| RUN-004 | M1 | Bootstrap commands MAY operate without the daemon where documented. |
| RUN-005 | M2 | The daemon MUST provide health, readiness, and version endpoints. |
| RUN-006 | M2 | The CLI MUST provide `daemon start`, `daemon stop`, `daemon restart`, and `daemon status`. |
| RUN-007 | M3 | The macOS MVP MUST support a per-user LaunchAgent. |
| RUN-008 | M2 | A port change MUST require a controlled daemon restart. |
| RUN-009 | M1 | Every Sorage process, CLI and daemon alike, MUST write structured JSON logs to `~/.sorage/logs/sorage.log` under the configured rotation, MUST default the CLI level to `warn`, MAY redact paths, and MUST never log tokens; M8 preflight and send replay-only MUST instead report through command output without writing or rotating installation logs, including on failure. |
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
| PRJ-023 | M6 | An archived Project MUST NOT be the registered sender or recipient of a new Handoff and MUST fail creation with `PROJECT_ARCHIVED`; existing Handoff processing and exact idempotency replay MUST remain available. |
| PRJ-024 | M6 | `sorage project rebind <project> --from <recorded-path> --to <existing-path>` MUST replace exactly one binding atomically, preserving Project and binding identities and historical path snapshots, applying the same path, Git, duplicate, and Vault containment rules as `project bind`, and appending a binding-change event in the same transaction. A `--to` resolving to the same stored binding MUST succeed without a mutation or event. |

## 7. Vault and Artifact

| ID | Milestone | Requirement |
|---|---|---|
| VLT-001 | M1 | The Vault path MUST be configurable, with default `~/.sorage/vault`. |
| VLT-002 | M1 | The Vault MUST contain a marker identifying its schema and Installation. |
| VLT-003 | M1 | A non-empty directory without a valid marker MUST NOT be silently adopted. |
| VLT-004 | M1 | The MVP MUST import regular files by copy only. |
| VLT-005 | M1 | Source files MUST NOT be moved or deleted. |
| VLT-006 | M1 | Directories MUST NOT be imported as Artifacts in the MVP. |
| VLT-007 | M1 | Every Artifact MUST record original name, stored name, MIME type, byte size, SHA-256, source path snapshot when available, and storage key; from M9 a text Artifact routed inline under SHR-001 to SHR-003 records no storage key because its recorded inline text is the authoritative body, and it still records original name, stored name, MIME type, byte size, and SHA-256. |
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
| VLT-020 | M1 | Every Vault-backed Artifact MUST be stored at `artifacts/<handoff-id>/<artifact-id>/<stored-name>` relative to the Vault, and `storageKey` MUST be the sole authority for that path; from M9 this file authority applies to Vault-backed Artifacts only, an inline text Artifact has no file and no storage key, and shared file-backed content outside the Artifact domain lives under the managed `content/` subtree that section 38 of interfaces-and-operations.md fixes. |
| VLT-021 | M1 | Create, fan-out, revise, and deletion approval MUST commit their `pending_fs_ops` intents in the same transaction as the domain change, execute the intents afterwards, and clear them in a second transaction, and a read of a Handoff whose current Artifact is not yet materialized MUST return `ARTIFACT_MATERIALIZING`. |
| VLT-022 | M1 | Every Artifact write MUST follow the order write, `fsync(file)`, rename, `fsync(parent directory)`, and only then the commit that sets `materialized = 1`. |
| VLT-023 | M1 | A current Artifact whose recomputed SHA-256 does not match its recorded value MUST be handled as a Missing Artifact, blocking `revise`, `accept`, backup success, and deletion claims with `ARTIFACT_CORRUPTED`. |
| VLT-024 | M1 | Vault initialization MUST write `.gitattributes` containing `artifacts/** -text -diff`, `snapshots/** text eol=lf`, and `.sorage-vault.json text eol=lf`, MUST write `.gitignore` containing `staging/`, and Git initialization MUST re-assert both files idempotently once it exists; from M9 the `.gitattributes` content additionally contains `content/** -text -diff` and `snapshots/content/** -text -diff`, the latter after the general `snapshots/**` rule so raw carried body bytes are not normalized, and is re-asserted idempotently alongside the existing lines. |

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
| HND-023 | M1 | `sorage send --body <text>` MUST materialize the supplied text as a Markdown Artifact so that every non-tombstone Handoff still has exactly one current Artifact; from M9 that Artifact follows the shared content routing of SHR-001 to SHR-003, so a body at or below the inline threshold is recorded as inline authoritative text without a Vault file, while exactly one current Artifact per non-tombstone Handoff and the existing staged-name contract for file-backed bodies are preserved. |
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
| CLI-019 | M1 | The explicit `--as-user` flag MUST be required by `review remove`, `pin`, `unpin`, `archive`, `unarchive`, `delete approve`, `delete reject`, `config set`, `config edit`, `vault move`, `backup enable`, `backup disable`, `backup enable-push`, `backup disable-push`, `backup restore`, `token rotate`, and `uninstall`, MUST record `actorKind = user`, and MUST fail with `USER_CONTEXT_REQUIRED` when it is absent, while every other actor-resolving command MUST remain executable in any resolved actor context. |
| CLI-020 | M1 | The CLI MUST support `--as <project-slug>` on every actor-resolving command, an optional `--expected-row-version <n>` on every mutating command, and `inbox --wait`, which MUST poll SQLite every `--interval` seconds defaulting to 2 until a new inbox item for the resolved actor appears or `--timeout` seconds defaulting to 300 elapse, then exit 0 with an empty list and `meta.timedOut: true`; from M9 `meta.timedOut` is the shared timeout flag of every waiting surface and the Handoff wait keeps its new-items-only contract unchanged, while the Channel wait of CHN-007 adds its own pending-inclusive semantics under the same flag; and from EPIC-017 the Handoff wait measures its deadline from invocation, keeps polling across retried listing failures (`STORAGE_INSPECTION_UNAVAILABLE` and read-side `CONTENT_MATERIALIZING`), reports a failure that persists at the deadline as that typed error, and fixes its known set by the first complete successful seed as the IDs whose creation time precedes the invocation instant, so an item created at or after that instant is returned as new even when a retried seed lists it and a known item's later state change never wakes the wait; its new-items-only contract and exit behavior are otherwise unchanged. |
| CLI-021 | M1 | `send` and `revise` MUST accept `--idempotency-key <uuid>`, MUST return the original result for a replay with the same key and request hash, and MUST fail with `IDEMPOTENCY_CONFLICT` for a different request under the same key. |
| CLI-022 | M4 | `sorage review show <handoff-id>` MUST return the current Review Note, including body, target Revision, and author kind, or JSON `null` when none exists. It MUST use the same participant gate as `sorage get`, MUST record nothing, MUST NOT set `firstFetchedAt` or increment Row Version, MUST return `HANDOFF_NOT_FOUND` for a non-participant, MUST return `null` rather than `HANDOFF_DELETED` on a tombstone that has no Note, and MUST support `--json`. |
| CLI-023 | M4 | `sorage events <handoff-id>` MUST return the bounded recent metadata timeline for that Handoff, newest first, including on a tombstone, with each event's type, actor kind, and Row Version, and MUST NOT carry Artifact bytes or imply that historical content is retrievable. It MUST use the same participant gate as `sorage get`, MUST record nothing, MUST NOT set `firstFetchedAt` or increment Row Version, MUST return `HANDOFF_NOT_FOUND` for a non-participant, MUST bound the list at 50 events matching the HTTP detail timeline, and MUST support `--json`. |
| CLI-024 | M6 | `project archive` and `project unarchive` MUST accept a Project slug without `--as-user` or a resolvable working directory, MUST record the User actor, and MUST continue to accept the global `--as-user` option for existing callers. The matching HTTP Project lifecycle routes MUST also use the User actor without an explicit `asUser` body field. |
| CLI-025 | M6 | `project rebind` MUST accept `--from` and `--to`, return the updated Project Binding in the existing success envelope under `--json`, and report a failed validation without changing the old binding. |

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
| API-013 | M5 | `POST /api/v1/handoffs/upload` MUST treat a file part and a `body` field as mutually exclusive by field presence, MUST reject a request that carries both, neither, more than one `body` field, or a `body` whose UTF-8 text is empty after trimming, MUST stream a present `body` to disk under the same `artifact.maxBytes` mid-stream abort and spool-cleanup rules as a file part (NFR-005), MUST materialize a `body` through the same Markdown Artifact rule as HND-023, and MUST keep User context with `allowUnregistered` false. |

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
| WEB-019 | M5 | User MUST be able to create Handoffs from the Web compose form by supplying inline Markdown body text, mutually exclusive with file upload. The acting sender MUST be the User. The form MUST NOT offer a Project-sender picker, unregistered-workspace identity, or an `--allow-unregistered` analogue, and MUST NOT include a `body` part when sending a file. |

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
| NFR-009 | M1 | Database MUST use migrations and schema version tracking, schema migration MUST run at operational process start, migration attempts MUST serialize on the database write lock through `BEGIN IMMEDIATE` while holding the single-row `migration_lock` table for the migration transaction, a waiter MUST block on the busy timeout and then re-check `schema_migrations` before applying anything, and the legacy `~/.sorage/run/migration.lock` file is an inspection signal rather than the runner's lock: inspection surfaces honor a live owner and preserve stale evidence, doctor guidance names it accordingly, and no surface may claim the runner acquires it. M8 preflight and send replay-only MUST inspect without migration or lock creation under PFL-002 and SND-002. The migration-lock wording mismatch this row carried until M9 is resolved by this text, and TASK-106 aligns the runner, doctor, and preflight against production fixtures. |
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
| M4 | GEN-015; CLI-022, CLI-023 | M4 CLI detail-read release |
| M5 | API-013; WEB-019 | M5 Web body-compose release |
| M6 | PRJ-023, PRJ-024; CLI-024, CLI-025 | M6 Project lifecycle and binding release |
| M7 | MEM-001..024 | M7 Project Memo release |
| M8 | PFL-001..008; SND-001..006; GEN-016..020 | Gate M8, storage inspection and agent safety |
| M9 | SHR-001..015; CHN-001..012 | Gate M9, agent communication channels and shared content storage |
| Deferred | WEB-016 | None; revisited after the MVP |

Release gates close at the end of EPIC-006 for M1, EPIC-007 for M2, EPIC-009 for M3, EPIC-010 for M4, EPIC-011 for M5, EPIC-012 for M6, and EPIC-013 for M7, as recorded in [the roadmap](../roadmap/README.md). M8 additionally requires both EPIC-014 and EPIC-015 and AJ-24 through AJ-26. Its intended product release is v0.1.3; gate acceptance does not authorize publication. M9 requires EPIC-016 and AJ-27 through AJ-29; M8, M9, and the release-blocking corrections of EPIC-017 ship together as the intended v0.1.3 ([ADR-0033](../architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release)), and gate acceptance still authorizes no publication.

The MVP is complete only when the M3 MVP release gate passes with every M1, M2, and M3 requirement satisfied. M4 through M9 do not reopen those gates.

## 18. Project Memos

[ADR-0027](../architecture-decision-records/README.md#adr-0027-project-memos-as-a-separate-domain-in-m7) adopts the separate M7 domain. [Project Memo contract](project-memos.md) defines the detailed lifecycle, interfaces, bounds, storage, and migration rules. These are required outcomes for M7; implementation status lives only in [the roadmap](../roadmap/README.md#epic-013-project-memos). M7 does not reopen or silently complete M6. Memo-specific rules below extend the legacy Handoff-scoped actor, paging, expectation, and backup contracts without changing existing Handoff behavior.

| ID | Milestone | Requirement |
|---|---|---|
| MEM-001 | M7 | Sorage MUST define Project Memo as an independent project-scoped note domain, without sender, recipient, delivery, Review Note, accepted Revision, next actor, or changes to the Handoff state machine. |
| MEM-002 | M7 | A Memo MUST reference one immutable registered Project UUID; explicit Project selection MUST work without a current binding, and moves, rebinds, renames, and duplicate titles MUST NOT change Memo identity. CLI inference MUST use the current directory's native resolver and MUST NOT fall back to another Project or all-project discovery. |
| MEM-003 | M7 | Memo mutations through CLI and Web MUST record the existing User actor, including user-authorized AI operations; author metadata MUST NOT claim human keystrokes, introduce named accounts, or form a sender/recipient authorization boundary. |
| MEM-004 | M7 | Memo input and output MUST have bounded, validated Unicode title and Markdown body with exact accepted body line endings, closed request shapes, safe integer versions, and the text/file/encoded-request limits in the Memo contract; from M9 the accepted body bound is the shared accepted-body bound of SHR-002 while bodies of at most 65,536 UTF-8 bytes remain inline, and NUL and invalid Unicode stay rejected. |
| MEM-005 | M7 | Memo lifecycle MUST be exactly open, done, and dismissed with explicit reopen, closed-content protection, same-state no-ops, and closing metadata; done MUST mean the caller recorded the reminder handled, not verified external workflow completion. |
| MEM-006 | M7 | Every existing-Memo mutation MUST require the caller's observed row version, enforce compare-and-set before state or no-op evaluation, and never overwrite from a stale or silently refreshed expectation. |
| MEM-007 | M7 | Memo operations MUST use the same normalized application request and transactional DB receipt across CLI and HTTP. Retained exact replay MUST return the original outcome with replayed=true in a fresh envelope; equivalent JSON MUST match and changed normalized requests MUST conflict. Explicit execute and replay-only modes MUST share the same business-request identity. Recovery of any outcome-unknown attempt MUST use replay-only with the original key/input/version; a missing or expired receipt, including after restore under the same Installation ID, MUST return MEMO_REPLAY_UNAVAILABLE without executing or writing a Memo, event, or receipt. Server lookup time MUST enforce expiresAt > now; replay MUST NOT extend expiry or use client time/identity as proof of receipt continuity. No unavailable/error result may automatically become execute or a new-key retry. |
| MEM-008 | M7 | Archived Projects MUST forbid new Memos and reopening, while preserving reads and existing open-Memo edits or closure; the create/reopen Project check MUST be atomic with the write, and archive MUST NOT cascade into Memo state. |
| MEM-009 | M7 | Memo writes MUST reuse core ports, the existing SQLite/UnitOfWork and mutation fences, and one transaction for the row, metadata event, and optional receipt, with no filesystem I/O or await inside that transaction. |
| MEM-010 | M7 | Actual Memo changes MUST append bounded metadata events associated with Memo and Project identity; reads and no-ops MUST NOT emit them, content MUST NOT appear in event metadata, and Memo events MUST NOT enter Handoff timelines, counters, or derived inbox markers. |
| MEM-011 | M7 | Memo lists MUST support explicit Project or all-project scope, open by default, other state filters, bounded literal search, stable created-time keyset ordering, scope-bound opaque cursors, and bounded previews; reads MUST NOT execute or mutate Memos; from M9 the literal search of SHR-007 covers file-backed bodies through the shared content interface without changing match, scope, ordering, or preview semantics. |
| MEM-012 | M7 | CLI MUST provide memo add, list, show, update, done, dismiss, and reopen with JSON envelopes, help, completion, bounded body-file import, Project selection, and observed expectations. The five mutation commands MUST support --replay-only with a required valid original idempotency key and input; unavailable receipt MUST use the specified error/exit contract without execution. Read commands MUST reject that mode. |
| MEM-013 | M7 | The local HTTP API MUST expose the seven Memo routes through the same use cases and DB receipts as CLI, bypass the legacy raw-body/process-memory replay wrapper for Memo routes only, require explicit read scope, and retain authentication, Host policy, encoded and decoded bounds, typed errors, and version checks. The five mutation routes MUST map validated Idempotency-Mode execute/replay-only and the original key/request into MEM-007; replay-only without a receipt MUST return MEMO_REPLAY_UNAVAILABLE/409 without an execute fallback. Memo JSON bodies MUST use bounded raw-byte collection and fatal UTF-8 decoding before JSON parsing, normalization, hashing, or receipt lookup; malformed UTF-8 MUST return MEMO_INVALID_INPUT/422 without Memo/event/receipt writes or successful replay, while valid U+FFFD and split multibyte sequences remain valid. Post-parse scalar validation MUST reject escaped unpaired surrogates. Existing Handoff route registration, JSON decoding, upload spooling, and replay semantics MUST remain unchanged. |
| MEM-014 | M7 | Web MUST expose Memos separately from Handoffs in the existing daemon-served browser assets, with Project/all-project selection, state/search filters, safe previews and editing, explicit reversible lifecycle actions, stale-edit recovery preserving drafts, and keyboard/IME support. One active unresolved attempt MUST block all new Memo writes in that tab across navigation/reload; storing retry material MUST precede sending and all recovery dispatches MUST be replay-only. A matching receipt or conclusive original non-execution may settle it. Alternatively, explicit user-confirmed abandonment MUST preserve a bounded passive outcome-unknown notice and retire the active record locally before unlocking, without a server mutation or replacement submit. Errors/expiry MUST NOT silently clear identity, failed storage MUST NOT unlock, late responses MUST NOT affect a newer attempt, and reads/other clients MUST remain available. |
| MEM-015 | M7 | Memo input MUST remain untrusted data; logs and event metadata MUST exclude content, Web MUST use safe text/Markdown rendering without automatic remote-image loading, and invalid requests or unsupported methods MUST fail without mutation. |
| MEM-016 | M7 | A successfully acknowledged Memo write MUST remain readable after process and daemon restart without Codex, an AI session, or another ecosystem tool; failed writes MUST NOT produce false success. |
| MEM-017 | M7 | The new database migration MUST be append-only, idempotent, transactional, tested against pre-Memo fixtures, and accompanied by explicit mixed-version and rollback guidance that does not claim old binaries safely reject an upgraded database. |
| MEM-018 | M7 | Backup MUST include all current Memos and metadata events in deterministic snapshot format 2 with mandatory Memo count and memoDigests, stable identities, and no silent omission. The Memo contract MUST fix canonical UTF-8 shard bytes including the final LF, raw-file SHA-256 in lowercase hexadecimal, and UUID-derived digest-map keys relative to snapshots/. Format-1 inventory and manifest remain a distinct legacy contract readable as zero Memos; zero-Memo format 2 MUST still contain its count and empty digest map; from M9 the writer emits the coherent global snapshot format 3 of SHR-010, and formats 1 and 2 remain restorable legacy inputs that are never rewritten. |
| MEM-019 | M7 | Backup verification, restore dry-run, and restore MUST validate exact Memo inventory, raw-byte digests, canonical serialization and paths, Project/event references, counts, and lifecycle invariants before import and preserve original values atomically. Duplicate keys/IDs, missing/extra or escaping/symlinked shard paths, malformed or partial data, and unknown newer formats MUST NOT be normalized away, skipped, or imported as successful partial restores. Restore MUST preserve Installation identity and Memo data but MUST NOT restore or reconstruct operational receipts; this differs from in-place upgrade. Recovery after restore MUST retain MEM-007's replay-only no-execution behavior, whether or not the restored snapshot includes the original Memo. |
| MEM-020 | M7 | The shipped use-sorage skill MUST distinguish explicit Memo reads, writes, and requested work-plus-close; checks MUST only report results, and a Memo body MUST NOT authorize its own execution or external side effects. Unknown mutation responses MUST be recovered with the original request/key in replay-only mode; unavailable receipt or abandonment MUST NOT imply failure, done, renewed execution authority, or automatic replacement creation. |
| MEM-021 | M7 | Memo operations MUST NOT register hooks, start background execution, scan at session/task boundaries, infer completion from turns or commits, or mutate roadmap, Podway, Dolgorae, Gul, Aquarium, or Handoff state. |
| MEM-022 | M7 | Existing Handoff CLI/HTTP outputs and behavior MUST remain compatible; no existing User-to-Project Handoff MUST be automatically converted, and the new domain MUST introduce no ecosystem source/runtime dependency. |
| MEM-023 | M7 | M7 MUST remain local and retain Memos until a separately authorized future deletion design; done and dismissed MUST NOT be represented as erasure, backup MUST disclose free-text and Git-history retention, and no automatic multi-machine synchronization is implied. |
| MEM-024 | M7 | M7 acceptance MUST cover AJ-20 to AJ-23 plus existing regressions through real compiled CLI, authenticated daemon, browser, restart, fault, migration, and restore fixtures under isolated SORAGE_HOME, including same-Installation restore without receipts, server-side expiry boundaries, and explicit abandonment/late-response isolation. TASK-092 MUST own only AJ-21-B browser acceptance, TASK-093 MUST own AJ-21-S skill acceptance, and TASK-094 MUST verify both for full AJ-21 without a backward dependency. Unperformed skill walkthroughs and platform checks MUST remain explicitly unverified. |

## 19. Installation preflight, milestone M8

[ADR-0028](../architecture-decision-records/README.md#adr-0028-non-mutating-installation-preflight-in-m8) adopts this public storage assessment. [The interface contract](interfaces-and-operations.md#36-installation-preflight-milestone-m8) owns its report and check catalog. Delivery status belongs only to [EPIC-014](../roadmap/README.md#epic-014-non-mutating-installation-preflight).

| ID | Milestone | Requirement |
|---|---|---|
| PFL-001 | M8 | M8 MUST provide sorage preflight before and after initialization, honoring INIT-015 and supporting human output, JSON, help, and completion without requiring a daemon or a registered Project. |
| PFL-002 | M8 | Preflight MUST NOT initialize, migrate, repair, drain intents, create or remove locks, change operational database journals, checkpoint WAL, write or rotate installation logs, alter configuration or Vault files, start a daemon, or change services. Both success and failure MUST leave selected storage unchanged; temporary inspection artifacts MUST remain outside the selected home and Vault and be cleaned up. |
| PFL-003 | M8 | Preflight MUST return the version-1 report defined in interfaces-and-operations with exactly one status: fresh, compatible, upgrade_required, recovery_required, unsupported, or unverifiable. It MUST distinguish an absent, empty or explicitly residue-only home under interface section 36.1 from incomplete state, MUST never classify unreadable state as fresh, and MUST include stable check IDs and actionable recovery guidance without exposing private storage contracts as consumer inputs. |
| PFL-004 | M8 | Preflight MUST validate supported configuration and Vault schemas, the complete ordered known database migration history, SQLite integrity and required schema structure, and consistent Installation identity across configuration, present database identity records, Project bindings, and the Vault marker. It MUST accept legitimate empty installations without fabricating missing identity rows and MUST NOT infer compatibility merely from a maximum migration number or the Memo table. |
| PFL-005 | M8 | A valid known older database MUST produce upgrade_required and identify migration needs separately from required upgrade preparation. Pre-Memo storage MUST retain the existing old-binary backup verification and separate restore-drill prerequisite. Preflight MUST NOT certify that an external drill occurred, grant upgrade approval, or automatically run the suggested work. |
| PFL-006 | M8 | Inspection MUST include committed WAL contents through a coherent temporary database snapshot and MUST NOT open operational SQLite to achieve this. Changing inventories, failed consistency checks, unsafe links, inaccessible storage, or unavailable snapshot support MUST fail closed as unverifiable; a readable newer storage schema MUST be unsupported rather than silently opened or migrated. |
| PFL-007 | M8 | Preflight JSON MUST use the existing envelope with data.contractVersion equal to 1, status, and checks, and MUST emit only JSON on stdout. Exit 0 MUST cover fresh and compatible, exit 78 MUST cover upgrade_required, recovery_required, and unsupported, and exit 75 MUST cover unverifiable. Reported recovery is guidance, never mutation authority; compatible is a point-in-time storage assessment, not a general health or artifact-integrity certificate. |
| PFL-008 | M8 | AJ-24 MUST verify fresh, current, known pre-Memo, incomplete, corrupt, inconsistent, and newer-schema storage, WAL and permission cases, races, and failure cleanup with before/after content hashes, permissions, modification times, identities, and file inventories. Native compiled-binary checks and make test MUST support acceptance; unchanged access timestamps are not claimed by ordinary filesystem reads. |

## 20. Non-executing send recovery, milestone M8

[ADR-0029](../architecture-decision-records/README.md#adr-0029-non-executing-send-recovery-and-agent-policy-in-m8) extends CLI send only. [The interface contract](interfaces-and-operations.md#37-send-replay-only-and-agent-policy-milestone-m8) owns recovery semantics; GEN-016 through GEN-020 own the skill policy. M7 Memo recovery remains separate. Delivery status belongs only to [EPIC-015](../roadmap/README.md#epic-015-safe-handoff-recovery-and-agent-policy).

| ID | Milestone | Requirement |
|---|---|---|
| SND-001 | M8 | M8 CLI send MUST accept --replay-only with a required original nonempty --idempotency-key and the original send input and sender context. Omission of the flag MUST retain ordinary send behavior. Replay-only is an inspection of an earlier intent, not authorization for another send. |
| SND-002 | M8 | Send replay-only MUST use a dedicated read-only application/adapter path over the PFL-006 snapshot boundary. It MUST NOT initialize or migrate storage, drain intents, stage or materialize body/file content, create Handoffs, Artifacts, events or receipts, clean up or renew receipts, modify journals, or write installation logs, including on failure. It MUST preserve the actual restore/Vault-move fences and committed-migration inspection rules of interface section 36.2, MUST NOT refresh derived inbox markers or acquire their locks, and MUST NOT use the existing expiry-deleting lookup. |
| SND-003 | M8 | A retained eligible send receipt MUST replay only the matching original business request and verified sender under the selected Installation, using existing sender-aware, legacy-hash, and Workspace-to-Project compatibility rules. It MUST return the existing SendOutcome with replayed=true in a fresh CLI envelope; mode MUST NOT change request hashing or stored receipt format, and replay MUST NOT claim current Handoff state or completed Artifact activation. |
| SND-004 | M8 | Receipt eligibility MUST use expiresAt > the lookup Clock sampled inside the consistent snapshot read; equality is expired. An absent, expired, or restore-missing receipt MUST return HANDOFF_REPLAY_UNAVAILABLE, HTTP-equivalent 409 and CLI exit 75, without execute fallback. A miss cannot establish non-execution or cancel a late original request; unchanged Installation identity or a client timer is not proof of receipt continuity. |
| SND-005 | M8 | A retained receipt for a different request MUST return IDEMPOTENCY_CONFLICT without effects; a different sender MUST not obtain another sender's result. Storage and snapshot failures MUST use the explicit typed mappings and supported historical layouts of interface section 37.1 rather than become a receipt miss, success or execute; expected storage refusals MUST NOT become INTERNAL_ERROR. Ownership and source failures MUST preserve their existing codes, including INTERNAL_ERROR/1 for a missing, unreadable or non-regular source, with M8 contextual message and recovery guidance and no logging. Missing original input or changed source bytes MUST not be replaced with current Handoff content, refreshed sender context, or a new key. |
| SND-006 | M8 | AJ-25 MUST cover retained and conflicting receipts, file and body sends, fan-out, response loss, restart, exact expiry, restore without receipts, late original execution, sender mismatch, legacy identity compatibility, inspection fences, and before/after no-write evidence. Existing send defaults, HTTP/Web routes, Memo recovery, other Handoff commands, and all persisted formats MUST remain compatible; make test and an independent Contract review are required. |

## 21. Agent communication channels and shared content storage, milestone M9

[ADR-0030](../architecture-decision-records/README.md#adr-0030-agent-communication-channels-and-shared-content-storage-in-m9) adopts the shared milestone M9 design; from EPIC-017, [ADR-0033](../architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release) adopts the SHR-015 and CHN-012 additions and the CHN-006, CHN-007, CHN-010, and CLI-020 amendments. [The interface contract](interfaces-and-operations.md#38-shared-content-and-agent-communication-channels-milestone-m9) owns the detailed surfaces, error catalog additions, and operations; [the Memo contract](project-memos.md) carries the Memo-specific amendments of its own domain. These are required outcomes for M9; implementation status lives only in [EPIC-016](../roadmap/README.md#epic-016-agent-communication-channels-and-shared-content-storage) and [EPIC-017](../roadmap/README.md#epic-017-channel-adoption-hardening-and-v013-release-readiness). M9 does not reopen or silently complete any earlier gate, and it ships with M8 and EPIC-017 in the one shared v0.1.3 release Master allocated on 2026-10-21 under [ADR-0033](../architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release), whose publication remains separately authorized.

M9 amends the following earlier requirements in place, and this section together with those amended rows is one contract: VLT-007, VLT-020, and VLT-024 for the inline Artifact representation and the managed `content/` subtree; HND-023 for `send --body` routing; MEM-004, MEM-011, and MEM-018 for the raised Memo body bound, cross-backend literal search, and snapshot format 3; CLI-020 for the shared `meta.timedOut` wait flag and, from EPIC-017, its Handoff wait continuation; and NFR-009 for the resolved migration-lock contract. Where any earlier document still describes Vault-only Artifact bodies, inline-only Memo bodies, a 65,536-byte Memo rejection bound, or the legacy migration file lock as current behavior, the amended row and this section win. One accepted envelope decision accompanies these amendments: the existing response envelope, protocol version 1, and the `/api/v1` routing prefix remain, because NFR-003 requires versioned, contract-tested public contracts without specifying a mandatory envelope or API bump per data-field change; the breaking inline `storageKey` data-DTO revision of SHR-013 is adopted under that decision with its mandatory migration and disclosure.

SEC-012 and BKP-023 continue to require same-transaction metadata events and complete ledger backup for both M9 domains and physical-content operations. [The event catalog](security-reliability.md#101-m9-event-metadata) fixes their closed metadata and [the interface inventory](interfaces-and-operations.md#389-m9-event-snapshot-inventory) fixes format/build support; these extend existing obligations rather than creating a second audit system.

### 21.1 Shared content storage

| ID | Milestone | Requirement |
|---|---|---|
| SHR-001 | M9 | Every authoritative body of a Handoff Artifact, a Project Memo, and a Channel message MUST use one shared content representation in which exactly one of inline content and a managed Vault-relative storage key is present, enforced by application validation and by database constraints on the storing tables; an empty inline value counts as present where its domain permits an empty body, and no domain may keep a second authoritative copy of one body in the other representation. |
| SHR-002 | M9 | Content routing MUST place text of at most 65,536 UTF-8 bytes inline, every larger accepted text body in the Vault, and binary content in the Vault at every size; classification is by domain surface and fatal UTF-8 decoding, where a body classified binary stays Vault-backed even when its bytes happen to decode as valid UTF-8; the total accepted-body bound for every domain is the existing `artifact.maxBytes` setting, enforced mid-stream without whole-body buffering; and each domain's empty-body, MIME, and validation rules are preserved. |
| SHR-003 | M9 | Both representations MUST preserve the exact accepted bytes, including line endings, Unicode, and a byte-order mark as content, and MUST record byte size and SHA-256; a Vault reference MUST be a nonempty managed relative storage key validated by the existing managed-key rules, never an absolute path, and no stored path may remain authority after a Vault move. |
| SHR-004 | M9 | The database MUST keep authoritative bodies in immutable normalized content records identified by UUID, each carrying exactly one of inline content and a managed storage key, plus byte size, SHA-256, and a materialized flag meaningful for file-backed records; a domain row references its current record, a superseding write creates a new record rather than editing one in place, and a record is removable only through reference-aware cleanup that proves no domain row and no unexpired retained response references it. |
| SHR-005 | M9 | File-backed content MUST reuse the existing synchronous UnitOfWork and post-commit intent machinery: stage, `fsync`, commit the domain change and its activation intent in one transaction, activate, and clear the intent in a second transaction; interrupted activation MUST converge through the start-up drain, a read of unmaterialized file-backed content MUST return `CONTENT_MATERIALIZING`, and missing or checksum-mismatched bytes MUST surface as visible integrity failures that never synthesize success or silently retry owed work. |
| SHR-006 | M9 | A read surface that must return a readable local path for inline content MUST materialize a read-only derived file under `state/fetch-cache/` inside the resolved Sorage home's existing `state` tree, addressed deterministically by the content checksum, reusable across fetches, stable beyond the exiting process, lazily created owner-only, and swept only through the existing garbage-collection grace window; the derived file is never authoritative, never a second stored body, never a new top-level home directory, and never included in the Vault, snapshots, or Git backup, so the existing `uninstall` state-tree removal and preflight residue rules stay coherent. |
| SHR-007 | M9 | Literal search MUST remain the exact case-sensitive substring match over title or body with no regular expressions, wildcard interpretation, or Unicode normalization, MUST apply its filters before pagination, and MUST cover file-backed bodies through bounded streaming scans whose chunk handling cannot split a match; no unbounded scan, whole-body buffering, or full-text index is introduced. |
| SHR-008 | M9 | A retained response MUST replay its original outcome: an inline original body MAY remain embedded in its receipt, and a receipt that already embeds an inline body string stays readable verbatim through upgrade, while a Vault-backed original body MUST be referenced through its immutable content record and MUST NOT be serialized in full into SQLite receipts; a referenced record MUST survive cleanup while its receipt is unexpired, replay MUST resolve references to the original bytes, and an unavailable, missing, or corrupt reference MUST report the existing replay-unavailable or integrity failure without executing or fabricating content. |
| SHR-009 | M9 | The next database migration MUST take the next unused version after the current maximum 7, each domain's rebuild migration belongs to its owning Task, and every schema-interpreting surface (migrator, preflight, replay inspection, restore) MUST share one ordered known-schema inventory with explicit per-surface legacy prefix eligibility; a database whose applied maximum migration exceeds the build's known maximum MUST fail closed with `STORAGE_SCHEMA_UNSUPPORTED` before operational work, without breaking offline `version` and `help` or the non-mutating preflight and replay-only contracts; a domain rebuild MUST follow the official SQLite generalized `ALTER TABLE` procedure on a dedicated non-operational connection — foreign-key enforcement verified and disabled outside any transaction on that connection only, one `BEGIN IMMEDIATE` transaction, replacement tables referencing final canonical names, copy without threshold repacking, documented drop order for the complete affected component including its cycles, rename, index and trigger recreation, count and association verification, and an empty `PRAGMA foreign_key_check` before commit — with enforcement restored and verified on that connection after commit or rollback on every exit, a post-commit restoration failure reported accurately as committed work plus an unusable connection, no global process setting, no disabled operational connection, and no `writable_schema`; and old executables are never assumed to read an upgraded home, so the supported inventory is per build and rollback uses a preserved verified pre-upgrade backup with its matching executable, with no automatic downgrade and no threshold-based historical repacking. |
| SHR-010 | M9 | Backup MUST move to one coherent global snapshot format 3 whose single manifest covers projects, handoffs, review notes, deletion requests, events, Memos, Channels, and the shared content inventory under the existing determinism and purity rules; the first M9 infrastructure Task turns the writer to format 3 with zero Channels and an empty content map, each owning Task adds exactly the format-3 representations its schema can faithfully import, a build rejects a valid later-generation structure before import with `VAULT_SCHEMA_UNSUPPORTED` (HTTP 409, CLI 78) rather than corruption, partial restore, fallback, or silent omission, formats 1 and 2 remain restorable legacy inputs that are never rewritten, restore does not manufacture operational receipts, bodies retained only by unexpired receipts are excluded from current-state export, and there are no per-domain snapshot format versions. |
| SHR-011 | M9 | The shared content store MUST integrate the existing operational seams in its first infrastructure delivery: activation and integrity intents, reference-aware garbage collection covering the managed `content/` subtree, Vault-move fencing, `vault verify` and `doctor` census through the enumerated additive `content.checksums` check id, backup inventory and Git pathspec including the `.gitattributes` extension, and large-content Git-growth disclosure; each seam preserves its existing Artifact behavior while generalizing to content records. |
| SHR-012 | M9 | Every transport that accepts a body MUST bound it before and during read: CLI text input follows the existing body-file rules with streaming size enforcement and fatal UTF-8 decoding where the surface is text-only, HTTP bodies use bounded raw-byte collection or the existing upload spooling rather than unbounded buffering, lists expose bounded previews with an explicit truncation flag, and full bodies are readable only through the complete-content interfaces. |
| SHR-013 | M9 | Public and operational changes MUST be classified explicitly per change rather than declared non-breaking from physical-storage arguments: additive Channel commands, error codes, and Memo multipart acceptance are additive where every old input and output keeps its semantics; the `storageKey` field of the affected Handoff response DTOs remains always present but carries JSON `null` for inline text Artifacts, which is a breaking data-DTO revision for string-only consumers adopted with the mandatory consumer, parser, and golden migration of the Handoff adoption Task, while the existing response envelope, protocol version 1, and `/api/v1` routing are kept by the accepted ADR decision that NFR-003 requires versioned, contract-tested contracts without a mandatory envelope or prefix bump per data-field change; snapshot format 3 and the schema upgrade are operationally breaking for older readers and are disclosed as the upgrade boundary; and the resolved migration serialization is classified with its upgrade guidance rather than claimed unchanged. |
| SHR-014 | M9 | Existing behavior MUST remain preserved through adoption: Handoff identity, Revision, review and acceptance relationships, sender and source policy, and uncertain-send recovery keep their contracts; Memo lifecycle, User provenance, observed-version updates, empty-body handling, replay-only recovery, and the Web unknown-attempt gate keep their contracts; existing file-backed Handoffs and inline Memos stay readable without automatic repacking; and no domain's adoption may require a later Task's functionality for its own correctness or acceptance. |
| SHR-015 | M9 | Database open, migration, and actor-resolution failures caused by storage contention or unavailability, and a busy write-lock acquisition, MUST be classified in the shared CLI and adapter layers (never per Channel action) and return the JSON error envelope with the extended `STORAGE_INSPECTION_UNAVAILABLE` meaning, HTTP 503 and CLI exit 75, for the Channel, Handoff, and Project command families. The refusal is produced only at pre-commit sites — connection open, migration, actor resolution, the keyed idempotency lookup's expiry-cleanup write, the startup drain's recovery and cleanup transactions, and the write-lock acquisition or commit of the command's own domain transaction — and asserts that the invoking command committed none of the domain changes it was asked to make; startup recovery and the migration path may already have committed earlier completions or housekeeping. Genuine usage errors keep exit 2; schema-unsupported, integrity, configuration (including an unreadable configuration file on an operational command path, which is `CONFIG_INVALID`; the replay-only inspections of send and Channel submit keep their recovery semantics, under which a configuration they cannot read safely stays `STORAGE_INSPECTION_UNAVAILABLE`), conclusive-fence, and content-materialization conditions keep their existing codes; Memo, vault, backup, config, doctor, preflight, daemon, and Web surfaces keep their current contracts except the shared-adapter and shared-core corrections listed in [interface section 38.10](interfaces-and-operations.md#3810-epic-017-public-contract-classification): the daemon's Handoff and Project routes share the adapter classification, so expected write-lock contention there returns the documented `503 STORAGE_INSPECTION_UNAVAILABLE` instead of `500 INTERNAL_ERROR`, having committed none of the requested domain changes. A Channel command MUST resolve its actor on its existing open-and-migrated connection without an extra open-and-migrate or an unclosed connection; the refusal carries per-surface recovery guidance from its first introduction; and a retry preserves the original mode, input, and idempotency key. Every step after a command's domain commit is post-commit work that never becomes this refusal and never escapes as an untyped usage error: physical completion returns the committed outcome, leaves the pending intent to the startup drain, and discloses the failure as a warning; advisory derived-view refresh, including the failure to create its ports, never changes the result and is a warning only; result-presentation reads after commit return the committed outcome with the DTO's explicit indicator where one is defined and otherwise the committed outcome plus a warning, and an adapter MUST read a mutation's result rows inside the committing transaction rather than after it, so a read failure rolls the change and its events back and returns that failure with nothing committed instead of misreporting a committed change; and logging, disclosure, and cleanup sinks never change the result. These post-commit rules apply to every surface that calls the corrected core, with no route, DTO, status-code inventory, or screen change, while the actual responses change as [interface section 38.10](interfaces-and-operations.md#3810-epic-017-public-contract-classification) records: an operation that committed returns its normal committed success, with the physical-completion failure disclosed as a warning, and an in-transaction read failure returns an honest pre-commit failure having committed nothing. |

### 21.2 Agent communication channels

| ID | Milestone | Requirement |
|---|---|---|
| CHN-001 | M9 | Sorage MUST provide one durable attributed upstream Channel per orchestration invocation, owned by one main participant with multiple registered Worker and Judge participants, where Workers and Judges submit reports, questions, and peer-relay requests upstream as untrusted data, main reads them as tool-result data and owns every downstream instruction and external-effect reconciliation, and no lower participant needs an inbox handler or polling loop; a Channel keeps its identity across Podway sessions, member Goals, corrections, internal validation, and resumption; and recording or delivering a message executes no content and advances no external workflow. |
| CHN-002 | M9 | Participants MUST be registered explicitly on an open Channel under main-role or User authority with distinct immutable participant IDs and exactly the roles `main`, `worker`, and `judge`, where exactly one main exists; registration records a bounded nonempty handle and MAY record bounded supplied native-handle provenance as untrusted attribution; a deactivated participant keeps attribution of earlier messages and cannot submit; reactivation is not offered in M9; and attribution uses the existing actor provenance and claims no OS-user isolation under SEC-013. |
| CHN-003 | M9 | Assignments MUST be explicit labeled records optionally bound to one participant, created and closed under main-role or User authority as metadata only; a message MAY reference an assignment, a report against a closed or stale assignment MUST still be accepted and remain distinguishable as late, and assignment state never blocks submission on an open Channel. |
| CHN-004 | M9 | A message MUST carry its Channel, an active registered sender participant, exactly one of the kinds `report`, `question`, and `relay_request`, a text-only body through the shared content interface with exact bytes and bounded input, an optional assignment reference, and optional supplied external workflow context recorded verbatim as untrusted provenance; a relay request names a target participant while preserving the original source, and message content never grants execution, user, approval, commit, or publication authority. |
| CHN-005 | M9 | Reading and processing MUST stay separate: listing and reading messages never mutates them; handling is an explicit main-role operation on one message that records the handling provenance, time, optional bounded note, and a processing row version; a duplicate or concurrent handling attempt is resolved by compare-and-set without losing the first decision; messages and processing decisions survive restart; and re-reading a message never redispatches work or claims an external effect. |
| CHN-006 | M9 | Message submission MUST support the existing idempotency-key convention in a Channel-specific scope, where a retained exact replay returns the original outcome with `replayed=true` in a fresh envelope and a changed request under the same key conflicts; recovery of an outcome-unknown submission MUST use a replay-only mode with the original key and input, a missing, expired, or restore-lost receipt MUST return `CHN_REPLAY_UNAVAILABLE` without executing or creating a message, and an unknown external dispatch outcome never authorizes a blind repeat. A new direct main-participant assignment for a new attempt is a genuinely new intent: the assigned role may submit its existing result once under a new idempotency key bound to the new `--context-attempt`. Authority comes only from the main participant through the role's own direct instruction surface; a Channel message body, recovery hint, replay result, or changed context field confers none. The earlier submission's outcome stays unknown and may still commit; main treats a message bound to a superseded attempt as stale, and a role never retries on its own initiative. |
| CHN-007 | M9 | Channel waiting MUST account for messages that are already unhandled: a wait returns immediately when any unhandled message matches its filter, otherwise polls at the configured bounded interval until an arrival or timeout; a wait keeps polling across retried listing failures (`STORAGE_INSPECTION_UNAVAILABLE` and read-side `CONTENT_MATERIALIZING`) until the deadline, reports a failure that persists at the deadline as that typed error, and reports no retry count; a timeout reports `meta.timedOut` under the shared wait metadata contract of CLI-020; a wait never marks, handles, or mutates messages or any domain record — its process-level storage writes are those disclosed in [security-reliability section 17](security-reliability.md#17-m9-channel-command-writable-storage); and its interval and timeout bounds follow the existing CLI numeric-option rules. |
| CHN-008 | M9 | A Channel lifecycle MUST be exactly `open` and `closed`: creation records creator provenance under the existing actor kinds and an optional bounded title; close is a terminal main-role or User operation that freezes new submissions while reads and continued processing of existing messages remain available; rediscovery and resumption use explicit Channel identity through listing, showing, and idempotent creation replay, with no automatic inference of a Channel from the working directory or any external tool state. |
| CHN-009 | M9 | Channel records MUST be retained with no M9 deletion, and runtime Channel records — channels, participants, assignments, messages, processing decisions, and their content — MUST be included in the existing Vault Git backup and restore policy through snapshot format 3, while operational receipts are excluded from restore exactly as for Handoffs and Memos; backup enablement and push keep their existing explicit settings, and large-content Git-history growth is disclosed with the existing backup warnings. |
| CHN-010 | M9 | First delivery MUST be CLI-only: no Channel HTTP routes, no Channel Web screens, and no automatic wake-up are added, existing Handoff and Memo HTTP and Web behavior remains supported, and Sorage's shipped skill and public consumer guidance MUST state the channel-confined authority, the tool-result treatment of received content, main-mediated peer requests, the storage paths Channel commands write under [security-reliability section 17](security-reliability.md#17-m9-channel-command-writable-storage), the domain-records-only meaning of non-mutating reads and waits, and the main-directed new-attempt rule of CHN-006, without requiring any ecosystem tool at runtime. |
| CHN-011 | M9 | Channel content MUST remain untrusted data: logs and event metadata exclude message bodies, participant handles and message text never serve as authentication or authorization, hostile instructions inside a message cannot authorize tool, network, commit, deletion, or publication effects, and one Channel's records MUST NOT be disclosed through another Channel's operations. |
| CHN-012 | M9 | A committed Channel outcome MUST never be reported as a plain failure: a submit whose message committed while its file-backed content activates returns the committed message summary with an explicit `contentActivating` indication — the negation of the database-observed materialized state of the message's content record when the response is produced, always false for inline content, derived read-only at replay time from the current record state through a database-only content-state probe, with the stored receipt format unchanged — and a committed handling decision returns its committed summary with an explicit `bodyPreviewUnavailable` indication whenever only the preview or binding read failed after commit. Channel waits and the Handoff inbox wait MUST keep polling across retried listing failures (`STORAGE_INSPECTION_UNAVAILABLE` and read-side `CONTENT_MATERIALIZING`) until a deadline measured from invocation, MUST report a failure that persists at the deadline as that typed error, MUST keep the ordinary empty timeout at exit 0 with `meta.timedOut: true`, MUST report no retry count, and the Handoff wait's known set MUST be fixed by the first complete successful seed as the IDs whose creation time precedes the invocation instant, so an item created at or after that instant is new even when a retried seed lists it, and a known item's later state change never wakes the wait. Unknown participant and assignment filters MUST fail immediately with their section 38.4 not-found codes, with and without `--wait`. Channel error renderings MUST carry Channel-specific, state-accurate recovery text, the already-handled refusals MUST carry the recorded decision fields `handledAt`, `handledByParticipantId`, and `handledByKind` as details, and no Channel hint may suggest a fresh idempotency key for an unknown submission outcome. |
