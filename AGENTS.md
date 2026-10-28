# AGENTS.md

Sorage is a standalone TypeScript document-handoff broker for AI coding sessions; this file is its local agent guidance.

## Core Behavior

### 1. Lead with Conclusions

- State the result or current finding first, followed by useful evidence and material limits.
- Do not repeatedly restate requirements or narrate routine work.

### 2. Reuse Verified Information

- Inspect the requested code and its named authorities before changing anything. Resolve discoverable facts before asking Master.
- Reuse established facts instead of reading or searching for them again. Recheck only the affected information when relevant state changes, evidence conflicts, or missing context makes it unreliable.
- State material assumptions and surface meaningful trade-offs. Ask when unresolved ambiguity would materially change the result, and push back on conflicts with repository authority, safety, or Master's goal.
- Before changing a feature, read applicable directory AGENTS.md files and the canonical documents relevant to the change. Respect the selected harness's native instruction scope and precedence.

### 3. Act on Sufficient Evidence

- Stop investigating once the evidence supports action. When the root cause is established, implement the smallest complete, durable fix within the authorized scope.
- Weigh correctness, performance, maintainability, and structural fit rather than diff size alone. If a broader design exceeds scope, complete a bounded step that satisfies current acceptance criteria.
- Reuse established patterns. Avoid speculative features, abstractions, configurability, compatibility layers, and handling for states repository invariants make impossible. Simplify complexity that the required behavior does not justify.
- Touch only what the outcome and its verification require. Preserve unrelated user work, match local style, and remove only artifacts made obsolete by this change.
- Record only independent remaining work in [docs/deferred-feedback/README.md](docs/deferred-feedback/README.md). Promote epic-sized work to a TODO candidate or roadmap unit; never defer current correctness or acceptance work.
- Read directory-guide adoption coverage in the root documentation index. Maintain affected canonical documents and existing applicable guides, including guides outside that coverage. Within adopted coverage, add guides for new feature boundaries as part of the authorized work. Report uncovered areas without unrelated backfill; guide absence alone adds no workflow blocker. Finish affected documentation before candidate review.

### 4. Carry Authorization Forward

- Continue already approved work without asking for confirmation again. Ask only when a material change exceeds that authorization or an applicable rule requires a distinct approval.
- Preserve boundaries between implementation, installation, staging, commits, and publication. Check for relevant state changes before acting on an approved proposal.

### 5. Verify in Proportion to Risk

- Define success checks before implementation. Verify the affected behavior and relevant failure paths with rigor proportionate to the actual risk.
- Run focused checks first and honor required repository gates. Broaden or repeat checks when changes, failures, or unresolved concerns justify it.
- Do not add tests merely to appear rigorous or use prose matching as a substitute for behavior verification.

### 6. Finish When Complete

- Continue until deliverables and required verification are complete or a concrete blocker prevents progress.
- Once material constraints are resolved or clearly reported, provide the handoff and stop. Report the result, necessary evidence, skipped checks and their reasons, and remaining uncertainty without opening unrelated work.

### 7. Delegate Selectively

- Use a sub-agent only for an independent task when the expected benefit outweighs coordination cost.
- Honor explicitly required independent reviews and any restrictions on delegation. Keep tightly coupled work local.

## Master Preferences

- Respond to Master in Korean using polite speech. When directly addressing the user, use exactly `Master`.
- Keep repository artifacts in the repository's established language and style. When no convention exists, use English unless Master requests otherwise.
- Report concise conclusions and useful evidence without exposing private chain-of-thought.

## Aquarium Development Guide

- Use `$aquarium:task-handler` for one named roadmap task, `$aquarium:epic-handler` for one roadmap epic, and `$aquarium:epic-validator` to cold-validate a completed epic.
- Use `$aquarium:task-commit` for every authorized commit. A standalone Task uses the `task-review` phase of `$aquarium:task-handler`; a member Task in an explicitly invoked Epic uses the approved delegated review route of `$aquarium:epic-handler`.
- Use `$aquarium:dev-setup` to diagnose or configure development tooling.
- Podway, Mulgae, Gaori, and Sanho are optional development tooling configured by `$aquarium:dev-setup`; none of them is required to build, test, or release Sorage.
- Use `$lore-commits` for non-trivial commit messages and `$lore-query` to inspect recorded decision context.

- Use `$use-mulgae` for authorized asynchronous reviews and `$use-gaori` for selected asynchronous checks. Use `$use-gaori-status` for command timing and history questions. Global MCP registrations supply Mulgae and Gaori; do not add project-local registrations without explicit intent.
- Use `$use-podway` for explicitly requested Podway operations. Aquarium workflows use Podway by default for Git-backed work unless Master opts out before the first managed-session mutation; setup does not start a session.
- Use `$use-sorage` only when Master explicitly requests a Sorage broker operation. Session start, task boundaries, and Sorage code work do not trigger inbox or outbox checks. Use `$aquarium:dev-setup` for explicitly requested Sorage Project setup; during setup, ensure `.sorage/` is ignored in `.gitignore` without duplicating an existing entry. Resolve broker operations through that skill and never edit the managed Vault or derived `.sorage/INBOX.md` directly.
- Use `$use-dolgorae` for explicitly requested workspace, Profile, review, engagement, or recovery operations. A capability or global-state failure blocks the dependent operation; never initialize over incompatible state or edit its files directly.
- Use `$aquarium:dev-setup-global` for user-global tools and `$aquarium:dev-setup` for repository-local configuration.
- Keep `.mulgae/**`, `.gaori/runs/**`, `.podway/runtime/**`, and `.sorage/**` as local runtime evidence. Do not cite runtime paths or identities as durable evidence in tracked documents or commit messages; use an approved tracked `aquarium.promoted-evidence/v1` package only when a downstream consumer needs retained evidence.

## Project Configuration

### Repository Index and Authorities

- Read [README.md](README.md) for the public product overview, installation, and basic usage.
- Read [CHANGELOG.md](CHANGELOG.md) for cumulative release notes and the planned next stable release.
- Read [docs/README.md](docs/README.md) before development; it owns the documentation map, role ownership, authority order, and roadmap identity contract.
- Read [docs/governance/README.md](docs/governance/README.md) before changing a Task status, closing a Task, or making a material change.
- Read [docs/roadmap/README.md](docs/roadmap/README.md) to learn what is eligible to start; nothing else in this repository records delivery status.

- Authority order, highest first: [docs/specs/required-specification.md](docs/specs/required-specification.md), accepted decisions in [docs/architecture-decision-records/README.md](docs/architecture-decision-records/README.md), [docs/architecture/README.md](docs/architecture/README.md), [docs/specs/interfaces-and-operations.md](docs/specs/interfaces-and-operations.md), [docs/specs/security-reliability.md](docs/specs/security-reliability.md), [docs/specs/project-memos.md](docs/specs/project-memos.md) for detailed Memo behavior and explicit M7 extensions, [docs/specs/testing-and-acceptance.md](docs/specs/testing-and-acceptance.md), [docs/specs/traceability.md](docs/specs/traceability.md), [docs/roadmap/README.md](docs/roadmap/README.md), [docs/implementation-tips/README.md](docs/implementation-tips/README.md), then the examples and schemas under `docs/specs/`.
- The Memo contract does not override shared authentication, security, envelopes, or transaction safety. Higher-ranked documents explicitly scope legacy Handoff replay and format-1 backup rules; Memo-specific interfaces, pending-attempt handling, and format-2 shard/digest details live in the Memo contract.
- [docs/product/README.md](docs/product/README.md) and [docs/todo/future-work.md](docs/todo/future-work.md) are non-normative context and never settle a conflict.
- A conflict with a higher-authority document stops the active Task; record the conflict and resolve it in the Source of Truth before writing implementation code.
- Never let an implementation shortcut become product behavior without the material change process in [docs/governance/README.md](docs/governance/README.md).

- Bun is pinned to `1.4.2`. `make build` builds the CLI and `make package` creates the packaged executable. `make test` is the canonical code gate; `make test-prepare` includes format, lint, type, boundary, and SOT checks.
- Gaori command `test` runs `["make", "test"]` with the `generic` parser and a 3600-second timeout because the full gate combines preparation and several test stages. Configuration validation is `gaori --json config check`.

### Commit Messages

- Every developer-authored subject uses one header and a concise English imperative summary: `[FEAT]`, `[FIX]`, `[DEV]`, `[TEST]`, `[DOC]`, `[CI]`, `[REL]`, or `[INT]`.
- Use `[FEAT]` for new user-facing capabilities, `[FIX]` for defects, and `[DEV]` for development tools, build configuration, dependencies, or internal integration. Use `[TEST]`, `[DOC]`, or `[CI]` for changes limited to that concern, and `[INT]` for internal contracts or refactoring.
- Release metadata commits use exactly `[REL] Release v<version>`. Tool-generated commits retain their native subjects and provenance; never hand-author a `[SANHO]` synchronization commit.
- End every developer-authored message with one trailer block containing exactly one `Aquarium-Workflow:`, `Aquarium-Epic:`, and `Aquarium-Task:`, in that order. Separate the block from the subject or optional body with one blank line; do not put blank lines between trailers.
- `Aquarium-Workflow` records the responsible `aquarium:<canonical-skill-name>`. Preserve a verified original skill through later commits, including changes from documentation, development, or test setup. Child phases and reviews inherit an established parent's owner; independently approved workflows own their candidate. Use `aquarium:task-commit` only for a direct commit without an original Aquarium workflow, and `none` for work outside Aquarium.
- Resolve a Task and its parent Epic from the accepted relationship and canonical roadmap, including a standing `EPIC-000` where applicable. Preserve native IDs, suffixes, and scope qualification. Epic-owned work uses `Aquarium-Task: none`; work without either owner uses `none` for both. Resolve unknown relationships instead of treating them as absent.
- Put primary work IDs in these attributes rather than the subject or legacy `Task:` and `Task-Relationship:` aliases. Use `$lore-commits` for useful decision context on non-trivial changes; optional Lore trailers may repeat. Preserve required evidence, release-note, and tool provenance trailers.
- Parse the prepared message and actual post-hook commit with `git interpret-trailers --parse`; verify all three attributes against the accepted candidate. Attribution never grants staging, commit, amend, push, or publication authority.

- Follow [docs/governance/README.md](docs/governance/README.md): each commit carries one exact Task relationship with an approved lifecycle edit, or explicitly states that it is unrelated to every active Task. Use complete canonical identifiers.
- Every authorized commit uses `$aquarium:task-commit`; staging, commits, amendments, and pushes each require explicit user instruction.

### Project-Specific Operating Rules

#### Roadmap And Task Lifecycle

- The active pointer section of [docs/roadmap/README.md](docs/roadmap/README.md) is the sole delivery-status authority: `Active Epic`, `Active Task`, `In Review Task`, and `Next eligible Task` live there and nowhere else.
- Task statuses are exactly `Planned`, `In Progress`, `In Review`, `Completed`, `Blocked`, and `Deferred`, case-sensitive, because the Aquarium roadmap hook matches them literally.
- At most one Task may be `In Progress` and at most one other Task may be `In Review`; the `In Review` Task must close before a third Task starts.
- Every commit goes through `$aquarium:task-commit` once a roadmap file is tracked, which runs the gate as `AQUARIUM_COMMIT_GATE=task-commit-v1 git commit ...`.
- The Reviewer is a separate AI session with no write access to the implementation diff. A standalone Task uses `$aquarium:task-handler`'s `task-review` phase; a member Task under `$aquarium:epic-handler` uses its approved delegated review route. The implementing session never reviews its own diff.

#### Definition Of Done

- Definition of Done depends on the Task class, and the three classes are defined in [docs/governance/README.md](docs/governance/README.md).
- Chore: a deliverable whose text starts with `Chore:`, closed by the change plus one test or a recorded reason why a test does not apply, with no unresolved Source of Truth conflict.
- Standard: implementation, applicable unit/integration and error-path evidence, updated documentation and examples, an updated roadmap status, and independent Reviewer confirmation under [governance section 18.1](docs/governance/README.md#181-proportionate-verification-and-review). TASK-135 retains its bounded documentation-only gate; TASK-138 owns the final integrated EPIC-020 full gate.
- Contract: Standard plus a reviewed snapshot diff classified as breaking or non-breaking plus a recorded migration impact, required for every Task touching the protocol package, the CLI JSON contract, HTTP DTOs, the configuration schema, or a database migration.

#### Verification

- `make test` is the single verification gate for code.
- `scripts/sot-check.ts`, run through `bun run check:sot` and `make test-prepare`, verifies this document set.
- Before review, run the focused checks required by the changed behavior and its failure paths under [governance section 18.1](docs/governance/README.md#181-proportionate-verification-and-review). Reuse unchanged applicable evidence with its candidate and limitations recorded. Run the complete `make test` for the final integrated candidate and repeat it when later changes invalidate that integrated evidence; focused checks are never reported as a full gate. Report every skipped check with its reason.

#### Documentation Style

- Do not hard-wrap prose: one paragraph is one source line, and line breaks are used only where the Markdown structure needs them.
- Every relative link must resolve from the file that contains it.
- Documentation filenames use lowercase kebab case, and `AGENTS.md`, `CLAUDE.md`, and `README.md` are the uppercase exceptions.
- Write prose, code, comments, tests, commit messages, and CLI text in English unless the user asks for another language.

#### Safety Rules

- Development tests and manual product checks must never read, write, or delete the developer's real `~/.sorage`; point `SORAGE_HOME` at a temporary directory. Explicitly authorized broker operations for this registered Project use the native Sorage CLI and its managed home; never edit that home directly.
- Never run `git add`, `git commit`, or `git push` unless the user explicitly asks for that exact action, and never disturb unrelated staged, unstaged, or untracked changes.
- Never add a handler, skill, or file to Aquarium or to any other ecosystem repository; Sorage ships its own agent policy at `skills/use-sorage/SKILL.md`.
