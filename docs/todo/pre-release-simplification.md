# Pre-release simplification

## Purpose and delivery boundary

Master requested this cleanup before the shared v0.1.3 release on 2026-10-28. [EPIC-020 and its four Tasks](../roadmap/README.md#epic-020-pre-release-simplification) are the delivery authority. [ADR-0036](../architecture-decision-records/README.md#adr-0036-pre-release-simplification-and-proportionate-verification) proposes the implementation and verification decisions; TASK-135 must adopt them in their canonical owners before the later Tasks use them. This dossier defines the intended work and acceptance, not current runtime behavior or execution evidence.

The outcome is easier maintenance and less repeated verification work while preserving the existing product contract. Remove structures and assertions whose protection no longer justifies their cost, reuse resources within the existing command composition, and keep the complete final gate. Use the existing repository tools and evidence locations.

The review baseline was `3d119da8faddbb008b6674e1e7d7d08cdaba50ad`. Findings below are source observations at that revision, not measured latency or independently reproduced data-corruption defects. Recheck only affected facts if the implementation baseline moves.

## 1. Scope and preserved behavior

| Included | Boundary |
|---|---|
| Verification and review cadence | Focused checks and review for an affected change, reusable applicable evidence, one complete gate on the final integrated implementation candidate |
| Obsolete repository structure | Empty `apps/web`, its package-only references, the unused literal `UnitOfWork.run` scanner, and assertions that unnecessarily freeze presentation or scaffolding |
| Handoff command composition | Reuse an existing or command-owned database within the current factories; make ownership and failure cleanup explicit |
| Build and test entrypoints | Separate routine compiled E2E execution from release-specific distribution checks without reducing the complete `make test` aggregate |
| Current guidance | Correct obsolete architecture descriptions and overstated checker guarantees; point to canonical behavior instead of restating it |

Preserve Handoff/Memo/Channel domain boundaries; current-Revision reading versus acceptance versus processing; the single retained comment and active-request projection; required caller observations; exact original-receipt replay; atomic events; conflict and rollback behavior; security/path checks; zero-write reads; SQLite/Vault intent recovery; schema 12 and snapshot format 4 with supported legacy readers; and existing public CLI/HTTP/MCP/Web behavior. An accidental contract change is a defect to correct within this scope, not permission to update a golden and accept it.

### Explicit exclusions

- No new validator framework, automatic change-impact scorer, evidence database, generic dependency-injection container, connection pool, transaction framework, or review layer.
- No new acceptance-journey number, fixed-count model campaign, mandatory replacement test for every deleted assertion, or test-count target.
- No broad CLI, content-store, backup, MCP, or frontend rewrite; no new Web framework or build pipeline.
- No removal of legacy public commands, supported migration steps, backup readers, native runtime checks, or safety mechanisms merely because they are complex.
- No weakening of NFR-015's hard-wrap and relative-link rules. Documentation style checks do not justify unrelated runtime reruns.
- No product version bump, installation, global registration, consumer-repository edit, commit, push, or publication in this planning registration.

## 2. Evidence and proposed disposition

| Observation at the review baseline | Proposed disposition | Owning Task |
|---|---|---|
| `scripts/check-import-boundaries.ts` scans the literal `UnitOfWork.run`; production uses other transaction boundaries, including typed `runInTransaction`. Its dedicated fixture manufactures the scanned name. | Remove the obsolete scanner, its exclusive synthetic tests, and the unsupported guarantee; keep real dependency guards and transaction behavior checks. | TASK-135 / TASK-136 |
| `apps/web/src/index.ts` exports only `WEB_STUB`; the actual Web assets are daemon-served. A workspace test requires all five package manifests. | Remove the unused package and only the layout/configuration assertions that preserve it. Keep the actual Web build, serving and browser checks. | TASK-135 / TASK-136 |
| Review ports compose read ports, which compose send ports; each opens again when no database is injected. Terminal, revision and retention add another open. | Reuse one database in each applicable command composition and build only the required resources. This is not a global singleton and does not merge read/write admission paths. | TASK-137 |
| `make test-prepare` always installs; `test-e2e` always packages; the package script intentionally compiles twice for reproducibility. A reporting integration suite separately compiles its binary. | Reduce redundant repeated preparation, while preserving the two independent reproducibility builds and every executable consumer's preparation requirement. | TASK-138 |
| Governance requires the full code gate before review; TASK-120 even required it for a runbook-only correction. Recent reporting qualification already reused evidence after prose-only changes. | Give that bounded reuse an explicit current policy instead of relying on inconsistent exceptions. | TASK-135 |
| Some Channel documentation assertions fix bullet counts and presentation forms as well as command validity. | Keep command/option/schema/link/example validity and remove only presentation constraints with no required product meaning. | TASK-136 |
| Current guidance retains Preact/five-package wording, incomplete observation guidance and ambiguous Note-clearing wording; SOT descriptions overstate what the script checks. | Correct current guidance and link to the interface section-40 matrix. Preserve accurately labeled historical records. | TASK-135 |

The default CLI factory chain opens two connections for read ports, three for review ports and four for terminal/revision/retention ports at this baseline. The daemon's injected database avoids those repeated opens. This count describes source composition, not measured performance, connection exhaustion, or a demonstrated corruption failure.

## 3. Authority adoption and execution order

Follow TASK-135 through TASK-138 in roadmap order. TASK-135 is a documentation-only adoption boundary. Its acceptance must settle the relevant accepted ADRs and canonical guidance together; later implementation must not use this dossier to override an unamended higher-authority rule.

TASK-135 adds dated amendments to ADR-0013 for the literal UnitOfWork/lint claim and ADR-0016 for the obsolete five-package/Preact prescription. Preserve their transaction, toolchain and dependency-direction decisions. Reconcile ADR-0019's governance wording only where the adopted cadence requires it, and preserve ADR-0023's release distribution guarantees. Preserve prior acceptance history rather than rewriting historical decisions as if the new policy always applied.

The adoption must align `AGENTS.md`, `docs/README.md`, governance, architecture, security-reliability, testing-and-acceptance and implementation guidance. NFR-016 keeps `make test` as the complete aggregate; focused commands are partial checks, never mislabeled as the full gate. Use explicit transition wording: policy adoption enables scoped verification; package and Makefile descriptions remain accurate about the implementation until their owning cleanup Tasks land.

The first Task uses the bounded documentation-only verification exception adopted by ADR-0033 and defined in [governance section 18](../governance/README.md#18-pre-release-simplification-registration-boundary); its acceptance records why runtime tests do not apply. Later Tasks keep their required independent review, scoped to the changed behavior and relevant failure paths. This Epic adds no reviewer tier or fixed number of repeated reviews. Reuse a prior review for unchanged evidence and review the material delta. An external workflow requirement must be reconciled through its existing supported scope/waiver route, or recorded as a concrete remaining constraint; Sorage documentation does not modify another repository's skills.

## 4. Task boundaries and acceptance

### TASK-135: Adopt proportionate verification and reconcile current guidance

Adopt or refine ADR-0036 and its dated amendments. State the focused/full-gate policy, evidence reuse and invalidation rules, meaningful review scope, and the preserved safety boundary. Correct current Preact/stub descriptions, writer-observation guidance, active request versus retained comment terminology, and claims about SOT/schema/error-table checking. Reconcile the obsolete UnitOfWork/lint guarantee across security-reliability, architecture, testing and ADR-0013 with the actual synchronous transaction implementation and its type, test and review guarantees; preserve NFR-014's real import-direction guard. In traceability, distinguish reverse-index checking from generation if current prose attributes generation to the read-only checker. Replace duplicated behavioral prose with links where that reduces drift.

Do not claim the package or scanner has already been removed. The current implementation can be described accurately while its approved replacement remains assigned to TASK-136. Keep future-work refactors outside this Epic.

Acceptance: `bun run check:sot` and `git diff --check` exit 0; changed documentation satisfies the existing formatting rules; independent review confirms that the authority chain agrees on when focused checks suffice, when evidence is invalidated and who owns the final full gate. Before completion, record in the existing handoff the verified supported Aquarium execution/review route, where focused checks and unchanged evidence are accepted, which repeated runs may be omitted or remain mandatory, and the reuse/invalidation conditions. Resolve conflicts with later Task gates through existing supported mechanisms before TASK-136 relies on the policy. Describe concrete execution differences without a new evidence format or timing campaign. The bounded TASK-135 exception in governance section 18 authorizes this documentation-only gate; an expanded candidate falls back to the existing code gate and applicable classification. No code, schema, golden, toolchain or executable changes are included.

### TASK-136: Remove obsolete scaffolding and brittle assertions

Remove `apps/web` after confirming it has no runtime consumer, and reconcile the workspace/lockfile, TypeScript and import-boundary configuration and documentation references that depended on the placeholder. Keep the daemon's actual Web assets and their consumers unchanged.

Remove the unused literal UnitOfWork scanner and only its exclusive tests. Retain actual import/dependency direction checks, strict typechecking, transaction tests and the existing toolchain/version guards. Reduce documentation-layout/count assertions only where the same required command, schema, link or example correctness remains protected. Preserve fixed counts or ordering that actually belong to a public contract. Do not remove entire skill/resource suites on the assumption that all prose-adjacent tests are redundant.

Acceptance: frozen dependency resolution remains valid after the workspace removal; format, lint, typecheck, version, import/dependency and SOT checks pass. Run the relevant existing preparation-gate, workspace and copied-resource/catalogue tests and a focused compiled Web serving/browser check. Confirm the actual Web asset is still bundled and served. Reuse existing behavior coverage; add a narrowly focused test only for a concrete uncovered risk. There is no extra per-Task full-suite requirement after TASK-135 adoption.

### TASK-137: Reuse database resources within Handoff command composition

Before changing command-port composition, identify each affected command's connection acquisition owner, normal command/process lifetime and release responsibility, and construction-failure cleanup. Use the existing `NodeHandoffCommandPortsOptions.database` injection seam and command-port composition. Acquire an owned database once where operational access is actually required, pass it to subordinate factories, and avoid constructing send-only resources merely to obtain shared project/clock/id components.

An injected database remains borrowed: sub-factories must not close it, reopen it writable or migrate it. Preserve the existing normal lifetime where it is sufficient, without a new lifecycle framework. A metadata read with a supplied covered-read connection must retain that exact read-only admission; a path that needs no database must not begin opening one.

Sharing a connection must not introduce nested transactions, leave an unclosed transaction after refusal, move filesystem work into a transaction, or change commit/rollback boundaries, preparation/drain behavior, emitted events, receipt replay, error precedence, post-commit warnings or stale-observation semantics. Preserve the daemon's existing injected connection and its lifetime.

Acceptance: representative review/comment, accept/terminal, revision and retention calls use the same intended connection within their composition; construction failure releases only resources owned by that construction, and a borrowed connection remains usable. Relevant existing real-SQLite, CLI and HTTP checks cover rollback, conflicts, replay, read settlement and contention. Covered-read tests prove unchanged zero-write behavior and no operational reopening. Observe connection reuse through a bounded test seam or focused runtime observation; do not create a benchmark campaign or connection-count framework. No public DTO, schema, snapshot or golden change is expected.

### TASK-138: Separate routine E2E from release preparation and qualify the result

Map the existing consumers of `dist/sorage`, versioned assets, checksum and manifest before changing targets. Before changing entrypoints, specify the documented standalone integration, routine E2E and full-gate commands, their execution order and who prepares any required executable. Routine E2E must prepare a current compiled executable from the selected source and may omit only release-specific distribution qualification. Release checks must use the selected signed, versioned candidate and its matching metadata; missing artifacts fail instead of silently skipping. If a normal build withdraws old release metadata, preserve that protection.

Keep `make test` as the complete aggregate: frozen dependency/toolchain preparation, unit, integration, contract, applicable E2E and AJ-16 against the signed candidate. A failed stage still stops later stages, including under parallel make. Keep independent double-build reproducibility comparison, ad-hoc signature verification, checksum/manifest binding, supported-target checks and actual candidate execution. Arrange shared execution within that aggregate so packaging or whole suites are not repeated without distinct qualification purpose.

Use existing Make/package-script/test-config mechanisms for a documented routine path. Keep frozen installation in clean setup, dependency-change validation and final qualification; it need not run before every unchanged-dependency focused check. Inspect integration tests that compile their own executable as well as shared build consumers. Remove a test's compile step only when another explicit preparation step supplies a current-source executable to each affected documented entrypoint, including standalone integration and the complete gate; otherwise retain it for that distinct purpose. Do not introduce a build cache, fingerprint database, new test runner or source-executed substitute for compiled/native coverage.

Acceptance: the documented commands and preparation order cover standalone integration, routine E2E and the complete gate. Affected standalone integration consumers and routine E2E work from absent local build outputs with current-source executables; routine E2E performs no release-only signing/reproducibility work, and the release path refuses missing/mismatched artifacts and includes AJ-16. Reuse relevant Make ordering/failure tests and add only necessary behavior coverage for changed entrypoints. On the final integrated TASK-135-to-TASK-138 implementation candidate, run the complete `make test` successfully, including packaging and all layers, and review the resulting delta. Record the source/candidate identity and actual commands without new fixed test counts or retrospective claims. Promote lasting decisions into existing canonical owners, prepare the Epic closeout handoff, and retire this dossier at closeout.

## 5. Proportionate verification and evidence reuse

The policy below is to be adopted by TASK-135, not silently activated by this planning file.

| Change | Focused verification and review |
|---|---|
| Explanatory prose, links, status-only closeout | Changed text/links, SOT and diff checks; confirm no normative or executable change |
| Test-only correction | Run the affected test and examine why its expectation is valid; broaden if it changes the behavior being protected |
| Local implementation refactor | Relevant unit/integration checks, failure paths and independent delta review |
| Shared connection, transaction, build or test entrypoint | Cross-boundary checks selected from the existing suites; include real runtime behavior the aliases cannot establish |
| Final integrated implementation candidate | Complete `make test` with the signed-candidate release checks; TASK-138 owns this result |

For each Task, use the existing report or handoff to record the changed behavior/boundaries, selected commands and outcomes, reused evidence and why it remains applicable, and concrete remaining limits. A short record is sufficient; no new evidence schema, mandatory ledger or artifact generator is required.

One successful final full-gate result may satisfy the overlapping Task/Epic/release-readiness checks for the same candidate. Documentation-only closeout after that run needs its relevant document checks, not another full run. A later change invalidates evidence that depends on it: rerun affected checks, and repeat the complete gate if shared behavior, executable composition, toolchain/dependency changes or an unresolved cross-boundary risk makes the integrated result unreliable. An earlier green run is not evidence for changed code merely because it is in the same Epic.

A failure is not waived by calling it baseline. Establish whether it predates this work, resolve failures introduced by this Epic, and report any unresolved condition against the actual acceptance gate. Final acceptance still requires its stated gate to pass unless a separately authorized scope decision changes that gate.

## 6. Safety and qualification limits

All runtime checks use temporary `SORAGE_HOME` and Vault fixtures and preserve the real installation. Retain native Bun and compiled-executable checks where `test/aliases/bun-sqlite.ts` cannot represent the relevant behavior. Repository fixture isolation and meaningful Make failure-propagation tests remain useful.

The prior EPIC-019 qualification is identified evidence, not a new run on this cleanup candidate. Reuse applicable migration/restore and independent skill observations when their source, executable or guidance dependencies remain unaffected. Connection/admission changes require their affected regression checks; they do not automatically require another live model campaign or clean-OS installation. A new upgrade/rollback drill is necessary only when this change invalidates the relevant existing evidence or the applicable release contract requires it.

Do not claim latency improvement without measurement. The resource-allocation reduction and removed maintenance obligations are observable acceptance outcomes; a new numeric performance target is outside scope.

## 7. Completion and handoff

The resulting repository should describe its actual packages, enforce real dependency and product boundaries, compose Handoff resources without redundant database initialization, offer a straightforward routine test path, and retain a complete release gate. Public behavior and persistent data remain governed by their existing contracts.

The roadmap alone records Task and Epic lifecycle. Completion of this cleanup is a prerequisite of the intended shared v0.1.3 release, not authorization to change the product version, install, activate consumers or publish. At Epic closeout, move lasting information into its canonical owner, replace the roadmap's Detailed SOT link with Canonical Outcomes links, and remove the TODO entry. Repoint every other inbound reference to a lasting canonical document or the Epic anchor before deleting this temporary dossier.
