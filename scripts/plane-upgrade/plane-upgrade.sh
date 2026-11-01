#!/bin/sh
# Side-by-side upgrade of an installed Nexar Plane, with a verified rollback.
# See docs/guides/plane-upgrade.md. Reads names, modes and owners of owner state, never its contents.
#
#   plane-upgrade.sh prepare <bundle> <sha>   as the Plane user: build the release beside the old one
#   plane-upgrade.sh activate <sha>           as root: switch launcher and runtime, verify, or undo
#   plane-upgrade.sh rollback                 as root: return to the recorded previous installation
#   plane-upgrade.sh status                   as anyone: what is installed
set -eu
umask 022

OWNER=nexar
OWNER_HOME=/home/$OWNER
RELEASES=$OWNER_HOME/src/releases
DSH_LINK=/opt/dsh
DSH_RELEASES=/opt/dsh-releases
STATE=/var/lib/nexar-plane
LAUNCHER=/usr/local/bin/nexar
NODE=/usr/local/bin/node
OWNER_STATE=".nexar .codex .claude validation"
export PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin

fail() {
  echo "plane-upgrade: $1" >&2
  exit 1
}

valid_sha() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$' || fail 'the commit must be a full 40-character id'
}

require_root() {
  [ "$(id -u)" = 0 ] || fail 'run this step as root'
}

require_idle() {
  if pgrep -f 'main\.js (plane|cowork|mcp) ' >/dev/null 2>&1; then
    fail 'a Plane process is running; close Nexar first'
  fi
}

# Path, type, mode and owner only. Names of state files are kept in a root-only directory.
fingerprint() {
  for name in $OWNER_STATE; do
    [ -e "$OWNER_HOME/$name" ] || continue
    find "$OWNER_HOME/$name" -xdev -printf '%y %m %u %p\n'
  done | LC_ALL=C sort
}

assert_state_kept() {
  fingerprint >"$STATE/after.list"
  lost=$(LC_ALL=C comm -23 "$STATE/before.list" "$STATE/after.list" | wc -l)
  rm -f "$STATE/after.list"
  [ "$lost" = 0 ] || fail "$lost owner state entries were lost or changed mode or owner"
}

verify() {
  runuser -u "$OWNER" -- "$NODE" "$1/scripts/plane-upgrade/verify.mjs" "$1"
}

set_dsh_link() {
  ln -sfn "$1" "$DSH_LINK.next"
  mv -T "$DSH_LINK.next" "$DSH_LINK"
}

write_launcher() {
  {
    echo '#!/bin/sh'
    echo "# Owner-installed plane launcher: the Nexar build in ~/src and this plane's own config."
    # shellcheck disable=SC2016
    echo ': "${NEXAR_CONFIG_PATH:=/home/nexar/validation/nexar.config.json}"'
    echo 'export NEXAR_CONFIG_PATH'
    echo "exec $NODE $1/apps/cli/dist/main.js \"\$@\""
  } >"$LAUNCHER.next"
  chown root:root "$LAUNCHER.next"
  chmod 755 "$LAUNCHER.next"
  mv -T "$LAUNCHER.next" "$LAUNCHER"
}

restore_previous() {
  [ -f "$STATE/previous/launcher" ] && [ -f "$STATE/previous/dsh-target" ] ||
    fail 'no previous installation is recorded'
  set_dsh_link "$(cat "$STATE/previous/dsh-target")"
  cp -p "$STATE/previous/launcher" "$LAUNCHER.next"
  mv -T "$LAUNCHER.next" "$LAUNCHER"
}

prepare() {
  [ "$(id -un)" = "$OWNER" ] || fail "run this step as $OWNER"
  bundle=$1
  sha=$2
  valid_sha "$sha"
  dest=$RELEASES/$sha
  [ ! -e "$dest" ] || fail 'this release already exists'
  mkdir -p "$RELEASES"
  git clone -q --no-checkout "$bundle" "$dest.partial"
  git -C "$dest.partial" checkout -q --detach "$sha"
  [ "$(git -C "$dest.partial" rev-parse HEAD)" = "$sha" ] || fail 'the bundle gave another commit'
  (
    cd "$dest.partial"
    pnpm install --frozen-lockfile --prefer-offline >/dev/null
    pnpm build >/dev/null
    "$NODE" scripts/install-dsh-runtime.mjs "$PWD/.nexar/dsh-runtime" >/dev/null
  )
  mv -T "$dest.partial" "$dest"
  echo "prepared $sha"
}

activate() {
  require_root
  sha=$1
  valid_sha "$sha"
  release=$RELEASES/$sha
  runtime=$release/.nexar/dsh-runtime/node_modules
  [ -f "$release/apps/cli/dist/main.js" ] && [ -d "$runtime/@deepseek-ai/dsh" ] ||
    fail 'prepare this release first'
  require_idle
  # Recording the running release as "previous" would lose the way back.
  if grep -qF "$release/" "$LAUNCHER"; then fail 'this release is already active'; fi
  [ -e "$DSH_LINK" ] || fail "$DSH_LINK is missing"
  version=$("$NODE" -p "require('$runtime/@deepseek-ai/dsh/package.json').version")

  mkdir -p "$STATE/previous" "$DSH_RELEASES"
  chmod 700 "$STATE"
  fingerprint >"$STATE/before.list"
  cp -p "$LAUNCHER" "$STATE/previous/launcher"

  target=$DSH_RELEASES/$version
  if [ ! -e "$target" ]; then
    mkdir -p "$target.partial/lib" "$target.partial/bin"
    cp -a "$runtime" "$target.partial/lib/node_modules"
    ln -s ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$target.partial/bin/dsh"
    chown -R root:root "$target.partial"
    chmod -R go-w "$target.partial"
    mv -T "$target.partial" "$target"
  fi

  if [ -L "$DSH_LINK" ]; then
    readlink -f "$DSH_LINK" >"$STATE/previous/dsh-target"
  else
    # First upgrade: the old runtime moves whole, so a rollback gets back what was there.
    prior=$("$NODE" -p "require('$DSH_LINK/lib/node_modules/@deepseek-ai/dsh/package.json').version")
    [ ! -e "$DSH_RELEASES/$prior" ] || fail 'the previous runtime version is already in the releases'
    echo "$DSH_RELEASES/$prior" >"$STATE/previous/dsh-target"
    mv -T "$DSH_LINK" "$DSH_RELEASES/$prior"
    ln -s "$DSH_RELEASES/$prior" "$DSH_LINK"
  fi

  if ! { set_dsh_link "$target" && write_launcher "$release" && verify "$release" && (assert_state_kept); }; then
    echo 'plane-upgrade: verification failed; restoring the previous installation' >&2
    restore_previous
    exit 1
  fi
  echo "$sha" >"$STATE/active"
  echo "active $sha"
}

rollback() {
  require_root
  require_idle
  restore_previous
  assert_state_kept
  dsh --version
  runuser -u "$OWNER" -- "$LAUNCHER" sandbox selftest >/dev/null
  rm -f "$STATE/active"
  echo 'rolled back'
}

status() {
  echo "launcher: $(sed -n 's/^exec .* \(\/[^ ]*main\.js\).*/\1/p' "$LAUNCHER")"
  echo "dsh: $(readlink -f "$DSH_LINK") ($(dsh --version))"
}

case "${1:-}" in
  prepare) [ $# = 3 ] || fail 'prepare <bundle> <sha>'; prepare "$2" "$3" ;;
  activate) [ $# = 2 ] || fail 'activate <sha>'; activate "$2" ;;
  rollback) [ $# = 1 ] || fail 'rollback'; rollback ;;
  status) [ $# = 1 ] || fail 'status'; status ;;
  *) fail 'use prepare, activate, rollback or status' ;;
esac
