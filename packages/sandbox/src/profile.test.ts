import { describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import {
  buildBridgeScript,
  buildBwrapArgs,
  PROXY_BRIDGE_SCRIPT,
  SANDBOX_BRIDGE_ENDPOINT,
  SANDBOX_GATEWAY_BASE_URL,
  SANDBOX_GATEWAY_PORT,
  SANDBOX_PROXY_PORT,
  SANDBOX_RELAY_PATH,
  SANDBOX_SERVICES_DIR,
  type BwrapProfileInput,
} from './profile.js';

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

  describe('Nexar services', () => {
    const services = {
      dir: '/data/svc',
      gateway: true,
      bridge: true,
      relayScript: '/data/relay.cjs',
    };

    it('exports the in-sandbox constants', () => {
      expect(SANDBOX_SERVICES_DIR).toBe('/run/nexar-services');
      expect(SANDBOX_GATEWAY_PORT).not.toBe(SANDBOX_PROXY_PORT);
      expect(SANDBOX_GATEWAY_BASE_URL).toBe(`http://127.0.0.1:${SANDBOX_GATEWAY_PORT}/v1`);
      expect(SANDBOX_BRIDGE_ENDPOINT).toBe('/run/nexar-services/bridge.sock');
      expect(SANDBOX_RELAY_PATH).toBe('/opt/nexar/bridge-relay.cjs');
    });

    it('binds the directory and the relay script read-only, before the remount', () => {
      const withServices = buildBwrapArgs({ ...base, services });
      const remount = withServices.indexOf('--remount-ro');
      const dir = indexOfSeq(withServices, '--ro-bind', '/data/svc', '/run/nexar-services');
      const relay = indexOfSeq(
        withServices,
        '--ro-bind',
        '/data/relay.cjs',
        '/opt/nexar/bridge-relay.cjs',
      );
      expect(dir).toBeGreaterThan(-1);
      expect(relay).toBeGreaterThan(-1);
      expect(Math.max(dir, relay)).toBeLessThan(remount);
      const bridgeOnly = buildBwrapArgs({
        ...base,
        network: 'none',
        services: { dir: '/data/svc', gateway: false, bridge: true },
      });
      expect(bridgeOnly).toContain('/run/nexar-services');
      expect(bridgeOnly).not.toContain('/opt/nexar/bridge-relay.cjs');
      // No gateway: no socat, the command runs directly.
      expect(bridgeOnly.slice(bridgeOnly.indexOf('--') + 1)[0]).toBe('/usr/bin/agent');
    });

    it('bridges the gateway socket with a bounded readiness wait, in proxy and none mode', () => {
      const script = buildBridgeScript({ proxy: false, gateway: true });
      expect(script).toContain(
        `socat TCP-LISTEN:${SANDBOX_GATEWAY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/nexar-services/gateway.sock`,
      );
      expect(script).toContain(`socat -u OPEN:/dev/null TCP:127.0.0.1:${SANDBOX_GATEWAY_PORT}`);
      expect(script).toContain('-lt 50');
      expect(script.endsWith('exec "$@"')).toBe(true);
      expect(script).not.toContain('proxy.sock');
      for (const network of ['none', 'proxy'] as const) {
        const built = buildBwrapArgs({ ...base, network, services });
        const tail = built.slice(built.indexOf('--') + 1);
        expect(tail.slice(0, 2)).toEqual(['/bin/sh', '-c']);
        expect(tail[2]).toContain('gateway.sock');
        expect(tail[2]?.includes('proxy.sock')).toBe(network === 'proxy');
        expect(tail.slice(3)).toEqual(['sh', '/usr/bin/agent', '--flag', "va'lue; rm -rf /"]);
      }
    });

    it('keeps the proxy-only script free of the gateway', () => {
      expect(PROXY_BRIDGE_SCRIPT).toBe(buildBridgeScript({ proxy: true, gateway: false }));
      expect(PROXY_BRIDGE_SCRIPT).not.toContain('gateway');
    });
  });

  it('is deterministic', () => {
    expect(buildBwrapArgs(base)).toEqual(
      buildBwrapArgs({ ...base, env: { PATH: '/usr/bin', ALPHA: '2', ZED: '1' } }),
    );
  });

  it('preserves isolation while sourcing environment values from a descriptor', () => {
    const token = 'FCR01-synthetic-token-581';
    const args = buildBwrapArgs({ ...base, env: { NEXAR_CONTROL_TOKEN: token }, environmentFd: 3 });
    expect(args).toContain('--clearenv');
    expect(indexOfSeq(args, '--args', '3')).toBeGreaterThan(args.indexOf('--clearenv'));
    expect(args).not.toContain('--setenv');
    expect(args.join('\n')).not.toContain(token);
    expect(args).toContain('--unshare-net');
    expect(args).toContain('/work/.git');
    for (const environmentFd of [-1, 0, 2, 3.5, Number.NaN]) {
      expect(() => buildBwrapArgs({ ...base, environmentFd })).toThrow(NexarError);
    }
  });
});
