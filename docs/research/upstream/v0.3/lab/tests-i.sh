echo -n "DSH-style nested bwrap (--ro-bind / / --dev --unshare-pid --proc --die-with-parent --tmpfs /tmp --bind /work /work): "
(bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /work /work -- sh -c 'touch /work/nested-ok && echo works; touch /usr/x 2>&1 | head -1') 2>&1 | head -3
echo -n "landlock ABI via syscall 444: "
python3 - <<'PY'
import ctypes
libc=ctypes.CDLL(None,use_errno=True)
r=libc.syscall(444,None,0,1)
print(r if r>=0 else "errno=%d"%ctypes.get_errno())
PY
