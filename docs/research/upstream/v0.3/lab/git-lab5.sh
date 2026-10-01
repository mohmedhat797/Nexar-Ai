export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
cd /tmp/nxlab/g; rm -rf c-nl c-depth
git clone -q --no-local --single-branch --branch main --no-tags userrepo c-nl 2>&1
SECRET=$(git -C userrepo rev-parse secret-branch:secret.env)
(git -C c-nl cat-file -e $SECRET 2>/dev/null && echo "--no-local: secret LEAKED") || echo "--no-local single-branch: secret blob absent (good)"
echo -n "object files: "; find c-nl/.git/objects -type f | wc -l
git -C c-nl branch -a | cat
git clone -q --no-local --depth 1 --single-branch --branch main --no-tags userrepo c-depth && echo -n "depth1 log: " && git -C c-depth log --oneline | cat && echo -n "shallow file: " && head -1 c-depth/.git/shallow
git -C c-nl config --get-regexp 'remote|branch' | cat
