python3 - <<'PY'
import socket
for name in ('\0nexar-abs-test',):
    s=socket.socket(socket.AF_UNIX)
    try: s.connect(name); print("abstract unix socket on host: CONNECTED (BAD)")
    except Exception as e: print("abstract unix socket on host:", e)
PY
echo -n "ls /run: "; ls /run; echo -n "ls /run/WSL /init: "; ls /run/WSL /init 2>&1 | head -2
