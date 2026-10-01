set -u
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
G="git -c user.name=nexar -c user.email=nexar@nexar.invalid"
rm -rf /tmp/nxlab/g && mkdir -p /tmp/nxlab/g && cd /tmp/nxlab/g
echo "### E0: user's repo with a secret on another branch, a hook, and a remote"
git init -q -b main userrepo && cd userrepo
echo "app" > app.txt && $G add . && $G commit -qm base
git checkout -q -b secret-branch && echo "AKIA-FAKE-SECRET" > secret.env && $G add . && $G commit -qm "oops secret" && git checkout -q main
printf '#!/bin/sh\necho user-hook-ran\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
git remote add origin https://github.com/example/private.git
git config user.signingkey ABCDEF
cd ..
echo
echo "### E1: git worktree add -> .git file points at main repo's admin dir"
git -C userrepo worktree add -q -b nexar/task1 /tmp/nxlab/g/wt1 && cat wt1/.git && ls userrepo/.git/worktrees/wt1
echo "-- sandbox mounts ONLY the worktree (rw):"
cd /tmp/nxlab; mkdir -p run2
./bwrap-profile.sh /tmp/nxlab/g/wt1 /tmp/nxlab/run -- git status 2>&1 | head -2
echo "-- sandbox must also mount main .git (rw) -> what the agent sees:"
NX_LATE="--bind /tmp/nxlab/g/userrepo/.git /tmp/nxlab/g/userrepo/.git" ./bwrap-profile.sh /tmp/nxlab/g/wt1 /tmp/nxlab/run -- bash -c 'git branch -a | cat; echo "secret blob reachable:"; git show secret-branch:secret.env; echo "remote url:"; git config --get remote.origin.url; ls /tmp/nxlab/g/userrepo/.git/hooks | head -3; echo "can rewrite main branch ref?"; git update-ref refs/heads/main HEAD~0 && echo yes-writable'
