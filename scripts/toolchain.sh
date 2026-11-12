#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
fail() { echo "toolchain: $*" >&2; exit 1; }
pin() {
  value=$(cat "$root/.$1-version") || fail "missing .$1-version"
  case "$value" in *[!0-9.]*|'') fail "invalid .$1-version: $value" ;; esac
  echo "$value" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "invalid .$1-version: $value"
  printf '%s' "$value"
}
bun_version=$(pin bun)
node_version=$(pin node)
bun_dir="$root/.toolchains/bun/$bun_version/bin"
node_dir="$root/.toolchains/node/$node_version/bin"
verify() {
  executable=$1 expected=$2
  [ -x "$executable" ] || fail "missing $executable; run make toolchain-install"
  actual=$("$executable" --version) || fail "cannot execute $executable"
  [ "${actual#v}" = "$expected" ] || fail "$executable: expected $expected, observed $actual"
}
install_one() {
  kind=$1 version=$2
  destination="$root/.toolchains/$kind/$version"
  if [ -e "$destination" ]; then
    verify "$destination/bin/$kind" "$version"
    return
  fi
  scratch=$(mktemp -d /tmp/sorage-toolchain.XXXXXX)
  scratch=$(CDPATH= cd -- "$scratch" && pwd -P)
  trap 'rm -rf "$scratch"' EXIT
  trap 'exit 1' HUP INT TERM
  case "$kind" in
    bun)
      archive=bun-darwin-aarch64.zip
      base="https://github.com/oven-sh/bun/releases/download/bun-v$version"
      ;;
    node)
      archive="node-v$version-darwin-arm64.tar.gz"
      base="https://nodejs.org/dist/v$version"
      ;;
  esac
  /usr/bin/curl --fail --location --retry 2 "$base/$archive" -o "$scratch/$archive"
  /usr/bin/curl --fail --location --retry 2 "$base/SHASUMS256.txt" -o "$scratch/checksums"
  expected=$(/usr/bin/awk -v name="$archive" '$2 == name || $2 == "*" name {print $1}' "$scratch/checksums")
  [ "${#expected}" = 64 ] || fail "missing or ambiguous checksum for $archive"
  actual=$(/usr/bin/shasum -a 256 "$scratch/$archive")
  [ "${actual%% *}" = "$expected" ] || fail "checksum mismatch for $archive"
  mkdir "$scratch/staged"
  if [ "$kind" = bun ]; then
    /usr/bin/unzip -q "$scratch/$archive" -d "$scratch/unpacked"
    mkdir "$scratch/staged/bin"
    cp "$scratch/unpacked/bun-darwin-aarch64/bun" "$scratch/staged/bin/bun"
    ln -s bun "$scratch/staged/bin/bunx"
  else
    /usr/bin/tar -xzf "$scratch/$archive" -C "$scratch"
    mv "$scratch/node-v$version-darwin-arm64/bin" "$scratch/staged/bin"
    mv "$scratch/node-v$version-darwin-arm64/lib" "$scratch/staged/lib"
  fi
  verify "$scratch/staged/bin/$kind" "$version"
  mkdir -p "$root/.toolchains/$kind"
  # A concurrent install must never merge into or overwrite an existing version.
  # Serialize publication so a failed copy never leaves a partial final version.
  lock="$root/.toolchains/$kind/.install-lock"
  mkdir "$lock" || fail "another $kind installation is in progress; retry after it finishes"
  trap 'rm -rf "$scratch"; rmdir "$lock"' EXIT
  [ ! -e "$destination" ] || fail "concurrent install at $destination; retry"
  stage=$(mktemp -d "$root/.toolchains/$kind/.stage.XXXXXX")
  trap 'rm -rf "$scratch" "$stage"; rmdir "$lock"' EXIT
  cp -R "$scratch/staged/." "$stage/"
  verify "$stage/bin/$kind" "$version"
  mv "$stage" "$destination"
  rmdir "$lock"
  rm -rf "$scratch"
  trap - EXIT HUP INT TERM
}
command=${1:-check}
[ "$#" -eq 0 ] || shift
if [ "$command" = install ]; then
  [ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || fail "installation supports macOS arm64 only"
  install_one bun "$bun_version"
  install_one node "$node_version"
  exit
fi
verify "$bun_dir/bun" "$bun_version"
export PATH="$bun_dir:$node_dir:$PATH"
cd "$root"
case "$command" in
  bun)
    # Dependency lifecycle scripts can invoke Node even when Bun installs them.
    if [ "${1:-}" = install ]; then verify "$node_dir/node" "$node_version"; fi
    exec "$bun_dir/bun" "$@"
    ;;
  node)
    verify "$node_dir/node" "$node_version"
    exec "$node_dir/node" "$@"
    ;;
  check|sync|script)
    exec "$bun_dir/bun" --no-install "$root/scripts/toolchain.ts" "$command" "$@"
    ;;
  *) fail "unknown command: $command" ;;
esac
