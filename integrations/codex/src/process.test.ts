import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcess, type ProcessOutcome } from './process.js';

const fakeCodex = fileURLToPath(new URL('./test/fake-codex.mjs', import.meta.url));

describe.skipIf(process.platform !== 'win32')('Windows process trees', () => {
  it.each(['abort', 'timeout'] as const)(
    'kills the leader and grandchild on %s without relying on child PATH',
    async (reason) => {
      const directory = await mkdtemp(join(tmpdir(), 'nexar-windows-tree-'));
      const pidfile = join(directory, 'pid');
      const record = join(directory, 'record.json');
      const controller = new AbortController();
      let leaderPid: number | undefined;
      let pending: Promise<ProcessOutcome> | undefined;
      try {
        pending = runProcess({
          command: process.execPath,
          args: [
            fakeCodex,
            '--fake-mode=hang',
            `--fake-pidfile=${pidfile}`,
            `--fake-record=${record}`,
          ],
          cwd: directory,
          env: { PATH: join(directory, 'missing') },
          stdin: 'test',
          timeoutMs: reason === 'timeout' ? 1500 : 10000,
          signal: controller.signal,
          spawnImpl: spawn,
          onLine: () => undefined,
          killGraceMs: 200,
        });
        let grandchild: number | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            grandchild = Number(await readFile(pidfile, 'utf8'));
            if (grandchild > 0) break;
          } catch {
            // Wait until the fake executable has created its child.
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(grandchild).toBeGreaterThan(0);
        const invocations = JSON.parse(await readFile(record, 'utf8')) as { pid: number }[];
        leaderPid = invocations[0]?.pid;
        expect(leaderPid).toBeGreaterThan(0);
        if (reason === 'abort') controller.abort();
        expect((await pending).kind).toBe(reason === 'abort' ? 'aborted' : 'timeout');
        expect(() => process.kill(grandchild ?? 0, 0)).toThrow();
        expect(() => process.kill(leaderPid ?? 0, 0)).toThrow();
      } finally {
        controller.abort();
        await pending;
        if (leaderPid !== undefined) {
          try {
            execFileSync(
              join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/pid', String(leaderPid), '/t', '/f'],
              { windowsHide: true, stdio: 'ignore', timeout: 5000 },
            );
          } catch {
            // The run already removed its tree.
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    10000,
  );
});
