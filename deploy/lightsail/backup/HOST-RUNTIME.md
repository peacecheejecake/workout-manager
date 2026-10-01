# Offline host runtime candidate for namespace DB preflight

This is a **candidate**, not an operating backup runner. It packages the existing
`namespace-db-preflight.mjs` and its `pg` dependency into one JavaScript file,
alongside a separately obtained Linux Node **24.12.0** executable. The host does
not run npm, pnpm, an installer fetched from the network, or a package lifecycle
script. Nothing in this procedure changes the database or starts a backup.

## Build on a trusted machine

1. Obtain the official `node-v24.12.0-linux-x64.tar.xz` or
   `node-v24.12.0-linux-arm64.tar.xz` **off the production host**. Verify the
   archive against the release's signed `SHASUMS256.txt` using a separately
   trusted Node.js release key. Extract its `bin/node`; record that binary's
   SHA-256. The packer requires this exact SHA-256 and checks the ELF machine
   type. The archive verification is an operator gate; the packer cannot prove
   the source of a caller-supplied checksum.
2. In a clean checkout of the reviewed commit, use Node 24.12.0 and
   `pnpm install --frozen-lockfile`. The packer requires workspace `pg` 8.23.0
   and local `esbuild` 0.28.2. Build into a new directory:

   ```sh
   node deploy/lightsail/backup/host-runtime-pack.mjs \
     /absolute/path/to/extracted/bin/node \
     <verified-bin-node-sha256> \
     /absolute/path/to/new/release-directory
   ```

The release directory contains `node`, `namespace-db-preflight.mjs`,
`manifest.json`, and `bundle-meta.json`. `manifest.json` records the Node binary,
bundle, source files, `pg` package identity, versions, and architecture. The
bundler rejects unbundled imports other than Node builtins. The optional native
PostgreSQL driver is replaced by a stub; the preflight uses the JavaScript `pg`
driver. Do not copy `bundle-meta.json` to the host. Publish the **manifest SHA-256**
with the reviewed release record through a channel independent of the artifact.
The release directory itself contains no passwords or fence configuration.

## Install from a verified local copy on the Linux host

Transfer only the three runtime files over the existing controlled deployment
channel to a root-only staging directory. Check the staged directory and all
parents for symlinks or non-root ownership (`namei -l`). Keep staging mode 0700.
The following commands are for an interactive root shell; fill in the two
independently reviewed values before running them. They never contact a network
service.

```sh
set -eu
umask 077
stage=/root/workout-host-runtime-stage
manifest_sha='REPLACE_WITH_REVIEWED_64_HEX_DIGEST'
release='REPLACE_WITH_REVIEWED_RELEASE_ID'
test "$(id -u)" -eq 0
case "$manifest_sha" in *[!a-f0-9]*|'') exit 1;; esac
test "${#manifest_sha}" -eq 64
case "$release" in *[!A-Za-z0-9._-]*|''|.|..) exit 1;; esac
test -f "$stage/manifest.json" && test ! -L "$stage/manifest.json"
test "$(sha256sum "$stage/manifest.json" | cut -d ' ' -f 1)" = "$manifest_sha"
test "$(jq -r .nodeVersion "$stage/manifest.json")" = 24.12.0
test "$(jq -r .pgVersion "$stage/manifest.json")" = 8.23.0
test "$(jq -r .architecture "$stage/manifest.json")" = "linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
test -f "$stage/node" && test ! -L "$stage/node"
test -f "$stage/namespace-db-preflight.mjs" && test ! -L "$stage/namespace-db-preflight.mjs"
test "$(sha256sum "$stage/node" | cut -d ' ' -f 1)" = "$(jq -r .nodeSha256 "$stage/manifest.json")"
test "$(sha256sum "$stage/namespace-db-preflight.mjs" | cut -d ' ' -f 1)" = "$(jq -r .bundleSha256 "$stage/manifest.json")"
install -d -o 0 -g 0 -m 0700 /srv/workout-manager/backup-runtime
target=/srv/workout-manager/backup-runtime/$release
mkdir -m 0700 "$target"
install -o 0 -g 0 -m 0700 "$stage/node" "$target/node"
install -o 0 -g 0 -m 0700 "$stage/namespace-db-preflight.mjs" "$target/namespace-db-preflight.mjs"
install -o 0 -g 0 -m 0600 "$stage/manifest.json" "$target/manifest.json"
test "$("$target/node" --version)" = v24.12.0
```

Use a fixed, reviewed `release` value containing only letters, digits, dots,
underscores, or hyphens; `mkdir` must fail if it already exists. Before these
commands, inspect `/srv/workout-manager` and `backup-runtime` ownership and
symlink status. The source file is installed as root-owned 0700 because the
preflight itself enforces that mode. Invoke it through its absolute Node path,
with the existing root-only fence config and PostgreSQL environment file. Do
not use a global `node` search path. Keep the release path fixed for one run;
do not swap a symlink while the preflight executes.

## Offline validation and limits

On the builder, run:

```sh
node --test deploy/lightsail/backup/host-runtime-pack.test.mjs
node --test deploy/lightsail/backup/namespace-db-preflight.test.mjs
```

Then verify the three shipped files against the independently recorded manifest
digest on a disposable Linux host of the same architecture. Run the installed
Node `--version`, import the bundle, and run the preflight against **only a
disposable PostgreSQL 17.6 instance with a dedicated fence fixture**. The
actual production preflight remains `not_executed` until the server has the
reviewed runtime, `wal_level=logical`, a fresh fence, and a separately approved
operational run. This candidate does not prove official Node provenance by
itself, PostgreSQL connectivity, backup durability, final tail, or restore.
