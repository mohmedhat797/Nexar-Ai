set -u
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
G="git -c user.name=nexar -c user.email=nexar@nexar.invalid"
cd /tmp/nxlab/g
echo "### E3: per-task clone variants"
git clone -q --local userrepo c-local 2>&1; echo -n "--local default: object link count "; stat -c %h $(find c-local/.git/objects -type f | head -1)
git clone -q --no-hardlinks userrepo c-nolinks 2>&1; echo -n "--no-hardlinks: object link count "; stat -c %h $(find c-nolinks/.git/objects -type f | head -1)
git clone -q --shared userrepo c-shared 2>&1; echo "--shared alternates file:"; cat c-shared/.git/objects/info/alternates; echo -n "  own objects (count of files): "; find c-shared/.git/objects -type f | wc -l
echo "hooks in no-hardlinks clone (user's pre-commit copied?):"; ls c-nolinks/.git/hooks | grep -v sample | tr '\n' ' '; echo "(none above = not copied)"
echo "branches in --no-hardlinks clone (default):"; git -C c-nolinks branch -a | cat
git clone -q --no-hardlinks --single-branch --branch main --no-tags userrepo c-min 2>&1
echo "branches in --single-branch clone:"; git -C c-min branch -a | cat; echo "secret object present in c-min? "; (git -C c-min cat-file -e $(git -C userrepo rev-parse secret-branch:secret.env) 2>&1 && echo YES-LEAKED) || echo no
echo "c-min config:"; cat c-min/.git/config
git -C c-min remote remove origin; git -C c-min config core.hooksPath /dev/null; git -C c-min config advice.detachedHead false
echo "c-min config after hardening:"; cat c-min/.git/config
echo
echo "### E4: agent plants core.fsmonitor in .git/config; HOST later runs 'git status' there"
rm -f /tmp/nxlab/PWNED
cp -r c-min c-evil; git -C c-evil config core.fsmonitor 'sh -c "id > /tmp/nxlab/PWNED; echo"'
git -C c-evil status >/dev/null 2>&1; echo -n "host git status in agent-owned repo executed attacker command? "; [ -f /tmp/nxlab/PWNED ] && echo "YES: $(cat /tmp/nxlab/PWNED)" || echo no
rm -f /tmp/nxlab/PWNED
echo "-- with sandbox ro-binding .git/config and .git/hooks, agent cannot plant it:"
cd /tmp/nxlab; ./bwrap-profile.sh /tmp/nxlab/g/c-min /tmp/nxlab/run -- bash -c 'git config core.fsmonitor "sh -c evil" 2>&1 | head -2; echo "rc=$?"' 
NX_LATE="--ro-bind /tmp/nxlab/g/c-min/.git/config /work/.git/config --ro-bind /tmp/nxlab/g/c-min/.git/hooks /work/.git/hooks --ro-bind /tmp/nxlab/g/c-min/.git/info /work/.git/info" ./bwrap-profile.sh /tmp/nxlab/g/c-min /tmp/nxlab/run -- bash -c '
echo "[ro-bound variant]"; git config core.fsmonitor "sh -c evil" 2>&1 | head -2
echo -n "write .git/hooks/pre-commit: "; (echo "#!/bin/sh" > /work/.git/hooks/pre-commit) 2>&1 | head -1
echo -n "mv .git .git.bak: "; (mv /work/.git /work/.git.bak) 2>&1 | head -1
echo -n "rm -rf .git/config: "; (rm -f /work/.git/config) 2>&1 | head -1
echo "agent commit still works:"; echo hi > new.txt; git add new.txt; git -c user.name=agent -c user.email=a@x commit -qm "agent work" && git log --oneline | head -3
'
