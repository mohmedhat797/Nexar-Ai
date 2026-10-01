echo "== (e) git inside sandbox"
git --version; git status --short; echo "-- status clean? rc=$?"
echo "new" > feature.txt; git add feature.txt
git -c user.name=agent -c user.email=agent@nexar.invalid commit -qm "agent commit" && echo "commit OK"
git log --oneline | cat
git diff HEAD~1 --stat | cat
echo "-- remote ops:"; git remote add origin https://example.com/x.git; GIT_TERMINAL_PROMPT=0 git push origin main 2>&1 | head -3
echo "== escape attempts"
echo -n "pid1 comm: "; cat /proc/1/comm; echo -n "ls /proc/1/root: "; ls /proc/1/root | tr '\n' ' '; echo
echo -n "/proc/1/root/home: "; ls /proc/1/root/home | tr '\n' ' '; echo
echo -n "ls /proc/1/root/../../home: "; ls /proc/1/root/../../home 2>&1| tr '\n' ' '; echo
echo -n "readlink /proc/1/cwd: "; readlink /proc/1/cwd 2>&1
echo -n "visible pids: "; ls /proc | grep -E '^[0-9]+$' | wc -l
echo -n "write /proc/sys/kernel/hostname: "; (echo x > /proc/sys/kernel/hostname) 2>&1 | head -1
echo -n "mount tmpfs: "; (mount -t tmpfs none /mnt) 2>&1 | head -1
echo -n "caps: "; grep -E 'CapEff|CapBnd|NoNewPrivs|Seccomp:' /proc/self/status | tr '\n\t' '  '; echo
echo -n "unshare -U (nested userns, plain): "; (unshare -Ur true && echo allowed) 2>&1 | head -1
echo "== nested bwrap"
bwrap --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev --unshare-all --die-with-parent -- /bin/sh -c 'echo nested-bwrap-ran; id -u; cat /proc/self/status | grep CapEff' 2>&1 | head -5
