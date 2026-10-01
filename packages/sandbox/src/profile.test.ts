import { describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { buildBwrapArgs, PROXY_BRIDGE_SCRIPT, type BwrapProfileInput } from './profile.js';

const base: BwrapProfileInput = {
  workspace: '/data/ws',
  workspaceAccess: 'read-write',
  protectGit: true,
  toolchainPaths: ['/opt/node22'],
  mounts: [{ hostPath: '/data/cred', sandboxPath: '/home/agent/.cred', access: 'read-only' }],
  runDir: '/tmp/nexar-sbx-abc',
  network: 'proxy',
  env: { ZED: '1', ALPHA: '2', PATH: '/usr/bin' },
  command: '/usr/bin/agent',
  args: ['--flag', "va'lue; rm -rf /"],
};

function indexOfSeq(args: readonly string[], ...seq: string[]): number {
  for (let i = 0; i + seq.length <= args.length; i += 1) {
    if (seq.every((item, j) => args[i + j] === item)) {
      return i;
    }
  }
  return -1;
}

describe('buildBwrapArgs', () => {
  const args = buildBwrapArgs(base);

  it('spells every namespace explicitly and never uses the shortcut or -try forms', () => {
    for (const flag of [
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-net',
      '--unshare-uts',
      '--unshare-cgroup',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain('--unshare-all');
    expect(args).not.toContain('--share-net');
    expect(args.filter((a) => /^--unshare-.*-try$/.test(a))).toEqual([]);
  });

  it('sets process-control flags and disables nested user namespaces by default', () => {
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
    expect(indexOfSeq(args, '--cap-drop', 'ALL')).toBeGreaterThan(-1);
    expect(args).toContain('--disable-userns');
    expect(buildBwrapArgs({ ...base, allowNestedUserNamespaces: true })).not.toContain(
      '--disable-userns',
    );
  });

  it('builds the read-only system layout', () => {
    expect(indexOfSeq(args, '--ro-bind', '/usr', '/usr')).toBeGreaterThan(-1);
    for (const dir of ['bin', 'lib', 'lib64', 'sbin']) {
      expect(indexOfSeq(args, '--symlink', `usr/${dir}`, `/${dir}`)).toBeGreaterThan(-1);
    }
    const tried = args.flatMap((a, i) => (a === '--ro-bind-try' ? [args[i + 1]] : []));
    expect(tried).toEqual([
      '/etc/ld.so.cache',
      '/etc/ssl',
      '/etc/ca-certificates',
      '/etc/alternatives',
    ]);
    expect(indexOfSeq(args, '--ro-bind', '/opt/node22', '/opt/node22')).toBeGreaterThan(-1);
    expect(
      indexOfSeq(args, '--ro-bind', '/tmp/nexar-sbx-abc/passwd', '/etc/passwd'),
    ).toBeGreaterThan(-1);
    expect(indexOfSeq(args, '--ro-bind', '/tmp/nexar-sbx-abc/group', '/etc/group')).toBeGreaterThan(
      -1,
    );
    expect(
      indexOfSeq(
        args,
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--tmpfs',
        '/home/agent',
      ),
    ).toBeGreaterThan(-1);
  });

  it('binds toolchains after the /tmp and home tmpfs mounts, so they are not hidden', () => {
    const args = buildBwrapArgs({ ...base, toolchainPaths: ['/tmp/tools/node'] });
    const tmpfsTmp = args.findIndex((a, i) => a === '--tmpfs' && args[i + 1] === '/tmp');
    const toolchain = args.findIndex(
      (a, i) => a === '--ro-bind' && args[i + 1] === '/tmp/tools/node',
    );
    expect(tmpfsTmp).toBeGreaterThan(-1);
    expect(toolchain).toBeGreaterThan(tmpfsTmp);
    expect(toolchain).toBeLessThan(args.indexOf('--remount-ro'));
  });

  it('binds the workspace and protects .git after it', () => {
    const ws = indexOfSeq(args, '--bind', '/data/ws', '/work');
    const git = indexOfSeq(args, '--ro-bind', '/data/ws/.git', '/work/.git');
    expect(ws).toBeGreaterThan(-1);
    expect(git).toBeGreaterThan(ws);
    const ro = buildBwrapArgs({ ...base, workspaceAccess: 'read-only', protectGit: false });
    expect(indexOfSeq(ro, '--ro-bind', '/data/ws', '/work')).toBeGreaterThan(-1);
    expect(ro).not.toContain('/work/.git');
    expect(indexOfSeq(ro, '--bind', '/data/ws', '/work')).toBe(-1);
  });

  it('orders mounts, remount, chdir, clearenv and sorted setenv', () => {
    const home = indexOfSeq(args, '--tmpfs', '/home/agent');
    const mount = indexOfSeq(args, '--ro-bind', '/data/cred', '/home/agent/.cred');
    const run = indexOfSeq(args, '--ro-bind', '/tmp/nexar-sbx-abc', '/run/nexar');
    const remount = indexOfSeq(args, '--remount-ro', '/');
    const chdir = indexOfSeq(args, '--chdir', '/work');
    const clear = args.indexOf('--clearenv');
    const firstSetenv = args.indexOf('--setenv');
    const separator = args.indexOf('--');
    expect(mount).toBeGreaterThan(home);
    expect(run).toBeGreaterThan(mount);
    expect(remount).toBeGreaterThan(run);
    expect(chdir).toBeGreaterThan(remount);
    expect(clear).toBeGreaterThan(chdir);
    expect(firstSetenv).toBeGreaterThan(clear);
    expect(separator).toBeGreaterThan(firstSetenv);
    const keys = args.flatMap((a, i) => (a === '--setenv' ? [args[i + 1]] : []));
    expect(keys).toEqual(['ALPHA', 'PATH', 'ZED']);
  });

  it('wraps the command in the socat bridge in proxy mode without interpolating user values', () => {
    const tail = args.slice(args.indexOf('--') + 1);
    expect(tail.slice(0, 4)).toEqual(['/bin/sh', '-c', PROXY_BRIDGE_SCRIPT, 'sh']);
    expect(tail.slice(4)).toEqual(['/usr/bin/agent', '--flag', "va'lue; rm -rf /"]);
    expect(PROXY_BRIDGE_SCRIPT).toContain(
      'TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/nexar/proxy.sock',
    );
    expect(PROXY_BRIDGE_SCRIPT).toContain('socat -u OPEN:/dev/null TCP:127.0.0.1:3128');
    expect(PROXY_BRIDGE_SCRIPT).toContain('exec "$@"');
    expect(PROXY_BRIDGE_SCRIPT).not.toContain('agent');
  });

  it('network none has no socat, no run dir mount and runs the command directly', () => {
    const none = buildBwrapArgs({ ...base, network: 'none' });
    expect(none.join(' ')).not.toContain('socat');
    expect(none).not.toContain('/run/nexar');
    expect(none.slice(none.indexOf('--') + 1)).toEqual([
      '/usr/bin/agent',
      '--flag',
      "va'lue; rm -rf /",
    ]);
    expect(none).toContain('/etc/passwd');
  });

  it('refuses proxy mode without a run directory', () => {
    const withoutRunDir: Record<string, unknown> = { ...base };
    delete withoutRunDir['runDir'];
    expect(() => buildBwrapArgs(withoutRunDir as unknown as BwrapProfileInput)).toThrow(NexarError);
  });

  it('is deterministic', () => {
    expect(buildBwrapArgs(base)).toEqual(
      buildBwrapArgs({ ...base, env: { PATH: '/usr/bin', ALPHA: '2', ZED: '1' } }),
    );
  });
});
