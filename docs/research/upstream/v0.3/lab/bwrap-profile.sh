#!/usr/bin/env bash
# Nexar plane sandbox profile (lab version). usage: bwrap-profile.sh <worktree> <proxy-sock-dir> -- cmd...
# NX_EARLY / NX_LATE inject extra bwrap args for experiments only.
set -euo pipefail
WT=$1; SOCKDIR=$2; shift 3
exec bwrap \
  ${NX_EARLY:-} \
  --unshare-user --unshare-ipc --unshare-pid --unshare-net --unshare-uts --unshare-cgroup \
  --die-with-parent --new-session --cap-drop ALL \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin \
  --ro-bind /opt/node22 /opt/node22 \
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/alternatives /etc/alternatives \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home/agent \
  --bind "$WT" /work \
  --ro-bind "$SOCKDIR" /run/nexar \
  --remount-ro / \
  ${NX_LATE:-} \
  --chdir /work \
  --clearenv \
  --setenv PATH /opt/node22/bin:/usr/local/bin:/usr/bin:/bin \
  --setenv HOME /home/agent --setenv TMPDIR /tmp --setenv LANG C.UTF-8 \
  --setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_GLOBAL /dev/null --setenv GIT_TERMINAL_PROMPT 0 \
  --setenv HTTPS_PROXY http://127.0.0.1:3128 --setenv HTTP_PROXY http://127.0.0.1:3128 \
  --setenv NODE_USE_ENV_PROXY 1 \
  -- /bin/bash -c 'socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/nexar/proxy.sock & exec "$@"' bash "$@"
