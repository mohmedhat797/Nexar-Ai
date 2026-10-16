import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { closeAndWait, startupTimings } from '../apps/desktop/e2e/startup-diagnostics.js';

describe('Desktop E2E startup diagnostics', () => {
  it('reports only bounded fixed phase timings, never arbitrary output or secrets', () => {
    const secret = 'provider-credential-must-not-be-printed';
    const output = [
      secret,
      `nexar-desktop: startup ${secret} 12ms`,
      `nexar-desktop: startup window 12ms ${secret}`,
      ...Array.from({ length: 50 }, (_, i) => `nexar-desktop: startup ready ${i}ms`),
    ].join('\n');
    const timings = startupTimings(output);
    expect(timings).toHaveLength(16);
    expect(timings.at(-1)).toBe('nexar-desktop: startup ready 49ms');
    expect(timings.join('\n')).not.toContain(secret);
  });

  it('waits for the actual process exit even when the automation close returns immediately', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.exit(0), 150));',
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    try {
      await closeAndWait(child, () => {
        child.stdin.end();
        return Promise.resolve();
      });
      expect(child.exitCode).toBe(0);
      expect(child.listenerCount('close')).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it('fails instead of allowing a relaunch while the old process is still alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      await expect(closeAndWait(child, () => Promise.resolve(), 50)).rejects.toThrow(
        'did not exit',
      );
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(child.listenerCount('close')).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill();
        await ended;
      }
    }
  });

  it('reclaims the process and preserves a failed automation close', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const failure = new Error('automation connection closed');
    await expect(closeAndWait(child, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.listenerCount('close')).toBe(0);
  });
});
