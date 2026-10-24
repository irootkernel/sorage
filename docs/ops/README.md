# Operations

This runbook is for one local Sorage installation on Apple Silicon macOS. Sorage maintainers own the guidance here. The normative command and runtime contracts remain in [Interfaces and Operations](../specs/interfaces-and-operations.md) and take precedence over this runbook.

## Target and authority

The installation includes the local CLI, loopback-only daemon, macOS LaunchAgent, SQLite state, Artifact Vault, and optional Git backup. Run administrative commands only as the operating-system user who owns the installation. The `--as-user` flag records that the user approved the operation; it does not create an operating-system security boundary.

Do not expose authentication material or copy output containing secrets into an issue or runbook. Do not edit the managed Vault by hand. Tests and recovery drills must set `SORAGE_HOME` to a temporary directory instead of using the developer's real `~/.sorage`.

## Release-candidate verification

The commands below describe the published v0.1.2 packaging identity. The planned shared v0.1.3 release carries M8, M9 and the EPIC-017 Channel corrections together and requires the separate [M9 shared content upgrade and rollback procedure](#m9-shared-content-upgrade-and-rollback); a matching version string does not establish a matching build or storage contract.

Before publication, build and inspect the Apple Silicon macOS candidate from the reviewed checkout:

```sh
make package
cd dist
shasum -a 256 -c sorage-v0.1.2-darwin-arm64.sha256
codesign --verify --strict sorage-v0.1.2-darwin-arm64
./sorage-v0.1.2-darwin-arm64 version
```

The checksum file must contain the digest, two spaces, the asset basename, and one newline. The adjacent manifest must report version `0.1.2`, target `darwin-arm64`, binary `sorage-v0.1.2-darwin-arm64`, the same signed digest, signature mode `ad-hoc`, and the reviewed HEAD revision. `dist/sorage` must have the same signed digest so the source-install path and release candidate cannot diverge. These checks establish a local candidate only; they do not prove a hosted download, publication, notarization, Developer ID signing, or Gatekeeper behavior.

## Replace the withdrawn v0.1.2 binary

The corrected v0.1.2 distribution replaces the original dated 2026-09-29. Both report `sorage v0.1.2`; use the corrected Release's Git revision and signed SHA-256 to distinguish them. Stop active CLI writers and the daemon before replacing the installed executable, keep the Installation and Vault intact, and restart a configured service deliberately with the corrected binary after replacement. This correction requires no configuration, database, or Vault migration.

Download fresh copies of the binary, checksum, and manifest into an empty directory using the [README installation commands](../../README.md#install-v012). Verify the checksum and signature, compare the manifest's revision and signed digest with the corrected GitHub Release, and install with `install -m 0755`. Check the installed executable's SHA-256 against that same digest and confirm its version. A version-only update check cannot detect this replacement. Preserve existing Memo data; installations older than v0.1.2 still follow the separate [Memo upgrade and rollback procedure](#memo-storage-upgrade-and-rollback).

## Safe diagnosis

After any required upgrade preparation, start with diagnostic commands:

```sh
sorage version
sorage doctor
sorage daemon status
sorage vault status
sorage vault verify
sorage backup status
sorage backup verify
```

Record symbolic error codes and non-sensitive recovery hints. Do not record API tokens, browser session secrets, or raw secret-bearing logs.

## Local service lifecycle

Start or stop the foreground-managed daemon with `sorage daemon start` and `sorage daemon stop`. Install or refresh the login service on an existing installation with:

```sh
sorage init --reconfigure --install-service --non-interactive
```

After setup, `sorage daemon status` must report the expected installation identity, and `sorage doctor` must report no blocking service or daemon finding. If service setup fails, stop the daemon and run `sorage doctor` before retrying. Keep the Vault and database in place. Removing the LaunchAgent or the installation requires separate user approval.

## Recovery and escalation

Use `sorage backup verify` before a restore. Restore only into an empty installation with the daemon stopped, following the normative restore contract. `sorage uninstall --as-user --confirm` removes installation state but intentionally retains the Vault.

When a command refuses with `VAULT_INTEGRITY_ERROR` because the Vault cannot be opened, do not run `sorage vault verify` or plain `sorage init`: inspect the configured `vault.path` with `sorage config show`, confirm the Vault volume is mounted, and restore a verified backup into a fresh installation if the Vault is lost. Use `sorage init --reconfigure --non-interactive` only for an empty directory of a genuinely new installation after confirming the mount, and adopt a foreign Vault only by restoring it into a fresh installation through the audited restore command. If `sorage doctor` reports a configuration error, run `sorage config validate` and repair the reported keys before Vault work, or fix the owner-only permissions when the file or its home cannot be read at all; a live symlink to a regular `config.yaml` is followed on every surface, while a directory, a FIFO or another non-regular target, a dangling symlink, or a symlink loop at the path must be replaced with a regular file or a symlink to one rather than chmodded. Operational Channel, Handoff and Project commands refuse the unreadable and path-fault states with the same access or configuration-path repair, and `sorage init` refuses them instead of creating a new installation. Its `vault.marker` and checksum checks then carry the same Vault-open recovery, and its `vault.gitattributes` warning suggests reconfiguration only when the Vault opens, backfilling missing files or `.gitattributes` lines and naming a manual `.gitignore` edit for a missing `staging/` entry. Plain `sorage init` keeps its no-op result but warns instead of suggesting reconfiguration in these states.

Stop and contact the Sorage maintainers if diagnosis reports database corruption, an unsupported schema, Artifact corruption, an unresolved intent-log failure, or a non-empty restore target. Leave the affected home and Vault in place. Do not delete, rewrite, or manually adopt managed files.

## Memo storage upgrade and rollback

This section describes the published v0.1.2 transition from pre-Memo storage to schema 7 and format-2 backups. Its references to the new binary and writer mean that generation. The planned shared v0.1.3 release has a separate upgrade boundary below.

Before upgrading an installation from the pre-Memo database, stop old CLI writers, the daemon, and scheduled backup processes. Keep them stopped throughout the upgrade and prevent mixed-version writers afterwards. Use the old binary to produce and verify a pre-upgrade format-1 backup, retain that copy, and complete a restore drill into a separate empty temporary installation before replacing the binary. The migration appends Memo storage and preserves existing domain rows and valid operational receipts. Do not assume an old binary will safely reject the upgraded database.

Use explicit binary and installation paths so a rollback drill cannot select the live home by accident. Stop other CLI clients and external schedulers first; disable the built-in schedule and remote push before making the final manual backup. Record their previous settings with `config show --json` for an intentional later re-enable. If a LaunchAgent owns the daemon, stop that service with `launchctl bootout gui/$UID/xyz.rootkernel.sorage` before `daemon stop`; do not let it restart an old writer during the upgrade. The following template uses an already retained old binary and a local Vault path read from that installation's configuration. Replace every placeholder before running it. If the daemon is already stopped, `daemon stop` returns exit 69 / `DAEMON_UNAVAILABLE` with `no live daemon record was found`; confirm that no old daemon remains and continue without following its start suggestion. Stop on any other failure:

```sh
SORAGE_HOME="/absolute/live-home" /absolute/old-sorage config show --json
SORAGE_HOME="/absolute/live-home" /absolute/old-sorage backup disable --as-user
SORAGE_HOME="/absolute/live-home" /absolute/old-sorage backup disable-push --as-user
SORAGE_HOME="/absolute/live-home" /absolute/old-sorage daemon stop
SORAGE_HOME="/absolute/live-home" /absolute/old-sorage backup run --json
SORAGE_HOME="/absolute/live-home" /absolute/old-sorage backup verify --json
git clone --no-hardlinks "/absolute/live-vault" "/absolute/pre-upgrade-vault-copy"
SORAGE_HOME="/absolute/empty-rollback-home" /absolute/old-sorage init --vault "/absolute/empty-rollback-vault" --non-interactive
SORAGE_HOME="/absolute/empty-rollback-home" /absolute/old-sorage backup restore --from "/absolute/pre-upgrade-vault-copy" --dry-run --as-user
SORAGE_HOME="/absolute/empty-rollback-home" /absolute/old-sorage backup restore --from "/absolute/pre-upgrade-vault-copy" --confirm --as-user
SORAGE_HOME="/absolute/empty-rollback-home" /absolute/old-sorage vault verify --json
```

Inspect the restored Projects and Handoffs with the old binary in that separate home before replacing the live binary. Keep the pre-upgrade copy unchanged and keep the rollback daemon stopped. Start the new binary against the live home only after this drill, then run `sorage doctor`, inspect the expected data, and make and verify a new format-2 backup. Re-enable scheduling, push, or a service only deliberately with the new binary. The live upgraded installation and the restored rollback installation share the adopted identity; they are alternatives, not concurrent writers or a synchronization pair.

The new backup writer exports format 2, including a zero-Memo inventory when appropriate. Backup verify and restore dry-run validate Memo files, byte digests, ownership, and event history before a real restore imports them. A restore adopts the original Installation identity and restores Memo state but excludes operational receipts and browser recovery records. Reauthentication does not prove whether an earlier request executed. A retained request with an unknown outcome must not become an automatic new execution after restore.

Rollback uses the verified pre-upgrade format-1 backup in a fresh, separate home and Vault, with its daemon stopped. Set `SORAGE_HOME` explicitly for the separate installation, initialize it, run `sorage backup restore --from <pre-upgrade-vault-copy> --dry-run --as-user`, then run the same restore with `--confirm --as-user` instead of `--dry-run --as-user`. Keep the upgraded home intact; never downgrade its database in place or let the old writer overwrite its backups. Post-upgrade Memos are absent from the old backup, so preserve them with the new binary before switching installations. Automated recovery drills cover separate temporary homes and process restarts; real OS crash and power-loss testing requires a separate platform qualification.

User-requested backups contain current Memo titles and bodies. Workspace-path redaction does not sanitize arbitrary paths, secrets, or personal data typed into free text; account for that before enabling remote backup. Earlier Git commits may retain previous bodies. Marking a Memo done or dismissed does not erase that data, and M7 provides no Memo purge.

## M9 shared content upgrade and rollback

The planned shared v0.1.3 release carries M8, M9 and the EPIC-017 Channel corrections together under [ADR-0033](../architecture-decision-records/README.md#adr-0033-channel-adoption-hardening-and-the-shared-v013-release); the shared v0.1.3 release has not been published, so M9 has a release allocation but no published build. A locally packaged candidate may still print `0.1.2`, although published v0.1.2 predates shared content. Identify both executables by explicit paths, reviewed revisions and binary digests, not the version string alone. This upgrade is one-way for a v0.1.2 home: the published v0.1.2 binary cannot read the upgraded schema 7-through-11 database or a format-3 backup, so keep a verified pre-upgrade backup made with the matching old executable and restore it only with that executable into a fresh empty home and Vault. [Interface sections 38.7 and 38.8](../specs/interfaces-and-operations.md#387-migration-backup-and-supported-inventory) own the migration, supported inventory and breaking contract classification.

An M9 candidate's `preflight` can inspect an existing home without operational migration. Resolve any unsupported, unverifiable or recovery-required result before proceeding. A compatible or upgrade-required report does not establish that an external backup or restore drill happened. Do not replace the old executable's backup step with a new candidate's `doctor`, `backup run`, or domain command: diagnostics can configure WAL, and domain or backup startup can migrate the database before the backup.

Before replacing the executable, use the **old matching executable** for the final backup and its verification. Stop old CLI writers, the daemon, its LaunchAgent and external schedulers, and deliberately disable built-in scheduling and remote push as in the Memo procedure above. Retain the prior settings for deliberate re-enablement. Keep a separate immutable copy of the verified backup and its matching old executable, then use that executable to complete a dry-run and actual restore into a separate empty temporary home and Vault with explicit `SORAGE_HOME`. Inspect the restored domain data and verify its files before upgrading. Published v0.1.2 uses schema 7 and format 2; an earlier installation may require format 1. The planned v0.1.3 release applies schema 8 through 11 in order and writes format 3; schema 8 and format 3 appeared in retained development builds and are not a published v0.1.2 prerequisite.

Run the reviewed candidate's `preflight` against the intended home before replacing anything and require `upgrade_required`. After the old-binary backup and separate restore drill and the upgrade — the explicit migration step, `sorage backup run` once with the new executable inside the existing context in which scheduling and push are already disabled — run `preflight` again and require `compatible`; a `recovery_required`, `unsupported`, or `unverifiable` result stops the upgrade for a separate decision. `preflight` itself never migrates, and neither does any covered read.

The planned shared v0.1.3 M9 upgrade chains every owning migration in one pass: schema 8 adds the shared content store, schema 9 rebuilds Handoff body references, schema 10 rebuilds Memo body references, and schema 11 adds the Channel tables and their event association, so an upgrade from schema 7 applies 8 through 11 in order and preserves domain rows, exact body bytes, complete event ledgers, and raw receipt strings, including expired ones. After `preflight` reports `upgrade_required`, the covered read commands — Handoff `inbox`, `outbox`, `get`, `events` and `review show`, Memo `list` and `show`, Project `list` and `show` — do not migrate: each returns `STORAGE_MIGRATION_REQUIRED` with exit 78 until the explicit migration step, `sorage backup run` once with the new executable inside this context in which scheduling and push are already disabled, applies the pending batch; that step opens and migrates the database and changes no Handoff, Memo or Channel data, and `preflight` itself never migrates. `doctor` diagnoses the installed schema and can report pending migrations without applying them; it remains an operational diagnostic that can configure WAL, rather than a non-mutating preflight substitute. Normal command startup and restarts reuse the upgraded home without reapplying migrations already recorded in its ledger. To repeat the upgrade qualification itself, start from a fresh copy of a retained pre-upgrade state.

When rehearsing an upgrade or rollback on a copy of an existing installation, confine the copy first: a copied home's `config.yaml` still names its original Vault path, so retarget the copy's `vault.path` to the copied Vault by editing the copied configuration file before starting any CLI against it, because `config set` refuses to change the Vault binding by design. This relocation is a fixture-path change only; never rewrite database rows, bindings, ledgers, receipts, or expiry times to relocate a copy, and record the relocation separately from preserved business content. Give every rehearsal its own fresh home and Vault under your owned working area, pass an explicit `SORAGE_HOME` and `TMPDIR` for every invocation, and never point a rehearsal at the original home or Vault.

Keep every old writer away from the upgraded home and backup destination. Forward-schema refusal is qualified for guarded builds with an explicit known-schema inventory; it is not a safety guarantee for every historical published executable. Do not rely on an old binary to reject newer storage safely.

In the planned v0.1.3 release, the Handoff adoption adds schema 9 after the additive schema-8 foundation. It normalizes body references while preserving existing Handoff/Artifact ids, file keys and bytes, receipts, and pending operations; it does not repack old small files. The Vault marker and configuration schema remain unchanged. Newly accepted small text can have `storageKey: null`, so update string-only Handoff DTO consumers before using that build. Its format-3 backups include inline Handoff bodies; old public backup readers cannot consume this generation.

In the planned v0.1.3 release, the Memo adoption adds schema 10. Existing inline Memo bytes, identities, versions, actor metadata, events and embedded receipt strings survive the rebuild without repacking. New bodies above 65,536 UTF-8 bytes use immutable content files; original file-backed receipts retain references rather than another full body. The accepting `artifact.maxBytes` does not limit historical body reads or receipt output, and title-only updates need not resend an unchanged body. A newly supplied body, including one in a replay-only request, must still meet the current ingestion bounds. Format-3 backups carry selected current Memo files and their exact size/digest inventory, and refuse a committed body still awaiting activation. Run the normal drain/recovery path before trying that export again; copying a destination file by hand does not settle its intent.

Only after the old-binary backup and separate restore drill succeed, start the reviewed new executable against the intended home: `preflight` still reports `upgrade_required`, so run `sorage backup run` once, which applies the pending migrations and performs the Vault `.gitattributes` re-assertion the first backup commits, then confirm `preflight` reports `compatible`, and use that same new executable to run `doctor`, inspect expected data with the read commands, verify that backup with `backup verify`, and only then verify the Vault with `vault verify`. The order is required, not stylistic: an upgraded Vault still carries the pre-M9 `.gitattributes`, `vault verify` reports every missing or disordered policy line as a blocking finding and exits 1 until the lines are re-asserted, and the first `backup run` with the new executable performs that re-assertion and commits the corrected file ([Interfaces and Operations section 6.2](../specs/interfaces-and-operations.md#62-sorage-vault-verify)); `doctor` may report the expected `vault.gitattributes` warning until then, and a doctor warning is never itself repair authority. Re-enable service, scheduling or push deliberately only after these checks. The [qualification map](../implementation-tips/m9-shared-content-qualification.md#11-assembled-qualification-and-unified-migration-impact-task-110) records the unified migration impact of schemas 8 through 11 and the demonstrated upgrade and rollback checks.

Idempotency receipts survive an upgrade with their exact original strings, scopes, and expiry times. While a receipt is still eligible, recover an outcome-unknown operation only with its original key and exact original input and sender context through `--replay-only`, which returns the original outcome with `replayed: true`. An expired receipt, and a receipt absent after a restore, return the matching `*_REPLAY_UNAVAILABLE` refusal: the outcome stays unknown, and the refusal never authorizes an execute fallback, a replacement key, or a repeated external effect. Restore excludes operational receipts by design, so a preserved Installation identity after rollback does not resolve an earlier unknown request.

Rollback uses the retained pre-upgrade backup and its matching executable in a **fresh separate home and Vault**, with its daemon stopped. Keep the upgraded home intact; never downgrade its database in place or let an old writer overwrite post-upgrade backups. The restored installation adopts the original identity, so it and the upgraded installation are alternatives rather than concurrent writers. Data created after the retained backup is absent from rollback; preserve needed data with the new build before switching. Restore excludes operational receipts, browser recovery state and derived fetch-cache files. A preserved Installation identity therefore does not resolve an unknown request outcome or authorize redispatch with a new key. Physical power-loss and OS-crash recovery remain separate platform qualifications.

## Unknown Memo outcomes

Retain the UUID idempotency key and exact original operation, scope, input, version, Installation, and first-attempt time before submitting a recoverable mutation. For example, after losing the response to `sorage memo done <id> --expected-row-version <n> --idempotency-key <uuid> --json`, inspect only with that same command plus `--replay-only`. The server checks its 24-hour receipt retention at lookup; client time and unchanged Installation identity do not establish eligibility. A retained receipt is historical, so reread the Memo before another mutation. `MEMO_REPLAY_UNAVAILABLE` means unknown, including after a backup restore that contains the Memo but no receipt. It does not prove failure or authorize a replacement key, execute retry, or repeated external work. Missing original inputs or a different Installation require read-only investigation instead of reconstructed retries.

In the browser, an active unknown request blocks all new Memo writes in that tab across Project navigation and reload. Reads, draft editing, Handoff navigation, other tabs, and CLI remain available. Reauthenticate with `sorage web` when needed, then use `Inspect original request (replay-only)`; a later error or reauthentication alone never clears uncertainty. A storage read/write/validation failure keeps writes blocked and is shown explicitly.

To stop recovery, select `Abandon retry and continue` and confirm the warning: the original may already have committed or may finish later, the action neither cancels nor deletes server work, and submitting the same intent anew can duplicate effects. Only a successfully saved local replacement retires the active request and releases its gate. It retains a body-free notice with the original identity/key, operation, version, title and times, `outcome=unknown`, and `retryDisposition=abandoned`. Notices are passive and nonblocking; inspect or copy them for investigation. At 32 notices, explicitly remove an older browser-only notice before another abandonment; there is no silent eviction. Removing a notice changes no server outcome. Any later new mutation still needs a fresh explicit action, and an existing Memo must be reread first.

The active record temporarily contains the original body; passive notices omit it. Both use per-tab session storage, which supports same-tab reload but may be lost on tab closure, browser data removal, or browser restart. This temporary recovery material is excluded from backups and is distinct from durable server Memo storage. Local abandonment is not a new CLI command, a Memo state, or evidence of work completion.

## Planned shared v0.1.3 inspection and send recovery

[EPIC-014 and EPIC-015](../roadmap/README.md#epic-014-non-mutating-installation-preflight) define the inspection and recovery extension; the planned shared v0.1.3 release carries it together with M9 and EPIC-017 under ADR-0033. The published v0.1.2 release does not provide preflight or send --replay-only. A local candidate built from this repository can still report version 0.1.2; that version string is not publication and is not v0.1.3. Preflight remains unreleased until the intended v0.1.3 release. This section is preparation guidance for the adopted contracts, not an instruction to run unavailable commands or reopen a real installation with a newer writer.

Once released and qualified, select the intended home explicitly and use [preflight](../specs/interfaces-and-operations.md#36-installation-preflight-milestone-m8) before commands that could migrate or modify storage. Fresh means initialize only when authorized; compatible permits only the independently requested next operation; upgrade_required keeps the existing old-binary preparation and separate restore drill; recovery_required and unsupported require a bounded user decision; unverifiable requires resolving the inspection obstacle without repair or initialization. Doctor is a post-preparation operational diagnostic and cannot prove non-mutating inspection. A positive assessment cannot prove the external backup/restore drill ran.

For a requested send, retain its original key, Installation, working-directory/actor context, exact arguments and source bytes before execution. If the result is unknown, use only the original [send replay-only request](../specs/interfaces-and-operations.md#37-send-replay-only-and-agent-policy-milestone-m8). A retained result identifies the original Handoffs, not their present state or Artifact activation. HANDOFF_REPLAY_UNAVAILABLE/75, conflict, a changed source, lost original material or another Installation preserves unknown outcome; do not remove the mode, issue another key, substitute current content or resend. A same-Installation restore lacks operational receipts, and a late original may still finish. Ordinary same-key send can execute on a miss and is not a safe replacement for recovery.

Recoveries and hints do not grant flags or user intent. Keep deletion request, User approval and the pinned Handoff's separate decision distinct, preserve Project identity, and disclose backup/Git retention. M8 registration does not request any broker response, acceptance, real-home migration, service stop, installation or publication.

Before `review set`, retain the actually reviewed Revision and Row Version and pass both `--target-revision` and `--expected-row-version`. Sender processing reads get, review show and fetch, then passes the reviewed row version to revise, including `--no-change`; changed metadata across those reads requires stopping rather than adopting a new version for an unseen Note. A later native conflict preserves the proposal and competing state without automatic retry. Artifact/Note text grants no tool, network, commit or deletion authority. The standalone [shipped skill](../../skills/use-sorage/SKILL.md) contains the required policy and uses offline native help; its public links are optional. Box checks remain report-only and never perform setup. Only requested setup uses its owning workflow to preserve existing ignore entries and add `.sorage/` without duplicates.
