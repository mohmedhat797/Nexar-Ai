import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const main = fileURLToPath(new URL('../../apps/cli/dist/main.js', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'nexar-e2e-'));

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

// Needs `pnpm build` first; skipped on a fresh checkout.
describe.skipIf(!existsSync(main))('built CLI, offline', () => {
  it('runs a task on the echo resource', () => {
    const result = spawnSync(process.execPath, [main, 'run', '--kind', 'general', 'e2e'], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('[echo:local-echo] e2e\n');
    expect(result.stderr).toContain('outcome=succeeded');
  });
});
