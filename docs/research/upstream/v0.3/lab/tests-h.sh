echo -n "unshare -Ur: "; (unshare -Ur true && echo allowed) 2>&1 | head -1
echo -n "nested bwrap: "; (bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --unshare-all -- /bin/true && echo works) 2>&1 | head -1
echo -n "git status still works: "; git status --short | head -1; echo
echo -n "curl via proxy: "; curl -sS -m 5 -x http://127.0.0.1:3128 --cacert /run/nexar/cert.pem https://allowed.example/
echo -n "seccomp field: "; grep Seccomp: /proc/self/status
