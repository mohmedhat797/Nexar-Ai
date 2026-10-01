// Tiny allowlisting HTTP CONNECT proxy listening on a UNIX socket (no TCP listener).
// Allowlist maps host:port -> upstream (test only: upstream is a local TLS server).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
const sock = process.argv[2];
const ALLOW = new Map([['allowed.example:443', { host: '127.0.0.1', port: 9443 }]]);
try { fs.unlinkSync(sock); } catch {}
const srv = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only\n'); });
srv.on('connect', (req, clientSock, head) => {
  const target = String(req.url).toLowerCase();
  const up = ALLOW.get(target);
  console.error(`[proxy] CONNECT ${target} -> ${up ? 'ALLOW' : 'DENY'}`);
  if (!up) { clientSock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const s = net.connect(up.port, up.host, () => {
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) s.write(head);
    s.pipe(clientSock); clientSock.pipe(s);
  });
  s.on('error', () => clientSock.destroy()); clientSock.on('error', () => s.destroy());
});
srv.listen(sock, () => { fs.chmodSync(sock, 0o600); console.error('[proxy] listening ' + sock); });
