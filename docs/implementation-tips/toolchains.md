# Project toolchains

Exact execution versions are owned by `.bun-version` (product runtime and package manager), `.node-version` (development tools), and the exact `typescript` devDependency in `package.json` (compiler). Package support ranges and `tsconfig` targets do not select execution versions. `@types/bun` is a separate type-definition dependency. `bun.lock` records resolved dependencies, not interpreter selection.

## Setup and commands

Run these commands from the repository root on an Apple Silicon Mac:

```sh
make toolchain-install
make toolchain-sync
make deps
make toolchain-check
make help
```

Installation downloads only the declared official Bun and Node archives, verifies their published SHA-256 checksums, and installs them under ignored `.toolchains/<runtime>/<version>/`. It does not change shell profiles or global installations. Existing installations are verified and reused. Missing, damaged, or unavailable versions fail explicitly; ordinary execution never downloads an interpreter or falls back to a system version. Temporary installation files use unique physical `/tmp` directories and are removed after success or failure.

`make toolchain-check` prints declared and observed versions plus executable paths. `make toolchain-sync` derives `engines.bun` and `packageManager` from `.bun-version`; these fields are metadata mirrors, not independent authorities. `make deps` uses frozen installation; `make deps-lock` explicitly regenerates dependency-lock metadata after an intentional dependency change.

The existing build, package, test and check commands use the common launcher. Bun runs product compilation, packaging and repository scripts. Node runs Vitest, TypeScript and the Biome launcher. Local development packages must already be installed; executable lookup never downloads a missing compiler. Child processes inherit managed runtime paths. `BUN=...` is no longer a supported override. Direct build/package script execution outside the managed Bun fails before changing outputs.

`make test-prepare` installs frozen dependencies, checks tooling, automatically formats supported files with Biome, regenerates the Web embedding with `bun run build:web`, then checks lint, types, import boundaries, runtime cycles (`check:cycles`), dependency boundaries and documentation. `make test` includes this write step before tests, remains the complete ordered gate and packages once. `bun run format` runs the same automatic formatting separately; `bun run check:format` remains a read-only format check. Formatting failures stop the gate. Standalone tests retain their existing preparation requirements; package script names and additional arguments remain supported.

## Explicit upgrades

For Bun or Node, edit only its version file, then run `make toolchain-install`, `make toolchain-sync`, and `make toolchain-check`. For TypeScript, edit its exact devDependency, then run `make deps-lock`, `make deps`, and `make toolchain-check`. After updating `.bun-version`, run `bun run build:web` to regenerate the tracked browser assets with the new pin, then run `bun run build:web -- --check`. A Bun upgrade may require explicit lockfile regeneration if its lock format changes. Run focused failure-path checks followed by `make test` for the final candidate. Compatibility failures belong to that upgrade; the launcher does not substitute another version.

Current guidance references the version authorities instead of repeating their numbers. Historical qualification records retain the versions actually measured. No Go, Python, Rust, Ruby or Deno execution dependency is introduced. External Aquarium executables remain optional separately managed tools.
