import type { AddressInfo } from 'node:net';
import { createCallbackServer, type CallbackOutcome } from '@nexar/integration-openai-account';

// The loopback redirect target of one ChatGPT sign-in (bundled as CommonJS, launched like the control
// gateway). Its only input is one JSON line on stdin, `{ state, timeoutMs? }`. It binds 127.0.0.1 on an
// ephemeral port, prints `{ port }`, then prints exactly one line, `{ code, clientId }` or
// `{ error }`, and exits. It also exits when stdin closes or after at most ten minutes. It holds no
// token: the code it forwards is single-use and bound to a PKCE verifier only main knows.
const MAX_CONFIG_BYTES = 4096;
const MAX_LIFETIME_MS = 10 * 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{16,256}$/;

function exit(code: number): never {
  process.exit(code);
}

function print(value: unknown, then?: () => void): void {
  process.stdout.write(`${JSON.stringify(value)}\n`, then);
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
  let state: unknown;
  let timeoutMs: unknown;
  try {
    ({ state, timeoutMs } = JSON.parse(buffered.slice(0, end)) as {
      state?: unknown;
      timeoutMs?: unknown;
    });
  } catch {
    exit(2);
  }
  if (typeof state !== 'string' || !STATE.test(state)) exit(2);
  const lifetime =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_LIFETIME_MS)
      : MAX_LIFETIME_MS;
  const server = createCallbackServer({
    state,
    onOutcome: (outcome: CallbackOutcome) => print(outcome, () => exit(0)),
  });
  server.on('error', () => exit(1));
  setTimeout(() => print({ error: 'timeout' }, () => exit(0)), lifetime);
  server.listen(0, '127.0.0.1', () => {
    print({ port: (server.address() as AddressInfo).port });
  });
});
