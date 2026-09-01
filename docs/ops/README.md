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
shasum -a 256 -c sorage-v0.1.0-darwin-arm64.sha256
codesign --verify --strict sorage-v0.1.0-darwin-arm64
./sorage-v0.1.0-darwin-arm64 version
```

The checksum file must contain the digest, two spaces, the asset basename, and one newline. The adjacent manifest must report version `0.1.0`, target `darwin-arm64`, binary `sorage-v0.1.0-darwin-arm64`, the same signed digest, signature mode `ad-hoc`, and the reviewed HEAD revision. `dist/sorage` must have the same signed digest so the source-install path and release candidate cannot diverge. These checks establish a local candidate only; they do not prove a hosted download, publication, notarization, Developer ID signing, or Gatekeeper behavior.

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
