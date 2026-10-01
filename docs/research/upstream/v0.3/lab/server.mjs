import https from 'node:https'; import fs from 'node:fs';
https.createServer({ key: fs.readFileSync('/tmp/nxlab/target/key.pem'), cert: fs.readFileSync('/tmp/nxlab/target/cert.pem') },
  (q, r) => { r.end('hello from allowed upstream\n'); }).listen(9443, '127.0.0.1', () => console.error('[target] up'));
