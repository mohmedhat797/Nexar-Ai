import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensurePrivateStateDirectory } from './private-state.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexar-private-state-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('state guard tool boundary', () => {
  it('uses a fixed encoded script, an absolute system executable and path data only', async () => {
    const runWindows = vi.fn(() => Promise.resolve());
    const path = String.raw`C:\state\owner's %PATH% & $secret مرحبا`;
    await ensurePrivateStateDirectory(path, {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWindows,
    });
    expect(runWindows).toHaveBeenCalledOnce();
    const call = runWindows.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(call[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call[1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(call[1][3]!, 'base64').toString('utf16le');
    expect(script).not.toContain(path);
    expect(script).toContain('$env:NEXAR_PRIVATE_STATE_PATH');
    expect(call[2]).toEqual({
      env: { SystemRoot: 'C:\\Windows', NEXAR_PRIVATE_STATE_PATH: path },
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 16 * 1024,
    });
  });

  it.each(['relative', '\\rooted', '\\\\server\\share', 'C:\\'])(
    'rejects unsafe state path %s',
    async (path) => {
      const runWindows = vi.fn(() => Promise.resolve());
      await expect(
        ensurePrivateStateDirectory(path, {
          platform: 'win32',
          systemRoot: 'C:\\Windows',
          runWindows,
        }),
      ).rejects.toThrow('Cannot secure the Desktop state directory');
      expect(runWindows).not.toHaveBeenCalled();
    },
  );

  it('fails closed if the system tool is unavailable, times out or rejects ownership', async () => {
    for (const code of ['ENOENT', 'ETIMEDOUT', 'OWNER_MISMATCH']) {
      const runWindows = vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('private path and account in subprocess output'), { code }),
        ),
      );
      await expect(
        ensurePrivateStateDirectory('C:\\state', {
          platform: 'win32',
          systemRoot: 'C:\\Windows',
          runWindows,
        }),
      ).rejects.toThrow(/^Cannot secure the Desktop state directory$/);
    }
  });

  it('rejects an untrusted system directory before launching a subprocess', async () => {
    const runWindows = vi.fn(() => Promise.resolve());
    await expect(
      ensurePrivateStateDirectory('C:\\state', {
        platform: 'win32',
        systemRoot: 'relative\\Windows',
        runWindows,
      }),
    ).rejects.toThrow('Cannot secure the Desktop state directory');
    expect(runWindows).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied shared roots before invoking the ACL tool', async () => {
    const runWindows = vi.fn(() => Promise.resolve());
    await expect(
      ensurePrivateStateDirectory('C:\\SHARED\\', {
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        forbiddenPaths: ['c:\\shared'],
        runWindows,
      }),
    ).rejects.toThrow('Cannot secure the Desktop state directory');
    expect(runWindows).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects the actual host temp base without touching it',
    async () => {
      const runWindows = vi.fn(() => Promise.resolve());
      await expect(ensurePrivateStateDirectory(tmpdir(), { runWindows })).rejects.toThrow(
        'Cannot secure the Desktop state directory',
      );
      expect(runWindows).not.toHaveBeenCalled();
    },
  );
});

interface AclSnapshot {
  readonly ownerCurrent: boolean;
  readonly protected: boolean;
  readonly rules: readonly {
    readonly principal: string;
    readonly rights: string;
    readonly inheritance: string;
    readonly propagation: string;
    readonly inherited: boolean;
    readonly type: string;
  }[];
  readonly descriptor: string;
}

async function powershell(script: string, path: string): Promise<string> {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (systemRoot === undefined) throw new Error('Windows test system directory unavailable');
  const { stdout } = await execFileAsync(
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: { SystemRoot: systemRoot, NEXAR_ACL_TEST_PATH: path },
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  return stdout.trim();
}

async function snapshot(path: string): Promise<AclSnapshot> {
  const output = await powershell(
    String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $env:NEXAR_ACL_TEST_PATH
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
  ForEach-Object {
    $principal = switch ($_.IdentityReference.Value) {
      $sid { 'user' }
      'S-1-5-18' { 'SYSTEM' }
      'S-1-5-32-544' { 'Administrators' }
      default { 'other' }
    }
    @{ principal = $principal; rights = $_.FileSystemRights.ToString()
      inheritance = $_.InheritanceFlags.ToString(); propagation = $_.PropagationFlags.ToString()
      inherited = $_.IsInherited; type = $_.AccessControlType.ToString() }
  })
@{ ownerCurrent = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid
  protected = $acl.AreAccessRulesProtected; rules = $rules; descriptor = $acl.Sddl } |
  ConvertTo-Json -Depth 4 -Compress
`,
    path,
  );
  return JSON.parse(output) as AclSnapshot;
}

function descriptorHash(snapshot: AclSnapshot): string {
  return createHash('sha256').update(snapshot.descriptor).digest('hex');
}

function expectPrivate(snapshot: AclSnapshot, directory: boolean, protectedAcl = true): void {
  expect(snapshot.ownerCurrent).toBe(true);
  expect(snapshot.protected).toBe(protectedAcl);
  expect(snapshot.rules.map((rule) => rule.principal).sort()).toEqual([
    'Administrators',
    'SYSTEM',
    'user',
  ]);
  for (const rule of snapshot.rules) {
    expect(rule.rights).toBe('FullControl');
    expect(rule.type).toBe('Allow');
    expect(rule.propagation).toBe('None');
    expect(rule.inheritance).toBe(directory ? 'ContainerInherit, ObjectInherit' : 'None');
    expect(rule.inherited).toBe(!protectedAcl);
  }
}

async function addBroadExplicitGrant(path: string): Promise<void> {
  await powershell(
    String.raw`
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:NEXAR_ACL_TEST_PATH -Force
$acl = $item.GetAccessControl()
$acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
  [System.Security.AccessControl.FileSystemRights]::Modify,
  [System.Security.AccessControl.AccessControlType]::Allow)
[void] $acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
`,
    path,
  );
}

describe.skipIf(process.platform !== 'win32')('native Windows state ACLs', () => {
  it('creates a private root and inherited private files without changing its parent ACL', async () => {
    const parent = await fixture();
    const before = descriptorHash(await snapshot(parent));
    const state = join(parent, "state owner's %PATH% & مرحبا");
    const secured = ensurePrivateStateDirectory(state).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Native Windows startup must finish before the first promise yield allows Electron to
    // create runtime files in the root. This checks the real tool rather than the test seam.
    expect(existsSync(join(state, '.nexar-desktop-state'))).toBe(true);
    expect(await secured).toBeUndefined();
    expectPrivate(await snapshot(state), true);
    const file = join(state, 'nexar.config.json');
    await writeFile(file, '{}', { mode: 0o600 });
    expectPrivate(await snapshot(file), false, false);
    expect(descriptorHash(await snapshot(parent))).toBe(before);
  }, 20_000);

  it('removes explicit broad child grants as well as inherited grants, preserving content', async () => {
    const parent = await fixture();
    const state = join(parent, 'state');
    const nested = join(state, '.nexar', 'approvals');
    await mkdir(nested, { recursive: true });
    await writeFile(join(state, 'nexar.config.json'), '{"version":1}');
    const file = join(nested, 'requests.json');
    await writeFile(file, '{"keep":true}');
    await addBroadExplicitGrant(file);
    expect((await snapshot(file)).rules.some((rule) => rule.principal === 'other')).toBe(true);
    const parentBefore = descriptorHash(await snapshot(parent));
    await ensurePrivateStateDirectory(state);
    expectPrivate(await snapshot(state), true);
    expectPrivate(await snapshot(nested), true);
    expectPrivate(await snapshot(file), false);
    expect(await readFile(file, 'utf8')).toBe('{"keep":true}');
    expect(descriptorHash(await snapshot(parent))).toBe(parentBefore);
    await ensurePrivateStateDirectory(state); // Applying the policy again is idempotent.
    expectPrivate(await snapshot(file), false);
  }, 30_000);

  it('refuses an unrelated nonempty directory before changing its ACLs or writing a marker', async () => {
    const parent = await fixture();
    const state = join(parent, 'unrelated');
    await mkdir(state);
    const file = join(state, 'personal.txt');
    await writeFile(file, 'untouched');
    const before = descriptorHash(await snapshot(state));
    await expect(ensurePrivateStateDirectory(state)).rejects.toThrow(
      'Cannot secure the Desktop state directory',
    );
    expect(descriptorHash(await snapshot(state))).toBe(before);
    expect(await readFile(file, 'utf8')).toBe('untouched');
    await expect(lstat(join(state, '.nexar-desktop-state'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 20_000);

  it('rejects a hard-linked state file without changing its outside target ACL or content', async () => {
    const parent = await fixture();
    const state = join(parent, 'state');
    await mkdir(state);
    await writeFile(join(state, 'nexar.config.json'), '{"version":1}');
    const target = join(parent, 'personal.txt');
    await writeFile(target, 'outside state');
    await link(target, join(state, 'linked.txt'));
    expect((await lstat(target)).nlink).toBe(2);
    const before = descriptorHash(await snapshot(target));
    const runWindows = vi.fn(() => Promise.resolve());
    await expect(ensurePrivateStateDirectory(state, { runWindows })).rejects.toThrow(
      'Cannot secure the Desktop state directory',
    );
    expect(runWindows).not.toHaveBeenCalled();
    expect(descriptorHash(await snapshot(target))).toBe(before);
    expect(await readFile(target, 'utf8')).toBe('outside state');
  }, 20_000);

  it.each(['root', 'nested', 'ancestor'] as const)(
    'rejects a %s junction without changing its target',
    async (location) => {
      const parent = await fixture();
      const target = join(parent, 'target');
      await mkdir(target);
      const marker = join(target, 'marker.txt');
      await writeFile(marker, 'target stays untouched');
      const before = descriptorHash(await snapshot(target));
      let state = join(parent, 'state');
      if (location === 'root') {
        await symlink(target, state, 'junction');
      } else if (location === 'nested') {
        await mkdir(state);
        await writeFile(join(state, 'nexar.config.json'), '{"version":1}');
        await symlink(target, join(state, 'redirect'), 'junction');
      } else {
        const ancestor = join(parent, 'redirect');
        await symlink(target, ancestor, 'junction');
        state = join(ancestor, 'state');
      }
      await expect(ensurePrivateStateDirectory(state)).rejects.toThrow(
        'Cannot secure the Desktop state directory',
      );
      expect(descriptorHash(await snapshot(target))).toBe(before);
      expect(await readFile(marker, 'utf8')).toBe('target stays untouched');
    },
    20_000,
  );
});

describe.skipIf(process.platform === 'win32')('POSIX state permissions', () => {
  it('normalizes the owner state root and leaves parent and runtime entries alone', async () => {
    const parent = await fixture();
    await chmod(parent, 0o755);
    const state = join(parent, 'state');
    await mkdir(state, { mode: 0o755 });
    const file = join(state, 'nexar.config.json');
    await writeFile(file, '{}', { mode: 0o644 });
    await symlink('runtime-lock', join(state, 'SingletonLock'));
    await ensurePrivateStateDirectory(state);
    expect((await lstat(state)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o644);
    expect((await lstat(join(state, 'SingletonLock'))).isSymbolicLink()).toBe(true);
    expect((await lstat(parent)).mode & 0o777).toBe(0o755);
  });

  it('rejects a symlink state root without changing its target permissions', async () => {
    const parent = await fixture();
    const state = join(parent, 'state');
    const target = join(parent, 'target');
    await mkdir(target, { mode: 0o755 });
    await symlink(target, state, 'dir');
    await expect(ensurePrivateStateDirectory(state)).rejects.toThrow(
      'Cannot secure the Desktop state directory',
    );
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
  });
});
