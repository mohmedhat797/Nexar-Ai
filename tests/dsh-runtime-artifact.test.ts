import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_SEAL,
  hashRuntimeTree,
  hashRuntimeTreeAsync,
  INSTALL_RECEIPT,
  inspectRuntimeArtifact,
  installReceipt,
  promoteRuntimeArtifact,
  promoteRuntimeArtifactAsync,
  sealRuntimeArtifact,
  verifyPackagedRuntime,
  verifyPackagedRuntimeAsync,
} from '../scripts/dsh-runtime/artifact.mjs';

const roots: string[] = [];
const version = '0.2.1-rc.5';
const packageName = '@deepseek-ai/dsh';
const entries = {
  [`node_modules/${packageName}`]: { version, integrity: 'sha512-root' },
  'node_modules/dep': { version: '1.0.0', integrity: 'sha512-dep' },
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexar-dsh-artifact-')));
  roots.push(root);
  const pinDir = join(root, 'pin');
  mkdirSync(pinDir);
  writeFileSync(
    join(pinDir, 'dsh-runtime.json'),
    JSON.stringify({ package: packageName, version }),
  );
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [packageName]: version } },
      ...entries,
      'node_modules/other-platform': {
        version: '1.0.0',
        integrity: 'sha512-opt',
        optional: true,
      },
    },
  });
  writeFileSync(join(pinDir, 'dsh-runtime.package-lock.json'), lock);
  const runtime = join(root, 'runtime');
  const pkg = join(runtime, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  mkdirSync(join(runtime, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'nexar-dsh-runtime' }));
  writeFileSync(join(runtime, 'package-lock.json'), lock);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: packageName, version }));
  writeFileSync(join(pkg, 'lib', 'bin.js'), 'synthetic verified runtime');
  writeFileSync(join(runtime, 'node_modules', 'dep', 'package.json'), '{"name":"dep"}');
  writeFileSync(
    join(runtime, 'node_modules', '.package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: entries }),
  );
  writeFileSync(
    join(runtime, INSTALL_RECEIPT),
    JSON.stringify(installReceipt({ generation: 'gen-1', pinDir })),
  );
  return { root, pinDir, runtime, pkg, target: join(root, 'dist', 'dsh-runtime') };
}

function sealed() {
  const f = fixture();
  mkdirSync(join(f.root, 'dist'));
  const seal = sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir });
  return { ...f, seal };
}

function category(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { category?: string }).category;
  }
  return undefined;
}

function reseal(f: ReturnType<typeof sealed>, changes: Record<string, unknown>) {
  const path = join(f.runtime, ARTIFACT_SEAL);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...changes }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sealing a managed DSH runtime', () => {
  it('binds identity, lock, platform, provenance and the complete tree', () => {
    const f = sealed();
    expect(f.seal).toMatchObject({
      package: packageName,
      version,
      platform: process.platform,
      arch: process.arch,
      installGeneration: 'gen-1',
      files: 6,
    });
    expect(f.seal.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a tree the accepted installer did not complete', () => {
    const f = fixture();
    unlinkSync(join(f.runtime, INSTALL_RECEIPT));
    expect(category(() => sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_NOT_INSTALLED',
    );
  });

  it('refuses a partial tree: no hidden lock or a package that is not on disk', () => {
    const noLock = fixture();
    unlinkSync(join(noLock.runtime, 'node_modules', '.package-lock.json'));
    expect(
      category(() => sealRuntimeArtifact({ dir: noLock.runtime, pinDir: noLock.pinDir })),
    ).toBe('ARTIFACT_INCOMPLETE');
    const missing = fixture();
    rmSync(join(missing.runtime, 'node_modules', 'dep'), { recursive: true });
    expect(
      category(() => sealRuntimeArtifact({ dir: missing.runtime, pinDir: missing.pinDir })),
    ).toBe('ARTIFACT_INCOMPLETE');
    const unmaterialized = fixture();
    writeFileSync(
      join(unmaterialized.runtime, 'node_modules', '.package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/dep': entries['node_modules/dep'] } }),
    );
    expect(
      category(() =>
        sealRuntimeArtifact({ dir: unmaterialized.runtime, pinDir: unmaterialized.pinDir }),
      ),
    ).toBe('ARTIFACT_INCOMPLETE');
  });

  it('refuses a package whose integrity differs from the pinned lock', () => {
    const f = fixture();
    writeFileSync(
      join(f.runtime, 'node_modules', '.package-lock.json'),
      JSON.stringify({
        packages: {
          ...entries,
          'node_modules/dep': { version: '1.0.0', integrity: 'sha512-forged' },
        },
      }),
    );
    expect(category(() => sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_LOCK_MISMATCH',
    );
  });

  it('refuses a wrong version or lock identity', () => {
    const f = fixture();
    writeFileSync(
      join(f.runtime, INSTALL_RECEIPT),
      JSON.stringify({
        ...installReceipt({ generation: 'g', pinDir: f.pinDir }),
        version: '0.2.0',
      }),
    );
    expect(category(() => sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_IDENTITY_MISMATCH',
    );
    const lock = fixture();
    appendFileSync(join(lock.runtime, 'package-lock.json'), ' ');
    expect(category(() => sealRuntimeArtifact({ dir: lock.runtime, pinDir: lock.pinDir }))).toBe(
      'ARTIFACT_LOCK_MISMATCH',
    );
  });

  it('refuses links anywhere in the tree instead of following them', () => {
    const f = fixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(f.runtime, 'node_modules', 'linked'), 'junction');
    expect(category(() => sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_LINK',
    );
  });

  it('refuses a runtime path that aliases another directory', () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.runtime, alias, 'junction');
    expect(category(() => sealRuntimeArtifact({ dir: alias, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_UNSAFE_PATH',
    );
  });

  it('does not seal while an installation holds the target, nor twice', () => {
    const f = fixture();
    writeFileSync(`${f.runtime}.install-lock`, '{}');
    expect(category(() => sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_INSTALLATION_ACTIVE',
    );
    unlinkSync(`${f.runtime}.install-lock`);
    sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir });
    expect(category(() => sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }))).toBe(
      'ARTIFACT_ALREADY_SEALED',
    );
  });
});

describe('inspecting a candidate artifact', () => {
  it('reports absent and unsealed as no verified artifact, not as a failure', () => {
    const f = fixture();
    expect(inspectRuntimeArtifact({ dir: join(f.root, 'none'), pinDir: f.pinDir }).status).toBe(
      'absent',
    );
    expect(inspectRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir }).status).toBe('unsealed');
  });

  it('rejects rather than ignores a seal for another version, platform or schema', () => {
    const version2 = sealed();
    reseal(version2, { version: '0.2.0-rc.2' });
    expect(
      category(() => inspectRuntimeArtifact({ dir: version2.runtime, pinDir: version2.pinDir })),
    ).toBe('ARTIFACT_IDENTITY_MISMATCH');
    const platform = sealed();
    reseal(platform, { platform: 'other' });
    expect(
      category(() => inspectRuntimeArtifact({ dir: platform.runtime, pinDir: platform.pinDir })),
    ).toBe('ARTIFACT_PLATFORM_MISMATCH');
    const schema = sealed();
    reseal(schema, { schema: 'old' });
    expect(
      category(() => inspectRuntimeArtifact({ dir: schema.runtime, pinDir: schema.pinDir })),
    ).toBe('ARTIFACT_SEAL_INVALID');
    const corrupt = sealed();
    writeFileSync(join(corrupt.runtime, ARTIFACT_SEAL), '{');
    expect(
      category(() => inspectRuntimeArtifact({ dir: corrupt.runtime, pinDir: corrupt.pinDir })),
    ).toBe('ARTIFACT_SEAL_INVALID');
  });
});

describe('promoting a sealed artifact', () => {
  it('copies byte-identical content, carries the seal and is repeatable', () => {
    const f = sealed();
    const seal = promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir });
    expect(seal.treeSha256).toBe(f.seal.treeSha256);
    expect(
      readFileSync(join(f.target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8'),
    ).toBe('synthetic verified runtime');
    expect(existsSync(join(f.target, ARTIFACT_SEAL))).toBe(true);
    const again = join(f.root, 'dist', 'second');
    expect(
      promoteRuntimeArtifact({ dir: f.runtime, target: again, pinDir: f.pinDir }).treeSha256,
    ).toBe(f.seal.treeSha256);
    expect(verifyPackagedRuntime({ dir: again, seal: f.seal, reference: f.target })).toMatchObject({
      matches: true,
      missing: [],
      extra: [],
      changed: [],
    });
  });

  it.each([
    [
      'content changed',
      (f: ReturnType<typeof sealed>) => {
        appendFileSync(join(f.pkg, 'lib', 'bin.js'), 'tampered');
      },
    ],
    [
      'file added',
      (f: ReturnType<typeof sealed>) => {
        writeFileSync(join(f.pkg, 'lib', 'extra.js'), 'added');
      },
    ],
    [
      'file removed',
      (f: ReturnType<typeof sealed>) => {
        unlinkSync(join(f.pkg, 'lib', 'bin.js'));
      },
    ],
  ])('rejects a tree with %s after sealing and publishes nothing', (_name, tamper) => {
    const f = sealed();
    tamper(f);
    expect(
      category(() =>
        promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
      ),
    ).toBe('ARTIFACT_TREE_MISMATCH');
    expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(join(f.root, 'dist'))).toEqual([]);
  });

  it('rejects a link introduced after sealing', () => {
    const f = sealed();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(f.pkg, 'linked'), 'junction');
    expect(
      category(() =>
        promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
      ),
    ).toBe('ARTIFACT_LINK');
    expect(existsSync(f.target)).toBe(false);
  });

  it('never overwrites an existing target and refuses an unsealed source', () => {
    const f = sealed();
    mkdirSync(f.target);
    expect(
      category(() =>
        promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
      ),
    ).toBe('ARTIFACT_TARGET_EXISTS');
    const unsealed = fixture();
    expect(
      category(() =>
        promoteRuntimeArtifact({
          dir: unsealed.runtime,
          target: join(unsealed.root, 'out'),
          pinDir: unsealed.pinDir,
        }),
      ),
    ).toBe('ARTIFACT_NOT_SEALED');
  });

  it('leaves an interrupted promotion as an unreferenced stage, never the target', () => {
    const f = sealed();
    expect(() =>
      promoteRuntimeArtifact({
        dir: f.runtime,
        target: f.target,
        pinDir: f.pinDir,
        id: () => 'interrupted',
        onCopied: () => {
          throw new Error('interrupted');
        },
      }),
    ).toThrow('interrupted');
    expect(existsSync(f.target)).toBe(false);
    expect(existsSync(`${f.target}.promote-interrupted`)).toBe(true);
    expect(
      promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir }).treeSha256,
    ).toBe(f.seal.treeSha256);
  });
});

describe('bounded asynchronous artifact promotion', () => {
  it('preserves the complete sealed tree across many files and multiple binary chunks', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'dist'));
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0xa5);
    writeFileSync(join(f.pkg, 'lib', 'binary.bin'), bytes);
    for (let n = 0; n < 32; n++) writeFileSync(join(f.pkg, `file-${String(n)}.txt`), String(n));
    const seal = sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir });
    for (const row of hashRuntimeTree(f.runtime)) {
      expect(row.sha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(f.runtime, row.rel)))
          .digest('hex'),
      );
    }
    expect(
      await promoteRuntimeArtifactAsync({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
    ).toEqual(seal);
    expect(
      [...(await hashRuntimeTreeAsync(f.runtime))].sort((a, b) => a.rel.localeCompare(b.rel)),
    ).toEqual([...hashRuntimeTree(f.runtime)].sort((a, b) => a.rel.localeCompare(b.rel)));
    expect(
      readFileSync(join(f.target, 'node_modules', packageName, 'lib', 'binary.bin')).equals(bytes),
    ).toBe(true);
    expect(await verifyPackagedRuntimeAsync({ dir: f.target, seal, reference: f.runtime })).toEqual(
      verifyPackagedRuntime({ dir: f.target, seal, reference: f.runtime }),
    );
    expect(verifyPackagedRuntime({ dir: f.target, seal, reference: f.runtime })).toMatchObject({
      matches: true,
      missing: [],
      extra: [],
      changed: [],
    });
  });

  it.each(['changed', 'added', 'removed'])(
    'rejects %s source bytes and publishes nothing',
    async (kind) => {
      const f = sealed();
      const entry = join(f.pkg, 'lib', 'bin.js');
      if (kind === 'changed') appendFileSync(entry, 'tampered');
      else if (kind === 'added') writeFileSync(join(f.pkg, 'extra.js'), 'unexpected');
      else unlinkSync(entry);
      await expect(
        promoteRuntimeArtifactAsync({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
      ).rejects.toMatchObject({ category: 'ARTIFACT_TREE_MISMATCH' });
      expect(existsSync(f.target)).toBe(false);
      expect(readdirSync(join(f.root, 'dist'))).toEqual([]);
    },
  );

  it('rejects source mutation while other pipelines are copying', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'dist'));
    const files = Array.from({ length: 32 }, (_, n) => join(f.pkg, `file-${String(n)}.txt`));
    for (const file of files) writeFileSync(file, 'sealed');
    sealRuntimeArtifact({ dir: f.runtime, pinDir: f.pinDir });
    let changed = false;
    await expect(
      promoteRuntimeArtifactAsync({
        dir: f.runtime,
        target: f.target,
        pinDir: f.pinDir,
        onCopied: () => {
          if (changed) return;
          changed = true;
          for (const file of files) appendFileSync(file, 'tampered');
        },
      }),
    ).rejects.toMatchObject({ category: 'ARTIFACT_TREE_MISMATCH' });
    expect(changed).toBe(true);
    expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(join(f.root, 'dist'))).toEqual([]);
  });

  it('keeps alias, link, target ownership and unsealed-source guards', async () => {
    const f = sealed();
    mkdirSync(f.target);
    writeFileSync(join(f.target, 'owner.txt'), 'keep');
    await expect(
      promoteRuntimeArtifactAsync({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
    ).rejects.toMatchObject({ category: 'ARTIFACT_TARGET_EXISTS' });
    expect(readFileSync(join(f.target, 'owner.txt'), 'utf8')).toBe('keep');
    const alias = join(f.root, 'alias');
    symlinkSync(f.runtime, alias, 'junction');
    await expect(
      promoteRuntimeArtifactAsync({
        dir: alias,
        target: join(f.root, 'alias-out'),
        pinDir: f.pinDir,
      }),
    ).rejects.toMatchObject({ category: 'ARTIFACT_UNSAFE_PATH' });
    const unsealed = fixture();
    await expect(
      promoteRuntimeArtifactAsync({
        dir: unsealed.runtime,
        target: join(unsealed.root, 'out'),
        pinDir: unsealed.pinDir,
      }),
    ).rejects.toMatchObject({ category: 'ARTIFACT_NOT_SEALED' });
    symlinkSync(f.root, join(f.pkg, 'linked'), 'junction');
    await expect(
      promoteRuntimeArtifactAsync({
        dir: f.runtime,
        target: join(f.root, 'linked-out'),
        pinDir: f.pinDir,
      }),
    ).rejects.toMatchObject({ category: 'ARTIFACT_LINK' });
  });

  it('settles interrupted copies without publishing and allows a separately staged retry', async () => {
    const f = sealed();
    await expect(
      promoteRuntimeArtifactAsync({
        dir: f.runtime,
        target: f.target,
        pinDir: f.pinDir,
        id: () => 'interrupted-async',
        onCopied: () => {
          throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(existsSync(f.target)).toBe(false);
    const stage = `${f.target}.promote-interrupted-async`;
    expect(existsSync(stage)).toBe(true);
    // A failing first completion must not have opened one output for every source file.
    expect(
      readdirSync(stage, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
        .length,
    ).toBeLessThanOrEqual(4);
    const snapshot = readdirSync(stage, { recursive: true }).sort();
    expect(
      await promoteRuntimeArtifactAsync({ dir: f.runtime, target: f.target, pinDir: f.pinDir }),
    ).toEqual(f.seal);
    expect(readdirSync(stage, { recursive: true }).sort()).toEqual(snapshot);
  });
});

describe('verifying the packaged copy', () => {
  it('retains full mismatch diagnostics with asynchronous hashing', async () => {
    const f = sealed();
    await promoteRuntimeArtifactAsync({ dir: f.runtime, target: f.target, pinDir: f.pinDir });
    unlinkSync(join(f.target, 'node_modules', 'dep', 'package.json'));
    writeFileSync(join(f.target, 'added.txt'), 'x');
    appendFileSync(join(f.target, 'package.json'), ' ');
    const actual = await verifyPackagedRuntimeAsync({
      dir: f.target,
      seal: f.seal,
      reference: f.runtime,
    });
    expect(actual).toEqual(
      verifyPackagedRuntime({ dir: f.target, seal: f.seal, reference: f.runtime }),
    );
    expect(actual).toMatchObject({
      matches: false,
      missing: ['node_modules/dep/package.json'],
      extra: ['added.txt'],
      changed: ['package.json'],
    });
  });
  it('names files the packager dropped, added or altered', () => {
    const f = sealed();
    promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir });
    const packaged = join(f.root, 'packaged');
    promoteRuntimeArtifact({ dir: f.runtime, target: packaged, pinDir: f.pinDir });
    unlinkSync(join(packaged, 'node_modules', 'dep', 'package.json'));
    writeFileSync(join(packaged, 'added.txt'), 'x');
    appendFileSync(join(packaged, 'package.json'), ' ');
    expect(
      verifyPackagedRuntime({ dir: packaged, seal: f.seal, reference: f.target }),
    ).toMatchObject({
      matches: false,
      missing: ['node_modules/dep/package.json'],
      extra: ['added.txt'],
      changed: ['package.json'],
    });
  });

  it('ignores only the generated runtime.json and the carried seal', () => {
    const f = sealed();
    promoteRuntimeArtifact({ dir: f.runtime, target: f.target, pinDir: f.pinDir });
    writeFileSync(join(f.target, 'runtime.json'), '{}');
    expect(
      verifyPackagedRuntime({ dir: f.target, seal: f.seal, reference: f.runtime }).matches,
    ).toBe(true);
  });
});
