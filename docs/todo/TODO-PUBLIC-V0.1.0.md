# Public v0.1.0 release

## Roadmap ownership

- **Adopted Epic:** `EPIC-009`
- **Canonical roadmap:** [../roadmap/README.md](../roadmap/README.md)

## Goal

Turn the completed internal MVP work into Sorage's first public release. Before publishing, provide a README for users, contributor documentation with clear owners, one public version identity, an MIT license, and a directly downloadable Apple Silicon macOS binary.

## Scope and approach

`TASK-076` moves the documentation into the canonical single-scope role tree and separates the public README from maintainer documentation.

`TASK-077` renames the internal milestones to `M1`, `M2`, and `M3`; sets every public product-version surface to `0.1.0`; adopts the release and license choices; and prepares architecture-specific release assets.

`TASK-078` verifies the exact reviewed revision and publishes it as GitHub Release `v0.1.0`.

## Required actions

- Preserve committed Epic and Task identifiers and completed delivery history.
- Keep Source of Truth version `0.4.0` distinct from public product SemVer.
- Publish only an Apple Silicon macOS binary in the first release.
- Attach the binary, SHA-256 checksum, and manifest to the GitHub Release.
- Verify the downloaded published asset in an isolated temporary `SORAGE_HOME` before closing the Epic.
- Obtain separate authorization for commit, push, tag replacement, official tag creation, and GitHub Release publication.

## Prohibited actions

- Do not publish internal milestone tags.
- Do not claim Intel macOS, Linux, Homebrew, notarization, or Developer ID support.
- Do not create or modify a Homebrew tap or another ecosystem repository.
- Do not test against or mutate the developer's real `~/.sorage`.

## Acceptance

The release is accepted when the documentation inspector and repository verification gate pass, every public version surface reports `0.1.0`, and the release assets identify `darwin-arm64` and match their checksums. The MIT license must name RootKernel. The binary downloaded from the hosted `v0.1.0` release must also complete the documented isolated installation journey.
