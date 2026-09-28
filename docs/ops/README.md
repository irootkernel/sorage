# Operations

This runbook is for one local Sorage installation on Apple Silicon macOS. Sorage maintainers own the guidance here. The normative command and runtime contracts remain in [Interfaces and Operations](../specs/interfaces-and-operations.md) and take precedence over this runbook.

## Target and authority

The installation includes the local CLI, loopback-only daemon, macOS LaunchAgent, SQLite state, Artifact Vault, and optional Git backup. Run administrative commands only as the operating-system user who owns the installation. The `--as-user` flag records that the user approved the operation; it does not create an operating-system security boundary.

Do not expose authentication material or copy output containing secrets into an issue or runbook. Do not edit the managed Vault by hand. Tests and recovery drills must set `SORAGE_HOME` to a temporary directory instead of using the developer's real `~/.sorage`.

## Release-candidate verification

Before publication, build and inspect the Apple Silicon macOS candidate from the reviewed checkout:

```sh
make package
cd dist
shasum -a 256 -c sorage-v0.1.2-darwin-arm64.sha256
codesign --verify --strict sorage-v0.1.2-darwin-arm64
./sorage-v0.1.2-darwin-arm64 version
```

The checksum file must contain the digest, two spaces, the asset basename, and one newline. The adjacent manifest must report version `0.1.2`, target `darwin-arm64`, binary `sorage-v0.1.2-darwin-arm64`, the same signed digest, signature mode `ad-hoc`, and the reviewed HEAD revision. `dist/sorage` must have the same signed digest so the source-install path and release candidate cannot diverge. These checks establish a local candidate only; they do not prove a hosted download, publication, notarization, Developer ID signing, or Gatekeeper behavior.

## Safe diagnosis

Start with read-only checks:

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

Stop and contact the Sorage maintainers if diagnosis reports database corruption, an unsupported schema, Artifact corruption, an unresolved intent-log failure, or a non-empty restore target. Leave the affected home and Vault in place. Do not delete, rewrite, or manually adopt managed files.

## Memo storage upgrade and rollback

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

## Unknown Memo outcomes

Retain the UUID idempotency key and exact original operation, scope, input, version, Installation, and first-attempt time before submitting a recoverable mutation. For example, after losing the response to `sorage memo done <id> --expected-row-version <n> --idempotency-key <uuid> --json`, inspect only with that same command plus `--replay-only`. The server checks its 24-hour receipt retention at lookup; client time and unchanged Installation identity do not establish eligibility. A retained receipt is historical, so reread the Memo before another mutation. `MEMO_REPLAY_UNAVAILABLE` means unknown, including after a backup restore that contains the Memo but no receipt. It does not prove failure or authorize a replacement key, execute retry, or repeated external work. Missing original inputs or a different Installation require read-only investigation instead of reconstructed retries.

In the browser, an active unknown request blocks all new Memo writes in that tab across Project navigation and reload. Reads, draft editing, Handoff navigation, other tabs, and CLI remain available. Reauthenticate with `sorage web` when needed, then use `Inspect original request (replay-only)`; a later error or reauthentication alone never clears uncertainty. A storage read/write/validation failure keeps writes blocked and is shown explicitly.

To stop recovery, select `Abandon retry and continue` and confirm the warning: the original may already have committed or may finish later, the action neither cancels nor deletes server work, and submitting the same intent anew can duplicate effects. Only a successfully saved local replacement retires the active request and releases its gate. It retains a body-free notice with the original identity/key, operation, version, title and times, `outcome=unknown`, and `retryDisposition=abandoned`. Notices are passive and nonblocking; inspect or copy them for investigation. At 32 notices, explicitly remove an older browser-only notice before another abandonment; there is no silent eviction. Removing a notice changes no server outcome. Any later new mutation still needs a fresh explicit action, and an existing Memo must be reread first.

The active record temporarily contains the original body; passive notices omit it. Both use per-tab session storage, which supports same-tab reload but may be lost on tab closure, browser data removal, or browser restart. This temporary recovery material is excluded from backups and is distinct from durable server Memo storage. Local abandonment is not a new CLI command, a Memo state, or evidence of work completion.
