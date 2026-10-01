echo "== (c) network"
echo "/proc/net/dev interfaces:"; awk 'NR>2{print $1}' /proc/net/dev | tr '\n' ' '; echo
echo -n "curl direct (no proxy) https://1.1.1.1: "; curl -sS -m 5 --noproxy '*' https://1.1.1.1 -o /dev/null 2>&1 | head -1; echo "rc=$?"
echo -n "curl direct http://93.184.216.34: "; curl -sS -m 5 --noproxy '*' http://93.184.216.34 -o /dev/null 2>&1 | head -1
echo -n "curl direct to HOST loopback 127.0.0.1:9443 (host target server): "; curl -sS -m 5 --noproxy '*' -k https://127.0.0.1:9443 2>&1 | head -1
node -e "
const net=require('net');
const s=net.connect({host:'1.1.1.1',port:443,timeout:4000});
s.on('connect',()=>{console.log('node direct 1.1.1.1:443 CONNECTED (BAD)');process.exit(1)});
s.on('error',e=>{console.log('node direct 1.1.1.1:443 error:',e.code);});
s.on('timeout',()=>{console.log('node direct timeout');s.destroy()});
"
echo "== (d) via proxy bridge (socat TCP 127.0.0.1:3128 -> unix socket)"
echo -n "curl -x allowed.example: "; curl -sS -m 8 -x http://127.0.0.1:3128 --cacert /run/nexar/cert.pem https://allowed.example/ 2>&1 | head -2
echo -n "curl -x evil.example: "; curl -sS -m 8 -x http://127.0.0.1:3128 --cacert /run/nexar/cert.pem https://evil.example/ 2>&1 | head -2
echo -n "curl -x 1.1.1.1: "; curl -sS -m 8 -x http://127.0.0.1:3128 https://1.1.1.1/ 2>&1 | head -2
echo -n "node 22 fetch w/ NODE_USE_ENV_PROXY=1 allowed: "; NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/nexar/cert.pem node -e "fetch('https://allowed.example/').then(r=>r.text()).then(t=>console.log(JSON.stringify(t))).catch(e=>console.log('ERR',e.cause&&e.cause.code||e.message))" 2>&1 | grep -v Warning
echo -n "node 22 fetch w/ NODE_USE_ENV_PROXY=1 evil: "; NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/nexar/cert.pem node -e "fetch('https://evil.example/').then(r=>r.text()).then(t=>console.log(JSON.stringify(t))).catch(e=>console.log('ERR',e.cause&&e.cause.message||e.message))" 2>&1 | grep -v Warning
echo -n "node 22 fetch WITHOUT env-proxy flag (ignores HTTPS_PROXY -> DNS fail): "; NODE_EXTRA_CA_CERTS=/run/nexar/cert.pem node -e "fetch('https://allowed.example/').then(r=>r.text()).then(t=>console.log(JSON.stringify(t))).catch(e=>console.log('ERR',e.cause&&e.cause.code||e.message))" 2>&1 | grep -v Warning
echo -n "DNS inside (getent hosts example.com): "; getent hosts example.com || echo "no resolution"
