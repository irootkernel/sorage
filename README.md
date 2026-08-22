# Sorage Source of Truth

- Source of Truth version: `0.4.0`
- Product status: Planned
- Korean product name: 소라게
- Repository: `irootkernel/sorage`
- MVP platform: macOS
- Implementation language: TypeScript
- Runtime: Bun
- Canonical product name: `Sorage`
- Canonical executable name: `sorage`

## Product definition

Sorage (소라게) is a local document-handoff broker for AI coding sessions: one project hands one current document to one recipient project, the recipient reads it and may attach one Review Note, the sender revises, and the recipient ends the exchange with an explicit decision that names the exact Revision it accepted.

Sorage is not a document editor, a version-control system, a chat service, an issue tracker, or a multi-agent orchestrator; a single send may name several recipients, but Sorage always creates one independent Handoff per recipient, each with its own UUID, Artifact, Revision counter, Review Note, review state, and retention decisions.

The MVP is delivered in three milestones, each closed by its own release gate:

- `0.1` CLI core: CLI, SQLite, and the Vault, with no daemon, no Web UI, and no Git backup.
- `0.2` daemon, local HTTP API, and Web UI.
- `0.3` Git backup and restore, scheduler, LaunchAgent, and packaging; passing this gate completes the MVP.

The release tags `v0.1.0`, `v0.2.0`, and `v0.3.0` form a product version series that is independent of the Source of Truth document version stated above, and the two are never expected to match.

## Naming and ecosystem relationship

`Sorage` is the canonical Latin-script name for the Korean name `소라게`; runtime identifiers use `Sorage`, `sorage`, or `SORAGE` according to context, and spellings such as `Soragae` or `Sora-ge` are not canonical identifiers.

Sorage is a standalone repository that owns both its code and this Source of Truth; Aquarium, Podway, Mulgae, Gaori, and Sanho are development tooling for this repository and are never source dependencies of any Sorage package, at build time or at run time.

Discovery for recipient sessions ships as the `use-sorage` skill at `skills/use-sorage/SKILL.md` inside this repository, so Sorage requires no change to Aquarium or to any other ecosystem tool.

"Handoff" is used elsewhere in this ecosystem for the Aquarium plan handoff, the dolgorae writer handoff, and the Podway `handed_off` task state; a Sorage Handoff is none of those, and it means one custodied document delivered to one recipient Project together with its review loop.

## Fixed product decisions

1. Configuration is stored at `~/.sorage/config.yaml`.
2. `sorage init` is required before normal commands may run.
3. The Vault location is configurable; the default is `~/.sorage/vault`.
4. Project metadata and directory bindings are stored in SQLite, not in `config.yaml`.
5. A sender may be a registered Project, an unregistered Workspace, or the local User.
6. A recipient MUST be an active registered Project with at least one directory binding.
7. One Handoff has exactly one recipient.
8. A multi-recipient send is fan-out into independent Handoffs.
9. One Handoff has at most one current Review Note.
10. Sorage retains only the current Artifact and a Revision number. Revisions replaced between two Git backups are not preserved anywhere.
11. `accepted`, `declined`, and `withdrawn` are terminal review states; a terminal Handoff is immutable in content.
12. Actual deletion requires explicit User approval and leaves a tombstone.
13. Git backup of the Vault is recommended and may run daily (milestone 0.3).
14. SQLite remains outside the Vault and is never committed; the event ledger is exported into the Vault snapshot.
15. The MVP is delivered in three milestones: 0.1 CLI, 0.2 daemon + local HTTP API + Web UI, 0.3 Git backup and packaging.
16. MCP integration is deferred until after the MVP contract is stable.
17. The daemon binds only to loopback interfaces and validates the Host header on every request.
18. macOS is the initial supported platform. Linux support is future work.
19. Sorage is a standalone repository; Aquarium and its sibling tools are used as development tooling and are never source dependencies.
20. Runtime identity: binary `sorage`, home `~/.sorage/`, override `SORAGE_HOME`, LaunchAgent label `xyz.rootkernel.sorage`.
21. Sorage ships a `use-sorage` skill in this repository; it does not add handlers to Aquarium.
22. Toolchain: pinned Bun, `bun:sqlite`, Vitest executed through Bun, `bun build --compile`, Homebrew tap distribution, `make test` as the single verification gate.
23. Epic IDs use `EPIC-NNN`; Task IDs use globally sequential `TASK-NNN`. Identifiers become immutable once committed to the repository.
24. All writers (CLI processes and the daemon) mutate through the shared application layer; mutations are serialized by SQLite write transactions and the committed filesystem intent log. The CLI does not require a running daemon. The daemon exists to serve the Web UI, the scheduler, and garbage collection.
25. Every git worktree of a registered repository resolves to that Project.

## Source of Truth precedence

When documents conflict, apply this order:

1. [docs/required-specification.md](docs/required-specification.md)
2. Accepted decisions in [docs/architecture-decisions.md](docs/architecture-decisions.md)
3. [docs/domain-and-architecture.md](docs/domain-and-architecture.md)
4. [docs/interfaces-and-operations.md](docs/interfaces-and-operations.md)
5. [docs/security-reliability.md](docs/security-reliability.md)
6. [docs/testing-and-acceptance.md](docs/testing-and-acceptance.md)
7. [docs/traceability.md](docs/traceability.md)
8. [docs/roadmap.md](docs/roadmap.md)
9. [docs/implementation-guide.md](docs/implementation-guide.md)
10. Examples and schemas under [docs/examples/](docs/examples/) and [docs/schemas/](docs/schemas/)

[docs/product-charter.md](docs/product-charter.md) and [docs/future-work.md](docs/future-work.md) sit outside this order because they are non-normative context: they explain why the product exists and what was deliberately excluded, and they never settle a conflict.

No implementation may silently override a higher-authority document.

## Document map

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Repository guidance for AI coding agents |
| [docs/sot-governance.md](docs/sot-governance.md) | Authority, change control, Task lifecycle, and Definition of Done |
| [docs/product-charter.md](docs/product-charter.md) | Non-normative context: problem, mission, goals, actors, use cases, success criteria, and non-goals |
| [docs/required-specification.md](docs/required-specification.md) | Normative functional and non-functional requirements with milestones |
| [docs/domain-and-architecture.md](docs/domain-and-architecture.md) | Entities, invariants, state machine, components, storage protocol, and transactions |
| [docs/interfaces-and-operations.md](docs/interfaces-and-operations.md) | Configuration, CLI, local API, Web UI, Vault, Git backup, and operations |
| [docs/security-reliability.md](docs/security-reliability.md) | Local trust model, path safety, crash handling, events, and operational safeguards |
| [docs/testing-and-acceptance.md](docs/testing-and-acceptance.md) | Test strategy, acceptance journeys, and release gates |
| [docs/roadmap.md](docs/roadmap.md) | Active pointer, Epics, and Tasks |
| [docs/traceability.md](docs/traceability.md) | Requirement-to-Epic and requirement-to-Task mapping |
| [docs/implementation-guide.md](docs/implementation-guide.md) | Engineering conventions and implementation guidance |
| [docs/architecture-decisions.md](docs/architecture-decisions.md) | Accepted architecture decisions |
| [docs/future-work.md](docs/future-work.md) | Non-normative context: explicitly deferred work |
| [docs/examples/cli-workflow.md](docs/examples/cli-workflow.md) | End-to-end command example |
| [docs/examples/config.example.yaml](docs/examples/config.example.yaml) | Canonical configuration example |
| [docs/schemas/config.schema.json](docs/schemas/config.schema.json) | Machine-readable configuration schema |

## Development start rule

No code Task may begin until the implementing session has done all of the following:

1. Read this README.
2. Read [AGENTS.md](AGENTS.md).
3. Read [docs/sot-governance.md](docs/sot-governance.md).
4. Confirmed the next eligible Epic and Task in the active pointer of [docs/roadmap.md](docs/roadmap.md), which is the only place delivery status lives.
5. Moved exactly one Task to `In Progress` through the Aquarium task handler.
6. Recorded every design conflict against the Source of Truth before writing implementation code.

The initial next eligible Epic is `EPIC-001`, and the initial next eligible Task is `TASK-001`.

## Verification

`make test` is the single verification gate for code, and `scripts/sot-check` is the consistency check for this document set; both are created by `EPIC-001` and do not exist yet.

Until they exist, verification is limited to reading the documents in the precedence order above.
