# Repository Guidance

Sorage is a planned standalone TypeScript document-handoff broker for AI coding sessions; this repository currently holds its Source of Truth and no code.

## Start Here

- Read [README.md](README.md) before anything else; it carries the fixed product decisions, the authority order, the document map, and the development start rule.
- Read [docs/sot-governance.md](docs/sot-governance.md) before changing a Task status, closing a Task, or making a material change.
- Read [docs/roadmap.md](docs/roadmap.md) to learn what is eligible to start; nothing else in this repository records delivery status.

## Authority

- Authority order, highest first: [docs/required-specification.md](docs/required-specification.md), accepted decisions in [docs/architecture-decisions.md](docs/architecture-decisions.md), [docs/domain-and-architecture.md](docs/domain-and-architecture.md), [docs/interfaces-and-operations.md](docs/interfaces-and-operations.md), [docs/security-reliability.md](docs/security-reliability.md), [docs/testing-and-acceptance.md](docs/testing-and-acceptance.md), [docs/traceability.md](docs/traceability.md), [docs/roadmap.md](docs/roadmap.md), [docs/implementation-guide.md](docs/implementation-guide.md), then the examples and schemas.
- [docs/product-charter.md](docs/product-charter.md) and [docs/future-work.md](docs/future-work.md) are non-normative context and never settle a conflict.
- A conflict with a higher-authority document stops the active Task; record the conflict and resolve it in the Source of Truth before writing implementation code.
- Never let an implementation shortcut become product behavior without the material change process in [docs/sot-governance.md](docs/sot-governance.md).

## Roadmap And Task Lifecycle

- The active pointer section of [docs/roadmap.md](docs/roadmap.md) is the sole delivery-status authority: `Active Epic`, `Active Task`, `In Review Task`, and `Next eligible Task` live there and nowhere else.
- Task statuses are exactly `Planned`, `In Progress`, `In Review`, `Completed`, `Blocked`, and `Deferred`, case-sensitive, because the Aquarium roadmap hook matches them literally.
- At most one Task may be `In Progress` and at most one other Task may be `In Review`; the `In Review` Task must close before a third Task starts.
- Every commit goes through `$aquarium:task-commit` once a roadmap file is tracked, which runs the gate as `AQUARIUM_COMMIT_GATE=task-commit-v1 git commit ...`.
- The Reviewer is a separate AI session that runs the `task-review` phase of `$aquarium:task-handler`, which drives Mulgae against the completed Task target; the implementing session never reviews its own diff.

## Definition Of Done

- Definition of Done depends on the Task class, and the three classes are defined in [docs/sot-governance.md](docs/sot-governance.md).
- Chore: a deliverable whose text starts with `Chore:`, closed by the change plus one test or a recorded reason why a test does not apply, with no unresolved Source of Truth conflict.
- Standard: implementation, unit and integration tests, tested error paths, updated documentation and examples, an updated roadmap status, and a Reviewer confirmation.
- Contract: Standard plus a reviewed snapshot diff classified as breaking or non-breaking plus a recorded migration impact, required for every Task touching the protocol package, the CLI JSON contract, HTTP DTOs, the configuration schema, or a database migration.

## Verification

- `make test` is the single verification gate for code; it is created by `EPIC-001` and does not exist yet.
- `scripts/sot-check` verifies this document set and must pass in `make test-prepare`; it is also created by `EPIC-001`.
- Run the narrowest meaningful check first, then `make test` before asking for review; report every skipped check with its reason.

## Documentation Style

- Do not hard-wrap prose: one paragraph is one source line, and line breaks are used only where the Markdown structure needs them.
- Every relative link must resolve from the file that contains it.
- Documentation filenames use lowercase kebab case, and `AGENTS.md` and `README.md` are the only uppercase exceptions.
- Write prose, code, comments, tests, commit messages, and CLI text in English unless the user asks for another language.

## Safety Rules

- Never read, write, or delete the developer's real `~/.sorage`; every test and manual check points `SORAGE_HOME` at a temporary directory.
- Never run `git add`, `git commit`, or `git push` unless the user explicitly asks for that exact action, and never disturb unrelated staged, unstaged, or untracked changes.
- Never add a handler, skill, or file to Aquarium or to any other ecosystem repository; Sorage ships its own agent policy at `skills/use-sorage/SKILL.md`.

## Development Skill References

- Use `$aquarium:task-handler` for one named roadmap task, `$aquarium:epic-handler` for one roadmap epic, and `$aquarium:epic-validator` to cold-validate a completed epic.
- Use `$aquarium:task-commit` for every authorized commit and the `task-review` phase of `$aquarium:task-handler` for the Task review.
- Use `$aquarium:dev-setup` to diagnose or configure development tooling.
- Podway, Mulgae, Gaori, and Sanho are optional development tooling configured by `$aquarium:dev-setup`; none of them is required to build, test, or release Sorage.
- Use `$lore-commits` for non-trivial commit messages and `$lore-query` to inspect recorded decision context.
