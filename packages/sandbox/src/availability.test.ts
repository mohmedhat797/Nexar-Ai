/* eslint-disable @typescript-eslint/require-await -- injected async seams in tests need no await */
import { describe, expect, it } from 'vitest';
import { checkSandboxAvailability, type ExecFn } from './availability.js';

const exists = (present: readonly string[]) => async (path: string) => present.includes(path);
const ok = (stdout = ''): Awaited<ReturnType<ExecFn>> => ({ exitCode: 0, stdout, stderr: '' });

describe('checkSandboxAvailability', () => {
  it('reports a missing bwrap without throwing', async () => {
    const result = await checkSandboxAvailability({ exists: exists([]), exec: async () => ok() });
    expect(result.available).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('rejects bubblewrap older than 0.8.0', async () => {
    const result = await checkSandboxAvailability({
      exists: exists(['/usr/bin/bwrap']),
      exec: async () => ok('bubblewrap 0.7.9\n'),
    });
    expect(result).toMatchObject({
      available: false,
      bwrapVersion: '0.7.9',
      bwrapPath: '/usr/bin/bwrap',
    });
    expect(result.detail).toContain('too old');
  });

  it('fails when the functional probe fails and reports its reason', async () => {
    const calls: (readonly string[])[] = [];
    const result = await checkSandboxAvailability({
      exists: exists(['/usr/bin/bwrap']),
      exec: async (_file, args) => {
        calls.push(args);
        return args[0] === '--version'
          ? ok('bubblewrap 0.9.0\n')
          : {
              exitCode: 1,
              stdout: '',
              stderr: 'bwrap: No permissions to create new namespace\nmore',
            };
      },
    });
    expect(result.available).toBe(false);
    expect(result.detail).toContain('No permissions to create new namespace');
    expect(result.detail).not.toContain('more');
    expect(calls[1]).toContain('--unshare-net');
    expect(calls[1]).toContain('/usr/bin/true');
    expect(calls[1]).not.toContain('socat');
  });

  it('succeeds and reports socat separately', async () => {
    const exec: ExecFn = async (_file, args) =>
      args[0] === '--version' ? ok('bubblewrap 0.9.0\n') : ok();
    const withSocat = await checkSandboxAvailability({
      exists: exists(['/usr/bin/bwrap', '/usr/bin/socat']),
      exec,
    });
    expect(withSocat).toMatchObject({
      available: true,
      bwrapVersion: '0.9.0',
      socatPath: '/usr/bin/socat',
    });
    const without = await checkSandboxAvailability({
      exists: exists(['/usr/local/bin/bwrap']),
      exec,
    });
    expect(without.available).toBe(true);
    expect(without.bwrapPath).toBe('/usr/local/bin/bwrap');
    expect(without.socatPath).toBeUndefined();
  });

  it('honours an explicit path and does not fall back to others', async () => {
    const result = await checkSandboxAvailability({
      bwrapPath: '/opt/bwrap',
      exists: exists(['/usr/bin/bwrap']),
      exec: async () => ok('bubblewrap 0.9.0\n'),
    });
    expect(result.available).toBe(false);
  });
});
