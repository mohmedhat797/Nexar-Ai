import type { AddressInfo } from 'node:net';
import { createControlGatewayServer } from './server.js';

// The entry Desktop launches (bundled as CommonJS, no top-level await). Its only configuration is one
// JSON line on stdin, `{ endpoint }`; it prints one JSON line, `{ port }`, once it is listening, and
// exits when stdin closes (the parent is gone or stopped it). It holds no secret.
const MAX_CONFIG_BYTES = 4096;

function exit(code: number): never {
  process.exit(code);
}

let buffered = '';
let started = false;
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => exit(0));
process.stdin.on('close', () => exit(0));
process.stdin.on('error', () => exit(1));
process.stdin.on('data', (chunk: string) => {
  if (started) return;
  buffered += chunk;
  if (buffered.length > MAX_CONFIG_BYTES) exit(2);
  const end = buffered.indexOf('\n');
  if (end === -1) return;
  started = true;
  let endpoint: unknown;
  try {
    endpoint = (JSON.parse(buffered.slice(0, end)) as { endpoint?: unknown }).endpoint;
  } catch {
    exit(2);
  }
  if (typeof endpoint !== 'string' || endpoint === '') exit(2);
  const server = createControlGatewayServer({ endpoint });
  server.on('error', () => exit(1));
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
  });
});
