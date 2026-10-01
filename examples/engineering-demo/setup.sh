#!/bin/sh
# Creates a fresh git repository from the template plus a Nexar config that points at it.
# Usage: examples/engineering-demo/setup.sh <empty-target-dir>
set -eu
if [ "$#" -ne 1 ]; then echo "usage: $0 <empty-target-dir>" >&2; exit 2; fi
here=$(cd "$(dirname "$0")" && pwd)
target=$1
mkdir -p "$target"
if [ -n "$(ls -A "$target")" ]; then echo "target must be empty" >&2; exit 2; fi
target=$(cd "$target" && pwd)
mkdir "$target/repo"
cp -R "$here/template/." "$target/repo/"
git -C "$target/repo" init -q -b main
git -C "$target/repo" add -A
GIT_AUTHOR_NAME=Owner GIT_AUTHOR_EMAIL=owner@example.invalid \
GIT_COMMITTER_NAME=Owner GIT_COMMITTER_EMAIL=owner@example.invalid \
  git -C "$target/repo" commit -q -m "chore: initial demo library"
sed "s#__REPO__#$target/repo#" "$here/nexar.config.template.json" > "$target/nexar.config.json"
echo "demo repository: $target/repo"
echo "config:          $target/nexar.config.json"
