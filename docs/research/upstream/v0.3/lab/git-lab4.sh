set -u
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
cd /tmp/nxlab/g
SECRET=$(git -C userrepo rev-parse secret-branch:secret.env)
rm -rf c-min2; git clone -q --no-hardlinks --single-branch --branch main --no-tags userrepo c-min2
echo -n "re-check path clone (--local, --single-branch): secret blob present? "; (git -C c-min2 cat-file -e $SECRET 2>/dev/null && echo "YES-LEAKED (all objects copied despite --single-branch)") || echo no
echo
echo "### E5: harvest: produce a patch from the agent-owned clone INSIDE a throwaway no-net sandbox, then apply on host"
WT=/tmp/nxlab/g/c-up    # has an agent commit + planted nothing; plant a malicious fsmonitor to prove harvest sandbox is harmless
cp -r $WT /tmp/nxlab/g/c-harvest; H=/tmp/nxlab/g/c-harvest
git -C $H config core.fsmonitor 'sh -c "id > /tmp/nxlab/PWNED2; echo"'
echo "evil" > $H/untracked-new.txt; mkdir -p $H/sub; echo '#!/bin/sh' > $H/sub/run.sh; chmod +x $H/sub/run.sh
rm -f /tmp/nxlab/PWNED2; mkdir -p /tmp/nxlab/out; rm -f /tmp/nxlab/out/*
BASE=$(git -C /tmp/nxlab/g/userrepo rev-parse main)
cd /tmp/nxlab
bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind $H /work --bind /tmp/nxlab/out /out --chdir /work --clearenv \
  --setenv PATH /usr/bin:/bin --setenv HOME /tmp --setenv GIT_CONFIG_GLOBAL /dev/null --setenv GIT_CONFIG_NOSYSTEM 1 \
  --setenv GIT_OPTIONAL_LOCKS 0 --setenv BASE $BASE \
  /bin/bash -c 'export GIT_INDEX_FILE=/tmp/idx GIT_OBJECT_DIRECTORY=/tmp/objs GIT_ALTERNATE_OBJECT_DIRECTORIES=/work/.git/objects; mkdir -p /tmp/objs; cp /work/.git/index /tmp/idx; git add -A . ; git diff --cached --binary --full-index $BASE > /out/task.patch; echo "patch bytes: $(wc -c < /out/task.patch)"; git diff --cached --raw $BASE | cut -c1-120' 2>&1 | head -8
echo -n "attacker fsmonitor executed on HOST during harvest? "; [ -f /tmp/nxlab/PWNED2 ] && echo YES || echo "no (ran only inside harvest sandbox, ro mount, no net)"
echo "-- patch file headers:"; grep -E '^(diff --git|new file mode|old mode|new mode)' /tmp/nxlab/out/task.patch
echo
echo "### E5b: host applies patch to a Nexar-owned worktree with hostile-patch checks"
cd /tmp/nxlab/g; rm -rf /tmp/nxlab/g/apply && git -C /tmp/nxlab/g/userrepo worktree add -q --detach /tmp/nxlab/g/apply $BASE
cd /tmp/nxlab/g/apply
git apply --check --index --whitespace=nowarn /tmp/nxlab/out/task.patch && git apply --index --whitespace=nowarn /tmp/nxlab/out/task.patch && echo "applied OK"
git -c core.hooksPath=/dev/null -c user.name=nexar -c user.email=nexar@nexar.invalid commit -q --no-verify -m "nexar: task result" && git log --oneline | head -2
echo "-- hostile patches:"
mk() { printf 'diff --git a/%s b/%s\nnew file mode 100644\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1 @@\n+x\n' "$1" "$1" "$1" > /tmp/nxlab/out/h.patch; }
for p in ".git/hooks/post-commit" "../escape.txt" "sub/../../escape2.txt" ".git/config" "sub/.git/config" ".gitmodules"; do mk "$p"; echo -n "$p -> "; git apply --check /tmp/nxlab/out/h.patch 2>&1 | head -1; echo "   (rc=${PIPESTATUS[0]})"; done
