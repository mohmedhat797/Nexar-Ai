import { writeSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createControlGatewayServer } from '@nexar/integration-openai-compat';
import { formatGatewayExit, type GatewayExitPhase } from './exit-diagnostic.js';

// The entry Desktop launches (bundled as CommonJS, no top-level await). Its only configuration is one
// JSON line on stdin, `{ endpoint }`; it prints one JSON line, `{ port }`, once it is listening, and
// exits when stdin closes (the parent is gone or stopped it). It holds no secret.
//
// Before every non-zero exit it writes one diagnostic line to stderr (phase and a short code only, see
// exit-diagnostic.ts) so the supervisor can tell the exits apart. Exit codes: 0 stdin ended, 2 bad
// config, 1 anything else.
const MAX_CONFIG_BYTES = 4096;

function exit(code: number): never {
  process.exit(code);
}

function fail(code: 1 | 2, phase: GatewayExitPhase, error?: unknown): never {
  try {
    // Synchronous, so the line is out before the process ends; best effort if stderr is unusable.
    writeSync(2, `${formatGatewayExit(phase, error)}\n`);
  } catch {
    // Diagnostics must never change the exit.
  }
  exit(code);
}

process.on('uncaughtException', (error: unknown) => fail(1, 'uncaught', error));

let buffered = '';
let started = false;
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => exit(0));
process.stdin.on('close', () => exit(0));
process.stdin.on('error', (error: unknown) => fail(1, 'stdin', error));
process.stdin.on('data', (chunk: string) => {
  if (started) return;
  buffered += chunk;
  if (buffered.length > MAX_CONFIG_BYTES) fail(2, 'config');
  const end = buffered.indexOf('\n');
  if (end === -1) return;
  started = true;
  let endpoint: unknown;
  try {
    endpoint = (JSON.parse(buffered.slice(0, end)) as { endpoint?: unknown }).endpoint;
  } catch (error) {
    fail(2, 'config', error);
  }
  if (typeof endpoint !== 'string' || endpoint === '') fail(2, 'config');
  const server = createControlGatewayServer({ endpoint });
  server.on('error', (error: unknown) => fail(1, 'listen', error));
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
  });
});
