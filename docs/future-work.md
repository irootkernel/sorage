# Future Work

None of these items are part of the MVP unless promoted through the material change control in [sot-governance.md](sot-governance.md).

This document is non-normative context: it records what was deliberately excluded and why, and it never overrides a normative document or settles a conflict.

## Aquarium handler integration

A handler inside the Aquarium repository that wraps Sorage is out of scope and is not merely unbuilt: that shape was explicitly rejected in Aquarium, recorded in its commit `56c297e` as a rejected alternative, and building it would require changing a repository Sorage must not change (GEN-011).

Interoperability in the MVP ships instead as the `use-sorage` skill at `skills/use-sorage/SKILL.md` in this repository (ADR-0018).

Should that position ever change, the integration must call the public `sorage` CLI or the local API, preserve Sorage actor and concurrency rules, and return every generated Handoff UUID; it must never create a second database, state machine, or Artifact workflow.

## Podway artifact attachment automation

The Podway `ExternalReference` artifact slot is the named seam today, and a session records a Handoff UUID there by hand.

A later automation could attach the reference at `send` time and resolve its current review state when the Podway session is inspected, which requires an agreed reference format and a stable resolution command, and still no source dependency in either direction.

## MCP adapter

Deferred until:

- CLI commands are stable.
- Local API DTOs are versioned.
- Domain permissions are validated.
- Error semantics are stable.
- Real AI usage patterns are observed.

Potential tools:

```text
list_inbox
list_outbox
get_handoff
fetch_artifact
create_handoff
set_review_note
withdraw_review_note
revise_handoff
accept_handoff
decline_handoff
withdraw_handoff
request_deletion
```

MCP must call the same application use cases, and the application layer stays free of MCP-specific types so the adapter can be added without a domain change (ADR-0007).

## Notifications

The MVP closes discovery with the `use-sorage` policy, `inbox --wait`, and the optional `handoff.inboxMarker` file, and nothing beyond those is in scope.

Possible later adapters:

- Local desktop notification
- Webhook
- Email
- Chat integration

Notifications derive from events and never become a source of truth.

## Browser-only administrative actions

Milestone 0.2 exposes the User-admin actions through both the CLI and the Web UI.

An option worth revisiting afterwards is restricting the most destructive of them, deletion approval and Review Note removal, to the browser, so they require a human at a screen rather than a flag any local process can pass.

The honesty clause applies either way: any process that can read the API token or run the CLI as this operating-system user can assert User context (SEC-013, SEC-021), so this is a friction control, not an isolation boundary.

## Web YAML editor

The MVP Web UI offers a read-only view of the canonical YAML file and typed configuration forms; a full editor is excluded (WEB-014).

Adding one later requires comment-preserving round-trip editing, schema validation before write, and ETag conflict handling that matches the Config Service exactly, which is why it is not a screen but a contract change.

## Web Vault relocation screen

Vault relocation inside the MVP uses `sorage vault move --to <path>` (WEB-016).

A dedicated Web screen would have to hold `vault-move.lock`, report progress on a long-running copy, and leave every other process failing cleanly with `SERVICE_PAUSED` while it runs.

## Artifact bundles

A future Handoff may carry a primary document plus attachments, which requires an explicit Artifact Bundle model and must not be simulated by a hidden directory copy.

## Native content history

Possible:

- Historical Artifacts
- Diff
- Revision restore
- Review Note history

Sorage retains only the current Artifact and a Revision counter, so a Revision replaced between two Git backups is not preserved anywhere (ADR-0003); removing that limit changes storage, deletion, and backup semantics and requires an accepted decision plus a migration.

## Deduplication

Fan-out stores independent copies, one per recipient, so each Handoff owns its bytes outright.

Content-addressed deduplication could reduce Vault size later while preserving independent logical ownership, at the cost of making deletion a reference-count problem.

## Search

Possible:

- Metadata full-text search
- Markdown content indexing
- Semantic search

Indexes must be rebuildable and non-authoritative.

## Additional backup providers

Possible:

- Encrypted backup
- Object storage
- Managed Git provider
- Snapshot archive

Any provider must keep the deterministic snapshot format and the checksum verification that `sorage backup restore` depends on.

## Policy controls

Possible:

- Retention periods
- Automatic archive
- Automatic deletion request
- Per-Project Artifact limits
- Sensitive-data labels
- Approval policies

Automatic deletion must never bypass User approval without an explicit Source of Truth change.

## Linux support

- XDG configuration and data directories
- systemd user service
- Linux file-manager reveal adapter
- Distribution packaging
- Filesystem behavior tests

Domain and protocol behavior should remain unchanged; the platform work sits behind `PlatformService` and the filesystem adapter.

## Multi-machine server mode

Expected concepts:

```text
User Account
Organization or Workspace
Machine
Installation
Project
Project Binding per Machine
Remote Artifact Store
Download Cache
Authentication and Authorization
TLS
Audit Retention
```

Remote mode must not expose server filesystem paths, and `fetch` either materializes locally or downloads a stream.

The seam that keeps this reachable is the CLI transport adapter: commands call a use-case interface, and satisfying it with an HTTP client instead of an in-process call is an adapter choice.
