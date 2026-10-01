echo "== (a) filesystem"
echo -n "write /work: "; echo x > /work/created-in-sandbox.txt && echo OK
echo -n "write /usr: "; (touch /usr/x) 2>&1 | head -1
echo -n "write /etc: "; (touch /etc/x) 2>&1 | head -1
echo -n "write / : "; (touch /x) 2>&1 | head -1
echo -n "write /tmp: "; (echo y > /tmp/t && echo OK)
echo -n "write /run/nexar (ro): "; (touch /run/nexar/x) 2>&1 | head -1
echo "ls /home:"; ls /home
echo "ls /work/..: "; ls /work/.. | tr '\n' ' '; echo
echo -n "read host /tmp/outside-tmp.txt: "; cat /tmp/outside-tmp.txt 2>&1 | head -1
echo "== (b) home / secrets"
for p in /home/nxtest/.ssh/id_rsa /home/nxtest/outside.txt /root/.ssh /root /etc/shadow /etc/passwd /tmp/nxlab; do echo -n "cat $p: "; (cat $p 2>&1 | head -1); done
echo -n "ls ~: "; ls -A ~ | tr '\n' ' '; echo
echo -n "find / -name id_rsa: "; find / -xdev -name 'id_rsa*' 2>/dev/null | head; echo "(end)"
