import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSandboxedCoworkSession, type SandboxedCoworkOptions } from './sandboxed.js';
import { COWORK_PROFILE, CODING_PROFILE } from '../profiles.js';
import { makeLogger } from '../test/support.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
describe('sandboxed Cowork admission', () => {
  it('rejects a missing sandbox before preparation or any runtime spawn', async () => {
    const prepare = vi.fn();
    await expect(
      runSandboxedCoworkSession({
        launcher: { isolation: 'none', prepare },
        profile: COWORK_PROFILE,
        permissionMode: 'read-only',
      } as unknown as SandboxedCoworkOptions),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('rejects the Coding profile even if a launcher claims sandbox isolation', async () => {
    const prepare = vi.fn();
    await expect(
      runSandboxedCoworkSession({
        launcher: { isolation: 'sandbox', prepare },
        profile: CODING_PROFILE,
        permissionMode: 'read-only',
      } as unknown as SandboxedCoworkOptions),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(prepare).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')(
    'disposes a downgraded prepared launch, with no unrestricted retry',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'nexar-sec02-admission-'));
      dirs.push(root);
      const scratch = join(root, 'scratch'),
        home = join(root, 'home');
      await mkdir(scratch);
      await mkdir(home);
      const dispose = vi.fn().mockResolvedValue(undefined);
      const prepare = vi
        .fn()
        .mockResolvedValue({ isolation: 'none', workspacePath: '/work', dispose });
      await expect(
        runSandboxedCoworkSession({
          launcher: { isolation: 'sandbox', prepare },
          profile: COWORK_PROFILE,
          permissionMode: 'read-only',
          launch: { command: '/usr/bin/node', args: [], env: {} },
          scratchDir: scratch,
          scratchBase: root,
          dshHome: home,
          services: { dir: root, gateway: true, bridge: false },
          control: { baseURL: '', token: 'synthetic-token' },
          parentEnv: {},
          signal: new AbortController().signal,
          timeoutMs: 5000,
          logger: makeLogger(),
          nodeCommand: '/usr/bin/node',
          prompt: 'synthetic',
          decide: () => Promise.resolve('reject'),
        }),
      ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]?.[0]).toMatchObject({
        network: { mode: 'none' },
        env: { DSH_PERMISSION_MODE: 'read-only' },
      });
    },
  );
});
