echo -n "touch /x: "; (touch /x && echo "OK(writable root tmpfs)") 2>&1 | head -1
echo -n "touch /etc/x: "; (touch /etc/x && echo "OK(writable)") 2>&1 | head -1
echo -n "write /work: "; (touch /work/ok && echo OK) 2>&1|head -1
echo -n "write /tmp: "; (touch /tmp/ok && echo OK) 2>&1|head -1
echo -n "write ~: "; (touch ~/ok && echo OK) 2>&1|head -1
echo -n "nested unshare -Ur: "; (unshare -Ur true && echo allowed) 2>&1 | head -1
echo -n "nested bwrap: "; (bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --unshare-all -- /bin/true && echo works) 2>&1 | head -1
