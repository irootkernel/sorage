# Project lifecycle and binding replacement

This dossier records the execution details of `EPIC-012`. [ADR-0026](../architecture-decision-records/README.md) owns the decision, [required specification](../specs/required-specification.md) owns required behavior, and [the roadmap](../roadmap/README.md) alone owns delivery status.

## Implementation order

1. Adopt the M6 Source of Truth and AJ-19, including the explicit compatibility and migration classification.
2. Make Project archive and unarchive imply User provenance in the CLI and HTTP routes; gate new Project sends and receipts against archive state within the create transaction.
3. Add `project rebind` through the shared Project use case and one SQLite binding-row update with `PROJECT_BINDING_REBOUND`; refresh the optional derived inbox marker after commit.
4. Verify focused unit, integration, and contract scenarios, then run `make test` and request a separate Task review.

The CLI command accepts the recorded old binding path, including a vanished path shown by `project show`. The new directory must exist. A normalized no-op changes neither the database nor the event ledger. The command does not move Project files or rewrite historical path snapshots. Marker failures warn and leave the committed binding authoritative.
