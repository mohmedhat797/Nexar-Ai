set -u
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
cd /tmp/nxlab/g
echo "### E3b: clone via file:// (upload-pack) instead of local object copy"
SECRET=$(git -C userrepo rev-parse secret-branch:secret.env)
rm -rf c-up; git clone -q --single-branch --branch main --no-tags file:///tmp/nxlab/g/userrepo c-up 2>&1
echo -n "file:// single-branch: secret blob present? "; (git -C c-up cat-file -e $SECRET 2>/dev/null && echo YES-LEAKED) || echo "no (good)"
echo -n "  object files in clone: "; find c-up/.git/objects -type f | wc -l
echo -n "--local single-branch: secret blob present? "; (git -C c-min cat-file -e $SECRET 2>/dev/null && echo YES-LEAKED) || echo no
echo
echo "### E4b: make .git its own mountpoint + ro-bind config/hooks/info"
git -C c-up remote remove origin; git -C c-up config core.hooksPath /dev/null
cd /tmp/nxlab
WT=/tmp/nxlab/g/c-up
NX_LATE="--bind $WT/.git /work/.git --ro-bind $WT/.git/config /work/.git/config --ro-bind $WT/.git/hooks /work/.git/hooks --ro-bind $WT/.git/info /work/.git/info" ./bwrap-profile.sh $WT /tmp/nxlab/run -- bash -c '
echo -n "git config core.fsmonitor: "; git config core.fsmonitor "sh -c evil" 2>&1 | head -1
echo -n "write .git/hooks/pre-commit: "; (echo x > /work/.git/hooks/pre-commit) 2>&1 | head -1
echo -n "mv .git .git.bak: "; (mv /work/.git /work/.git.bak) 2>&1 | head -1
echo -n "rm -rf .git: "; (rm -rf /work/.git) 2>&1 | head -1
echo -n "mv .git/config: "; (mv /work/.git/config /work/.git/config.bak) 2>&1 | head -1
echo -n "write .git/info/attributes: "; (echo "* filter=x" > /work/.git/info/attributes) 2>&1 | head -1
echo -n "write .git/config.worktree / extensions? "; (echo "[core]" > /work/.git/config.worktree && echo "writable (only read if extensions.worktreeConfig=true in config)") 2>&1 | head -1
echo "agent commit still works:"; echo hi > new.txt; git add new.txt; git -c user.name=agent -c user.email=a@x commit -qm "agent work" && git log --oneline | head -3
'
echo "host view after:"; ls -a $WT | tr '\n' ' '; echo; cat $WT/.git/config | tr '\n' ' '; echo
