import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handshake } from './handshake.js';
import { DSH_PINNED_VERSION } from './resource.js';
import { fakeBinary, makeTempDir, readRecord } from './test/support.js';

describe('handshake (fake runtime)', () => {
  it('performs initialize + shutdown only, with no prompt and no credentials', async () => {
    const dir = makeTempDir();
    const recordPath = join(dir, 'record.json');
    const info = await handshake({
      binary: fakeBinary({ record: recordPath }),
      cwd: dir,
      stateDir: join(dir, 'state'),
      env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'sk-secret-value' },
    });
    expect(info).toEqual({ name: 'deepseek-harness-sdk-runtime', version: DSH_PINNED_VERSION });
    const record = readRecord(recordPath);
    expect(record.requests.map((r) => r.method)).toEqual(['initialize', 'shutdown']);
    expect(record.envKeys).not.toContain('DEEPSEEK_API_KEY');
  });

  it('fails closed on a wrong identity', async () => {
    const dir = makeTempDir();
    await expect(
      handshake({
        binary: fakeBinary({ mode: 'wrong-identity' }),
        cwd: dir,
        stateDir: join(dir, 'state'),
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
  });
});

// Opt-in: talks to a real `dsh`, but only initialize + shutdown (no prompt, no model call).
describe.skipIf(!process.env.NEXAR_DSH_BIN)('handshake (real dsh)', () => {
  it('reports the real runtime identity and version', async () => {
    const dir = makeTempDir();
    const info = await handshake({
      binary: process.env.NEXAR_DSH_BIN as string,
      cwd: dir,
      stateDir: join(dir, 'state'),
      timeoutMs: 60_000,
    });
    expect(info.name).toBe('deepseek-harness-sdk-runtime');
    // Verified against dsh 0.2.0-rc.2: serverInfo.version is the SDK server plugin's own version
    // (e.g. '0.0.1'), not the CLI version, so only its presence is asserted here.
    expect(info.version).toMatch(/\S/);
  }, 90_000);
});
