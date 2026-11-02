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
import { ensurePrivateStateDirectory, PrivateStateError } from './private-state.js';
import { runWindowsStateProcess, type WindowsStateProcessEvent } from './private-state-process.js';

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
  it('preserves safe native process correlation when startup fails', async () => {
    const state = process.platform === 'win32' ? join(await fixture(), 'state') : 'C:\\state';
    const secret = 'synthetic-secret-not-allowed-in-startup-diagnostics';
    const error = await ensurePrivateStateDirectory(state, {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWindows: (command, args, options) => {
        runWindowsStateProcess(command, args, options, {
          spawn: () => ({
            pid: 42,
            status: null,
            signal: 'SIGTERM',
            stdout: Buffer.from(secret),
            error: { code: 'ETIMEDOUT', message: secret },
          }),
        });
        return Promise.resolve();
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivateStateError);
    expect((error as PrivateStateError).diagnostic).toMatchObject({
      category: 'timeout',
      phase: 'startup',
      process: {
        parentPid: process.pid,
        childPid: 42,
        childCreated: true,
        readinessCaptured: false,
        termination: 'timeout',
        timeoutMs: 15000,
      },
    });
    expect(JSON.stringify((error as PrivateStateError).diagnostic)).not.toContain(secret);
  });

  it('does not serialize process-like properties on an unrelated injected exception', async () => {
    const state = process.platform === 'win32' ? join(await fixture(), 'state') : 'C:\\state';
    const secret = 'synthetic-foreign-process-property';
    const error = await ensurePrivateStateDirectory(state, {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWindows: () =>
        Promise.reject(
          Object.assign(new Error(secret), {
            code: 'ENOENT',
            process: { private: secret },
          }),
        ),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivateStateError);
    expect((error as PrivateStateError).diagnostic).not.toHaveProperty('process');
    expect(JSON.stringify((error as PrivateStateError).diagnostic)).not.toContain(secret);
  });

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
    const cases = [
      [{ code: 'ENOENT' }, { category: 'tool-unavailable', phase: 'startup' }],
      [
        { code: 'ETIMEDOUT', stdout: '' },
        { category: 'timeout', phase: 'startup' },
      ],
      [
        { code: 'ETIMEDOUT', stdout: Buffer.from('nexar-state-guard:ready\r\n') },
        { category: 'timeout', phase: 'execution' },
      ],
      [
        { status: 5, stdout: 'nexar-state-guard:ready\r\n' },
        { category: 'owner-mismatch', phase: 'execution', exitCode: 5 },
      ],
      [
        { status: 77, stdout: '' },
        { category: 'tool-error', phase: 'startup', exitCode: 77 },
      ],
    ] as const;
    for (const [failure, diagnostic] of cases) {
      const runWindows = vi.fn(() =>
        Promise.reject(
          Object.assign(
            new Error('C:\\state private path and account in subprocess output'),
            failure,
          ),
        ),
      );
      const error = await ensurePrivateStateDirectory('C:\\state', {
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        runWindows,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PrivateStateError);
      expect((error as Error).message).toBe('Cannot secure the Desktop state directory');
      const reported = (error as PrivateStateError).diagnostic;
      expect(reported).toMatchObject(diagnostic);
      expect(reported.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(reported)).not.toMatch(/state|account|subprocess/);
    }
  });

  it('reports preflight refusals without a tool diagnostic', async () => {
    const error = await ensurePrivateStateDirectory('relative', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWindows: vi.fn(() => Promise.resolve()),
    }).catch((caught: unknown) => caught);
    expect((error as PrivateStateError).diagnostic).toEqual({
      category: 'preflight',
      phase: 'preflight',
    });
  });

  it('disables module auto-loading and emits only the readiness marker', async () => {
    const runWindows = vi.fn(() => Promise.resolve());
    await ensurePrivateStateDirectory('C:\\state', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWindows,
    });
    const call = runWindows.mock.calls[0] as unknown as [string, string[]];
    const script = Buffer.from(call[1][3]!, 'base64').toString('utf16le');
    expect(script).toContain("$PSModuleAutoLoadingPreference = 'None'");
    expect(script).toContain("[Console]::Out.WriteLine('nexar-state-guard:ready')");
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

type Principal = 'user' | 'SYSTEM' | 'Administrators' | 'other';

interface AclSnapshot {
  readonly owner: Principal;
  /** Whether this test process runs elevated (GitHub's Windows runners do). */
  readonly elevated: boolean;
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

// The helpers use .NET only, with module auto-loading off: cmdlets such as Get-Acl trigger
// PowerShell's first-use module analysis, which a minimal environment cannot reuse and which
// exceeded the helper budget on CI runners with large preinstalled module sets.
const HELPER_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$path = $env:NEXAR_ACL_TEST_PATH
if ([System.IO.Directory]::Exists($path)) { $item = [System.IO.DirectoryInfo]::new($path) }
else { $item = [System.IO.FileInfo]::new($path) }
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner
`;

async function powershell(operation: string, script: string, path: string): Promise<string> {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (systemRoot === undefined) throw new Error('Windows test system directory unavailable');
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(HELPER_PRELUDE + script, 'utf16le').toString('base64'),
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
  } catch (error) {
    // A bounded summary explains a helper failure without echoing the fixture path.
    const failure = error as {
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      stderr?: unknown;
    };
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    throw new Error(
      `ACL test helper ${operation} failed: ${JSON.stringify({
        code: failure.code,
        signal: failure.signal,
        killed: failure.killed,
        elapsedMs: Date.now() - started,
        stderr: stderr.split(path).join('<path>').slice(0, 400),
      })}`,
      // Temporary fixture paths only; the summary above is what CI logs should be read for.
      { cause: error },
    );
  }
}

async function snapshot(path: string): Promise<AclSnapshot> {
  // One tab-separated header line (owner, elevation, protection, descriptor), then one per rule.
  const output = await powershell(
    'snapshot',
    String.raw`
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$elevated = [System.Security.Principal.WindowsPrincipal]::new($identity).IsInRole(
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
function Principal([string] $value) {
  switch ($value) {
    $sid { 'user' }
    'S-1-5-18' { 'SYSTEM' }
    'S-1-5-32-544' { 'Administrators' }
    default { 'other' }
  }
}
$acl = $item.GetAccessControl($sections)
$owner = Principal $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
($owner, $elevated, $acl.AreAccessRulesProtected,
  $acl.GetSecurityDescriptorSddlForm($sections)) -join [char] 9
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $principal = Principal $rule.IdentityReference.Value
  ($principal, $rule.FileSystemRights, $rule.InheritanceFlags, $rule.PropagationFlags,
    $rule.IsInherited, $rule.AccessControlType) -join [char] 9
}
`,
    path,
  );
  const [header = '', ...lines] = output.split(/\r?\n/);
  const [owner = '', elevated, protectedAcl, descriptor = ''] = header.split('\t');
  return {
    owner: (['user', 'SYSTEM', 'Administrators'].includes(owner) ? owner : 'other') as Principal,
    elevated: elevated === 'True',
    protected: protectedAcl === 'True',
    descriptor,
    rules: lines.map((line) => {
      const [
        principal = '',
        rights = '',
        inheritance = '',
        propagation = '',
        inherited,
        type = '',
      ] = line.split('\t');
      return { principal, rights, inheritance, propagation, inherited: inherited === 'True', type };
    }),
  };
}

function descriptorHash(snapshot: AclSnapshot): string {
  return createHash('sha256').update(snapshot.descriptor).digest('hex');
}

/**
 * `protectedAcl` entries were normalized by the guard and must be owned by the user. Entries created
 * afterwards inherit the private grants; an elevated token's default owner is the local
 * Administrators group, a trusted owner the guard normalizes on its next run.
 */
function expectPrivate(snapshot: AclSnapshot, directory: boolean, protectedAcl = true): void {
  if (protectedAcl || !snapshot.elevated) expect(snapshot.owner).toBe('user');
  else expect(['user', 'Administrators']).toContain(snapshot.owner);
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
    'grant',
    String.raw`
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
    const events: WindowsStateProcessEvent[] = [];
    const secured = ensurePrivateStateDirectory(state, {
      onProcessTrace: (event) => events.push(event),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Native Windows startup must finish before the first promise yield allows Electron to
    // create runtime files in the root. This checks the real tool rather than the test seam.
    const synchronousMarker = existsSync(join(state, '.nexar-desktop-state'));
    const outcome = await secured;
    if (outcome instanceof PrivateStateError)
      process.stderr.write(`private state diagnostic ${JSON.stringify(outcome.diagnostic)}\n`);
    expect(outcome).toBeUndefined();
    expect(synchronousMarker).toBe(true);
    const result = events.find((event) => event.event === 'result');
    expect(result).toMatchObject({
      parentPid: process.pid,
      childCreated: true,
      readinessCaptured: true,
      exitCode: 0,
      timeoutMs: 15000,
      termination: 'exited',
    });
    if (result?.event !== 'result') throw new Error('Missing native process observation');
    expect(result.childPid).not.toBe(process.pid);
    expect(result.scriptPhases.map((phase) => phase.phase)).toEqual([
      'ready',
      'tree-checked',
      'acl-verified',
      'complete',
    ]);
    expect(result.scriptPhases.every((phase) => phase.childPid === result.childPid)).toBe(true);
    expect(
      result.scriptPhases.every((phase) => Number.isFinite(Date.parse(phase.childCreatedAtUtc))),
    ).toBe(true);
    expectPrivate(await snapshot(state), true);
    const file = join(state, 'nexar.config.json');
    await writeFile(file, '{}', { mode: 0o600 });
    expectPrivate(await snapshot(file), false, false);
    // The next startup normalizes the new file: user-owned, protected, explicit private grants.
    await ensurePrivateStateDirectory(state, { onProcessTrace: (event) => events.push(event) });
    expectPrivate(await snapshot(file), false);
    expect(descriptorHash(await snapshot(parent))).toBe(before);
    if (process.env['NEXAR_E2E_STATE_PROCESS_TRACE'] === '1') {
      process.stdout.write(
        `node startup matrix ${JSON.stringify({
          fresh: events.slice(0, 2),
          reused: events.slice(2, 4),
        })}\n`,
      );
    }
  }, 30_000);

  it('rechecks a stale marker and reused directory without trusting its ACL', async () => {
    const parent = await fixture();
    const state = join(parent, 'state');
    await mkdir(state);
    await writeFile(join(state, 'nexar.config.json'), '{"version":1}');
    // A marker is a recognition aid, never evidence that the current ACL is still private.
    await writeFile(join(state, '.nexar-desktop-state'), 'stale');
    await addBroadExplicitGrant(state);
    expect((await snapshot(state)).rules.some((rule) => rule.principal === 'other')).toBe(true);
    await ensurePrivateStateDirectory(state);
    expectPrivate(await snapshot(state), true);
    expectPrivate(await snapshot(join(state, '.nexar-desktop-state')), false);
    await ensurePrivateStateDirectory(state);
    expectPrivate(await snapshot(state), true);
    expect(await readFile(join(state, 'nexar.config.json'), 'utf8')).toBe('{"version":1}');
  }, 30_000);

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

describe.runIf(process.platform === 'win32')('Windows runtime homes boundary', () => {
  const seeded = async (): Promise<string> => {
    const state = join(await fixture(), 'state');
    await mkdir(state);
    await writeFile(join(state, '.nexar-desktop-state'), '');
    return state;
  };

  it('starts with a link and a hard link inside a runtime home', async () => {
    const state = await seeded();
    const home = join(state, 'runtime-homes', 'connection', 'codex');
    await mkdir(home, { recursive: true });
    const target = join(await fixture(), 'target');
    await mkdir(target);
    await symlink(target, join(home, 'vendor-link'), 'junction');
    await writeFile(join(target, 'outside.txt'), 'outside');
    await link(join(target, 'outside.txt'), join(home, 'hard-link'));
    const before = descriptorHash(await snapshot(target));
    await expect(ensurePrivateStateDirectory(state)).resolves.toBeUndefined();
    expect(descriptorHash(await snapshot(target))).toBe(before);
  }, 20_000);

  it('still refuses a linked runtime homes directory', async () => {
    const state = await seeded();
    await symlink(await fixture(), join(state, 'runtime-homes'), 'junction');
    await expect(ensurePrivateStateDirectory(state)).rejects.toThrow(
      'Cannot secure the Desktop state directory',
    );
  }, 20_000);

  it('still walks a directory of that name anywhere else', async () => {
    const state = await seeded();
    await mkdir(join(state, 'nested', 'runtime-homes'), { recursive: true });
    await symlink(await fixture(), join(state, 'nested', 'runtime-homes', 'link'), 'junction');
    await expect(ensurePrivateStateDirectory(state)).rejects.toThrow(
      'Cannot secure the Desktop state directory',
    );
  }, 20_000);
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
