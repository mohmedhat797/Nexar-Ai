import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { INSTALL_RECEIPT } from '../scripts/dsh-runtime/artifact.mjs';
import { installDshRuntime } from '../scripts/dsh-runtime/install.mjs';
import { spawnSubprocess } from '../scripts/local-ci/process-util.mjs';
import type { SubprocessResult } from '../scripts/local-ci/process-util.mjs';

const roots: string[] = [];
const version = '0.2.0-rc.2';
const packageName = '@deepseek-ai/dsh';
const success = (stdout = ''): SubprocessResult => ({
  command: 'synthetic',
  exitCode: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  aborted: false,
  settled: true,
  stdout,
  stderr: '',
  error: null,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nexar-dsh-install-'));
  roots.push(root);
  const target = join(root, 'runtime');
  const pinDir = join(root, 'pin');
  mkdirSync(pinDir);
  writeFileSync(
    join(pinDir, 'dsh-runtime.json'),
    JSON.stringify({ package: packageName, version }),
  );
  writeFileSync(
    join(pinDir, 'dsh-runtime.package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { [packageName]: version } },
        [`node_modules/${packageName}`]: { version },
      },
    }),
  );
  const records: Readonly<Record<string, unknown>>[] = [];
  const report = (record: Readonly<Record<string, unknown>>) => {
    records.push(record);
  };
  const materialize = (dir: string, installedVersion = version, bin = 'lib/bin.js') => {
    const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: packageName, version: installedVersion, bin }),
    );
    writeFileSync(join(pkg, 'lib/bin.js'), 'synthetic verified runtime');
  };
  const run: typeof spawnSubprocess = (_command, args, options) => {
    options?.onSpawn?.(43210);
    if (args?.[0] === 'ci') {
      if (!options?.cwd) throw new Error('missing stage');
      expect(options.cwd).not.toBe(target);
      materialize(options.cwd);
      return Promise.resolve(success());
    }
    return Promise.resolve(success(`${version}\n`));
  };
  const previous = () => {
    mkdirSync(target);
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'nexar-dsh-runtime' }));
    materialize(target);
    writeFileSync(join(target, 'previous-sentinel'), 'retain on failure');
  };
  return { root, target, pinDir, records, report, materialize, run, previous };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only known disposable roots created by this test are recursively removed.
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'nexar-dsh-install-')))) {
      throw new Error('unexpected cleanup root');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Managed DSH installation publication and recovery', () => {
  it('retains the replaced generation without recursive deletion on the readiness path', async () => {
    const f = fixture();
    f.previous();
    const entry = await installDshRuntime(f);
    expect(readFileSync(entry, 'utf8')).toBe('synthetic verified runtime');
    const retained = readdirSync(f.root).filter((name) => name.startsWith('runtime.previous-'));
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(f.root, retained[0]!, 'previous-sentinel'), 'utf8')).toBe(
      'retain on failure',
    );
    expect(
      f.records.filter((record) => record.event === 'previous-generation-retained'),
    ).toHaveLength(1);
    expect(f.records.at(-1)?.event).toBe('ready');
    expect(existsSync(`${f.target}.install-lock`)).toBe(false);
  });

  it('applies only exact security overrides from the pin to the managed install', async () => {
    const f = fixture();
    const overrides = { zod: '4.6.7' };
    writeFileSync(
      join(f.pinDir, 'dsh-runtime.json'),
      JSON.stringify({ package: packageName, version, overrides }),
    );
    await installDshRuntime(f);
    const manifest = JSON.parse(readFileSync(join(f.target, 'package.json'), 'utf8')) as {
      overrides?: unknown;
    };
    expect(manifest.overrides).toEqual(overrides);
    const range = fixture();
    writeFileSync(
      join(range.pinDir, 'dsh-runtime.json'),
      JSON.stringify({ package: packageName, version, overrides: { zod: '^4.0.0' } }),
    );
    await expect(installDshRuntime(range)).rejects.toThrow('INVALID_PIN');
  });

  it('writes the install receipt only into a tree that passed every verification', async () => {
    const f = fixture();
    await installDshRuntime(f);
    expect(JSON.parse(readFileSync(join(f.target, INSTALL_RECEIPT), 'utf8'))).toMatchObject({
      package: packageName,
      version,
      generation: f.records[0]?.generation,
    });
    const wrong = fixture();
    const run: typeof spawnSubprocess = (_command, args, options) => {
      if (args?.[0] === 'ci' && options?.cwd) wrong.materialize(options.cwd);
      return Promise.resolve(success('0.0.0-wrong\n'));
    };
    await expect(installDshRuntime({ ...wrong, run })).rejects.toThrow('VERSION_PROBE_MISMATCH');
    const stage = readdirSync(wrong.root).find((name) => name.startsWith('runtime.stage-'));
    expect(stage).toBeDefined();
    expect(existsSync(join(wrong.root, stage!, INSTALL_RECEIPT))).toBe(false);
  });

  it('publishes fresh and repeated verified generations with stable entry identity', async () => {
    const f = fixture();
    const first = await installDshRuntime(f);
    expect(first).toBe(join(f.target, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
    expect(readFileSync(first, 'utf8')).toBe('synthetic verified runtime');
    expect(await installDshRuntime(f)).toBe(first);
    expect(f.records.filter((r) => r.event === 'ready')).toHaveLength(2);
    expect(new Set(f.records.map((r) => r.generation)).size).toBe(2);
    expect(existsSync(`${f.target}.install-lock`)).toBe(false);
  });

  it.each(['acquisition', 'integrity', 'interruption', 'timeout'] as const)(
    'preserves the complete previous runtime after %s failure and permits a later clean install',
    async (kind) => {
      const f = fixture();
      f.previous();
      const run: typeof spawnSubprocess = (_command, _args, options) => {
        if (!options?.cwd) throw new Error('missing stage');
        writeFileSync(join(options.cwd, 'partial'), 'not a runtime');
        return Promise.resolve({
          ...success(),
          exitCode: kind === 'timeout' ? 124 : 1,
          timedOut: kind === 'timeout',
          stderr: 'Bearer synthetic-secret-never-log',
        });
      };
      await expect(installDshRuntime({ ...f, run })).rejects.toThrow(
        kind === 'timeout' ? 'INSTALLATION_TIMEOUT' : 'CHILD_FAILED',
      );
      expect(readFileSync(join(f.target, 'previous-sentinel'), 'utf8')).toBe('retain on failure');
      expect(existsSync(join(f.target, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))).toBe(true);
      expect(existsSync(`${f.target}.install-lock`)).toBe(false);
      expect(JSON.stringify(f.records)).not.toContain('synthetic-secret');
      expect(await installDshRuntime(f)).toContain(f.target);
    },
  );

  it('keeps failed cold installation unavailable and never treats its partial stage as cache', async () => {
    const f = fixture();
    const run: typeof spawnSubprocess = () => Promise.resolve({ ...success(), exitCode: 1 });
    await expect(installDshRuntime({ ...f, run })).rejects.toThrow('CHILD_FAILED');
    expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(f.root).some((n) => n.startsWith('runtime.stage-'))).toBe(true);
    await expect(installDshRuntime(f)).resolves.toContain(f.target);
  });

  it.each(['identity', 'version', 'entry'] as const)(
    'rejects an invalid %s before publication',
    async (kind) => {
      const f = fixture();
      f.previous();
      let probes = 0;
      const run: typeof spawnSubprocess = (_command, args, options) => {
        if (args?.[0] === 'ci') {
          if (!options?.cwd) throw new Error('missing stage');
          f.materialize(
            options.cwd,
            kind === 'identity' ? '9.9.9' : version,
            kind === 'entry' ? '../../../../../outside.js' : 'lib/bin.js',
          );
          return Promise.resolve(success());
        }
        probes++;
        return Promise.resolve(success('9.9.9\n'));
      };
      await expect(installDshRuntime({ ...f, run })).rejects.toThrow('install-dsh-runtime:');
      expect(probes).toBe(kind === 'version' ? 1 : 0);
      expect(existsSync(join(f.target, 'previous-sentinel'))).toBe(true);
      expect(f.records.some((r) => r.event === 'ready')).toBe(false);
    },
  );

  it('never trusts a corrupt existing tree and replaces it only after a new verified installation', async () => {
    const f = fixture();
    f.previous();
    writeFileSync(join(f.target, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'corrupt');
    const entry = await installDshRuntime(f);
    expect(readFileSync(entry, 'utf8')).toBe('synthetic verified runtime');
  });

  it('serializes competing installations before either can mutate the published runtime', async () => {
    const f = fixture();
    f.previous();
    let release = () => {};
    let entered = () => {};
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const arrival = new Promise<void>((r) => {
      entered = r;
    });
    const run: typeof spawnSubprocess = async (command, args, options) => {
      if (args?.[0] === 'ci') {
        entered();
        await barrier;
      }
      return f.run(command, args, options);
    };
    const first = installDshRuntime({ ...f, run });
    await arrival;
    try {
      await expect(installDshRuntime(f)).rejects.toThrow('INSTALLATION_LOCKED');
      expect(existsSync(join(f.target, 'previous-sentinel'))).toBe(true);
    } finally {
      release();
      await first;
    }
  });

  it('restores the previous generation when publication rename fails', async () => {
    const f = fixture();
    f.previous();
    const rename: typeof renameSync = (from, to) => {
      if (String(from).includes('.stage-') && String(to) === f.target)
        throw new Error('injected rename fault');
      renameSync(from, to);
    };
    await expect(installDshRuntime({ ...f, rename })).rejects.toThrow('FILESYSTEM_OR_DATA_FAILURE');
    expect(readFileSync(join(f.target, 'previous-sentinel'), 'utf8')).toBe('retain on failure');
    expect(f.records.some((r) => r.event === 'ready')).toBe(false);
  });

  it('does not steal a lock retained after abnormal process termination', async () => {
    const f = fixture();
    f.previous();
    const retained = JSON.stringify({ generation: 'retained', parentPid: 999999 });
    writeFileSync(`${f.target}.install-lock`, retained);
    await expect(installDshRuntime(f)).rejects.toThrow('INSTALLATION_LOCKED');
    expect(readFileSync(`${f.target}.install-lock`, 'utf8')).toBe(retained);
    expect(existsSync(join(f.target, 'previous-sentinel'))).toBe(true);
  });

  it('refuses a pin-lock mismatch, unrelated directory and redirected runtime target', async () => {
    const f = fixture();
    writeFileSync(
      join(f.pinDir, 'dsh-runtime.package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: {} }),
    );
    await expect(installDshRuntime(f)).rejects.toThrow('PIN_LOCK_MISMATCH');
    const g = fixture();
    mkdirSync(g.target);
    writeFileSync(join(g.target, 'owner-file'), 'preserve');
    await expect(installDshRuntime(g)).rejects.toThrow('UNOWNED_TARGET');
    const h = fixture();
    symlinkSync(g.target, h.target, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installDshRuntime(h)).rejects.toThrow('UNSAFE_TARGET');
    expect(readFileSync(join(g.target, 'owner-file'), 'utf8')).toBe('preserve');
  });

  it('emits only allowlisted metadata and the actual child creation observation', async () => {
    const f = fixture();
    await installDshRuntime(f);
    const keys = new Set([
      'schema',
      'generation',
      'parentPid',
      'timestampUtc',
      'elapsedMs',
      'phase',
      'event',
      'packageVersion',
      'cacheMode',
      'durationMs',
      'childPid',
      'exitCode',
      'timedOut',
      'settled',
      'unpackMs',
      'category',
      'partialStageRetained',
    ]);
    for (const record of f.records)
      expect(Object.keys(record).every((k) => keys.has(k))).toBe(true);
    expect(f.records.filter((r) => r.event === 'child-created')).toHaveLength(2);
    expect(JSON.stringify(f.records)).not.toContain(f.root);
    const observed: number[] = [];
    const result = await spawnSubprocess(process.execPath, ['-e', 'console.log(process.pid)'], {
      timeoutMs: 10_000,
      onSpawn: (pid) => {
        observed.push(pid);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(observed).toEqual([Number(result.stdout.trim())]);
  });

  it('never logs malformed pin values as package metadata', async () => {
    const f = fixture();
    writeFileSync(
      join(f.pinDir, 'dsh-runtime.json'),
      JSON.stringify({
        package: packageName,
        version: 'Bearer synthetic-secret-never-log',
      }),
    );
    await expect(installDshRuntime(f)).rejects.toThrow('INVALID_PIN');
    expect(JSON.stringify(f.records)).not.toContain('synthetic-secret');
    expect(f.records.every((r) => r.packageVersion === null)).toBe(true);
  });
});
