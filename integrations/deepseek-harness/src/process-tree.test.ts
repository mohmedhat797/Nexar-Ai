import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnRuntime } from './runtime-process.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

// A stand-in runtime that starts a long-lived "tool" subprocess (like a shell a DSH tool runs) and
// then ignores stdin EOF and SIGTERM, so only a process-group kill can clean everything up.
const RUNTIME = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(child.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

describe.skipIf(process.platform === 'win32')('runtime process tree', () => {
  it('stop() terminates subprocesses started by the runtime, not just the runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexar-dsh-tree-'));
    const script = join(dir, 'runtime.cjs');
    const pidFile = join(dir, 'grandchild.pid');
    writeFileSync(script, RUNTIME);
    const runtime = spawnRuntime(
      {
        binary: { command: process.execPath, args: [script, pidFile] },
        cwd: dir,
        stateDir: dir,
        env: { PATH: process.env['PATH'] ?? '' },
        patches: [],
      },
      join(dir, 'unused.patch.yml'),
    );
    expect(await waitFor(() => existsSync(pidFile), 5000)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    await runtime.stop(200);

    expect(await waitFor(() => !alive(grandchild), 3000)).toBe(true);
  }, 15_000);
});
