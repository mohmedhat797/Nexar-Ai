NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/nexar/cert.pem node -e "fetch('https://allowed.example/').then(r=>r.text()).then(t=>console.log(JSON.stringify(t)))" 2>&1 | head -4
echo ---; node --version; echo "ls /dev:"; ls /dev | tr '\n' ' '; echo; echo "mountinfo count: $(wc -l < /proc/self/mountinfo)"; cat /proc/self/mountinfo | awk '{print $5, $9}' | head -20
