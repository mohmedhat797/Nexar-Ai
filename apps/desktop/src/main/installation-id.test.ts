import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installationId } from './installation-id.js';

const ID = '00000000-0000-4000-8000-000000000001';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexar-install-id-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('installationId', () => {
  it('creates a random uuid once and reuses it', async () => {
    const first = await installationId(dir);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await installationId(dir)).toBe(first);
    expect(await installationId(dir, () => ID)).toBe(first);
    expect(JSON.parse(await readFile(join(dir, 'installation.json'), 'utf8'))).toEqual({
      id: first,
    });
  });

  it('lets concurrent first calls agree on one id', async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        installationId(dir, () => `00000000-0000-4000-8000-00000000000${String(n)}`),
      ),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('never replaces a damaged file and never echoes it', async () => {
    for (const text of ['not json', '{"id":"secret-sentinel"}', '{}', 'x'.repeat(2000)]) {
      await writeFile(join(dir, 'installation.json'), text);
      const error = await installationId(dir).catch((e: unknown) => e as Error);
      expect(error).toMatchObject({ code: 'CONFIGURATION_ERROR' });
      expect((error as Error).message).not.toContain('secret-sentinel');
      expect(await readFile(join(dir, 'installation.json'), 'utf8')).toBe(text);
    }
  });

  it('refuses a generator that does not produce a uuid', async () => {
    await expect(installationId(dir, () => 'hardware-id')).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR',
    });
  });
});
