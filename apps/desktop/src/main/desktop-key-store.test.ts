import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { DesktopKeyStore, credentialNames, type DesktopEncryption } from './desktop-key-store.js';
import { ensurePrivateStateDirectory } from './private-state.js';

vi.mock('node:fs/promises', async (original: () => Promise<typeof fs>) => {
  const actual = await original();
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock('node:fs', async (original: () => Promise<typeof syncFs>) => {
  const actual = await original();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const FIRST = 'sk-test-not-a-live-key-1234';
const SECOND = 'sk-replacement-not-live-9876';
const NAME = 'ANTHROPIC_API_KEY';
let root: string;
let path: string;
let encryption: DesktopEncryption;
let store: DesktopKeyStore;

function fakeEncryption(): DesktopEncryption {
  const secrets = new Map<string, string>();
  let next = 0;
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((value: string) => {
      const cipher = `opaque-test-cipher-${++next}`;
      secrets.set(cipher, value);
      return Buffer.from(cipher);
    }),
    decryptString: vi.fn((value: Buffer) => {
      const secret = secrets.get(value.toString());
      if (secret === undefined) throw new Error('cipher unavailable');
      return secret;
    }),
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nexar-key-store-')));
  path = join(root, 'credentials.json');
  encryption = fakeEncryption();
  store = new DesktopKeyStore({ userData: root, encryption });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.rename).mockImplementation(
    (await vi.importActual<typeof fs>('node:fs/promises')).rename,
  );
  vi.mocked(syncFs.openSync).mockReset();
  vi.mocked(syncFs.openSync).mockImplementation(
    (await vi.importActual<typeof syncFs>('node:fs')).openSync,
  );
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(value: unknown): Promise<void> {
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}

async function fileSymlink(target: string, link: string, context: TestContext): Promise<void> {
  try {
    await fs.symlink(target, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Windows file symlinks require Developer Mode or symlink privileges');
    }
    throw error;
  }
}

describe('encrypted Desktop credentials', () => {
  it('does not read or decrypt credentials at construction, and missing values are absent', () => {
    expect(store.metadata(NAME)).toEqual({ present: false });
    expect(store.resolveSecret(NAME)).toBeUndefined();
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });

  it('does not create an unguarded userData root', async () => {
    const missing = join(root, 'missing');
    const other = new DesktopKeyStore({ userData: missing, encryption });
    expect(other.metadata(NAME)).toEqual({ present: false });
    expect(other.resolveSecret(NAME)).toBeUndefined();
    await expect(other.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores opaque ciphertext and last-four only, and resolves just the requested key at call time', async () => {
    await store.save(NAME, FIRST);
    await store.save('OPENAI_API_KEY', SECOND);
    const text = await fs.readFile(path, 'utf8');
    expect(text).not.toContain(FIRST);
    expect(text).not.toContain(SECOND);
    expect(store.metadata(NAME)).toEqual({ present: true, lastFour: '1234' });
    expect(encryption.decryptString).not.toHaveBeenCalled();
    expect(store.resolveSecret(NAME)).toBe(FIRST);
    expect(encryption.decryptString).toHaveBeenCalledTimes(1);
    expect(store.resolveSecret('GROQ_API_KEY')).toBeUndefined();
    expect(encryption.decryptString).toHaveBeenCalledTimes(1);
    const reopened = new DesktopKeyStore({ userData: root, encryption });
    expect(encryption.decryptString).toHaveBeenCalledTimes(1);
    expect(reopened.resolveSecret('OPENAI_API_KEY')).toBe(SECOND);
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(root)).sort()).toEqual(['credentials.json']);
  });

  it('replaces/removes only the named ciphertext and never decrypts during mutation', async () => {
    await store.save(NAME, FIRST);
    await store.save('OPENAI_API_KEY', FIRST);
    await store.save(NAME, SECOND);
    expect(store.metadata(NAME)).toEqual({ present: true, lastFour: '9876' });
    expect(store.metadata('OPENAI_API_KEY')).toEqual({ present: true, lastFour: '1234' });
    await store.remove(NAME);
    expect(store.metadata(NAME)).toEqual({ present: false });
    expect(store.metadata('OPENAI_API_KEY').present).toBe(true);
    await store.remove(NAME);
    expect(encryption.decryptString).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).not.toContain('9876');
  });

  it('serializes concurrent writes, including multiple store instances, without losing entries', async () => {
    const other = new DesktopKeyStore({ userData: root, encryption });
    await Promise.all(
      credentialNames.map((name, index) => (index % 2 ? other : store).save(name, FIRST)),
    );
    for (const name of credentialNames)
      expect(store.metadata(name)).toEqual({ present: true, lastFour: '1234' });
    await Promise.all([store.remove(NAME), other.save('OPENAI_API_KEY', SECOND)]);
    expect(store.metadata(NAME)).toEqual({ present: false });
    expect(store.metadata('OPENAI_API_KEY')).toEqual({ present: true, lastFour: '9876' });
  });

  it.each(['UNKNOWN_KEY', '__proto__', '../credentials', 'OPENAI_API_KEY\n'])(
    'rejects unknown name %s without decrypting',
    async (name) => {
      expect(() => store.metadata(name)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
      expect(() => store.resolveSecret(name)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
      await expect(store.save(name, FIRST)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(store.remove(name)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(encryption.encryptString).not.toHaveBeenCalled();
      expect(encryption.decryptString).not.toHaveBeenCalled();
    },
  );

  it.each(['short', 'a'.repeat(4097), ` ${FIRST}`, `${FIRST}\n`, `${FIRST}/`, `${FIRST}\0`])(
    'rejects invalid key formats',
    async (key) => {
      await expect(store.save(NAME, key)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(encryption.encryptString).not.toHaveBeenCalled();
      expect(syncFs.existsSync(path)).toBe(false);
    },
  );
});

describe('secure backend and privacy', () => {
  it('refuses unavailable encryption and catches availability exceptions', async () => {
    vi.mocked(encryption.isEncryptionAvailable).mockReturnValue(false);
    expect(store.availability()).toBe(false);
    await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(encryption.encryptString).not.toHaveBeenCalled();
    vi.mocked(encryption.isEncryptionAvailable).mockImplementation(() => {
      throw new Error(FIRST);
    });
    expect(store.availability()).toBe(false);
    await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refuses Linux basic_text or a missing backend-reporting method', async () => {
    vi.mocked(encryption.getSelectedStorageBackend!).mockReturnValue('basic_text');
    const linux = new DesktopKeyStore({ userData: root, encryption, platform: 'linux' });
    expect(linux.availability()).toBe(false);
    await expect(linux.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    delete encryption.getSelectedStorageBackend;
    expect(linux.availability()).toBe(false);
    expect(syncFs.existsSync(path)).toBe(false);
  });

  it.each(['unknown', 'unsupported-backend'])(
    'refuses Linux backend %s before storing',
    async (backend) => {
      vi.mocked(encryption.getSelectedStorageBackend!).mockReturnValue(backend);
      const linux = new DesktopKeyStore({ userData: root, encryption, platform: 'linux' });
      expect(linux.availability()).toBe(false);
      await expect(linux.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(encryption.encryptString).not.toHaveBeenCalled();
    },
  );

  it('keeps safe metadata and removal usable without decryption, but refuses secret resolution', async () => {
    await store.save(NAME, FIRST);
    vi.mocked(encryption.isEncryptionAvailable).mockReturnValue(false);
    expect(store.metadata(NAME)).toEqual({ present: true, lastFour: '1234' });
    expect(() => store.resolveSecret(NAME)).toThrow(
      expect.objectContaining({ code: 'AUTH_REQUIRED' }),
    );
    expect(encryption.decryptString).not.toHaveBeenCalled();
    await store.remove(NAME);
    expect(store.metadata(NAME)).toEqual({ present: false });
  });

  it('sanitizes encryption/decryption exceptions with no key, path, cause or provider details', async () => {
    await store.save(NAME, FIRST);
    const leaked = `${FIRST} ${path}`;
    vi.mocked(encryption.decryptString).mockImplementation(() => {
      throw new Error(leaked);
    });
    try {
      store.resolveSecret(NAME);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'Desktop credential storage is unavailable',
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(error)).not.toContain(FIRST);
      expect(JSON.stringify(error)).not.toContain(root);
      expect(String(error)).not.toContain(leaked);
    }
    const before = await fs.readFile(path, 'utf8');
    vi.mocked(encryption.encryptString).mockImplementation(() => {
      throw new Error(leaked);
    });
    const error: unknown = await store.save(NAME, SECOND).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(FIRST);
    expect(JSON.stringify(error)).not.toContain(root);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it.each(['short', `${FIRST}\n`, 'a'.repeat(4097)])(
    'rejects invalid decrypted plaintext',
    async (value) => {
      await store.save(NAME, FIRST);
      vi.mocked(encryption.decryptString).mockReturnValue(value);
      expect(() => store.resolveSecret(NAME)).toThrow(
        expect.objectContaining({ code: 'AUTH_REQUIRED' }),
      );
    },
  );

  it.each([Buffer.alloc(0), Buffer.alloc(16 * 1024 + 1)])(
    'rejects empty or excessive encryption output',
    async (buffer) => {
      vi.mocked(encryption.encryptString).mockReturnValue(buffer);
      await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(syncFs.existsSync(path)).toBe(false);
    },
  );
});

describe('bounded strict storage', () => {
  const cipher = Buffer.from('opaque').toString('base64');
  const entry = { ciphertext: cipher, lastFour: '1234' };
  it.each([
    '{broken',
    null,
    [],
    { version: 2, entries: {} },
    { version: 1, entries: {}, extra: FIRST },
    { version: 1, entries: { UNKNOWN_KEY: entry } },
    { version: 1, entries: { [NAME]: { ...entry, extra: FIRST } } },
    { version: 1, entries: { [NAME]: { ...entry, lastFour: '<x>' } } },
    { version: 1, entries: { [NAME]: { ...entry, lastFour: 'toolong' } } },
    { version: 1, entries: { [NAME]: { ...entry, ciphertext: '!invalid!' } } },
    { version: 1, entries: { [NAME]: { ...entry, ciphertext: cipher + '\n' } } },
  ])('fails closed on malformed data without decrypting or overwriting it', async (value) => {
    await seed(value);
    const before = await fs.readFile(path, 'utf8');
    expect(() => store.metadata(NAME)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(() => store.resolveSecret(NAME)).toThrow(
      expect.objectContaining({ code: 'AUTH_REQUIRED' }),
    );
    await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(encryption.decryptString).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('refuses oversized files before allocating or decrypting', async () => {
    await seed(' '.repeat(256 * 1024 + 1));
    expect(() => store.metadata(NAME)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });
});

describe('file identity and private parent', () => {
  it.skipIf(process.platform !== 'win32')(
    'preserves Windows private inherited ACLs on save, replacement and removal',
    async () => {
      await ensurePrivateStateDirectory(root);
      const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
      if (systemRoot === undefined) throw new Error('Windows test system directory unavailable');
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $env:NEXAR_KEYSTORE_ACL_TEST
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
  ForEach-Object {
    $role = switch ($_.IdentityReference.Value) {
      $user { 'user' }
      'S-1-5-18' { 'SYSTEM' }
      'S-1-5-32-544' { 'Administrators' }
      default { 'other' }
    }
    @{ role = $role; inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString()
      type = $_.AccessControlType.ToString() }
  })
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
@{ protected = $acl.AreAccessRulesProtected; rules = $rules
  ownerAllowed = $owner -in @($user, 'S-1-5-18', 'S-1-5-32-544') } |
  ConvertTo-Json -Depth 4 -Compress
`;
      const acl = (
        file: string,
      ): {
        protected: boolean;
        ownerAllowed: boolean;
        rules: { role: string; inherited: boolean; rights: string; type: string }[];
      } => {
        const result = execFileSync(
          win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          {
            env: { SystemRoot: systemRoot, NEXAR_KEYSTORE_ACL_TEST: file },
            windowsHide: true,
            shell: false,
            timeout: 15_000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        return JSON.parse(result) as ReturnType<typeof acl>;
      };
      expect(acl(root).protected).toBe(true);
      for (const mutate of [
        () => store.save(NAME, FIRST),
        () => store.save(NAME, SECOND),
        () => store.remove(NAME),
      ]) {
        await mutate();
        const permissions = acl(path);
        expect(permissions.ownerAllowed).toBe(true);
        expect(permissions.protected).toBe(false);
        expect(permissions.rules.map((rule) => rule.role).sort()).toEqual([
          'Administrators',
          'SYSTEM',
          'user',
        ]);
        for (const rule of permissions.rules) {
          expect(rule.inherited).toBe(true);
          expect(rule.rights).toBe('FullControl');
          expect(rule.type).toBe('Allow');
        }
      }
      expect(acl(root).protected).toBe(true);
      expect(store.metadata(NAME)).toEqual({ present: false });
    },
    30_000,
  );

  it('rejects hard-linked credential files and leaves the outside target unchanged', async () => {
    const target = join(root, 'outside.json');
    await fs.writeFile(target, '{"version":1,"entries":{}}', { mode: 0o600 });
    await fs.link(target, path);
    expect(() => store.metadata(NAME)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await fs.readFile(target, 'utf8')).toBe('{"version":1,"entries":{}}');
  });

  it('rejects file symlinks without reading or replacing their target', async (context) => {
    const target = join(root, 'outside.json');
    await fs.writeFile(target, '{"version":1,"entries":{}}', { mode: 0o600 });
    await fileSymlink(target, path, context);
    expect(() => store.metadata(NAME)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await fs.readFile(target, 'utf8')).toBe('{"version":1,"entries":{}}');
  });

  it('rejects a linked parent directory', async () => {
    const target = join(root, 'private-target');
    await fs.mkdir(target, { mode: 0o700 });
    const linked = join(root, 'redirect');
    await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const other = new DesktopKeyStore({ userData: linked, encryption });
    expect(() => other.metadata(NAME)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    await expect(other.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('pins the directory identity and rejects replacement at the same canonical path', async () => {
    const state = join(root, 'state');
    await fs.mkdir(state, { mode: 0o700 });
    const other = new DesktopKeyStore({ userData: state, encryption });
    expect(other.metadata(NAME)).toEqual({ present: false });
    await fs.rename(state, join(root, 'original'));
    await fs.mkdir(state, { mode: 0o700 });
    await expect(other.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await fs.readdir(state)).toEqual([]);
  });

  it('rejects a credential file replaced between lstat and open', async () => {
    await store.save(NAME, FIRST);
    const actual = await vi.importActual<typeof syncFs>('node:fs');
    vi.mocked(syncFs.openSync).mockImplementationOnce((file, flags, mode) => {
      const replacement = join(root, 'replacement');
      actual.writeFileSync(replacement, '{"version":1,"entries":{}}', { mode: 0o600 });
      actual.renameSync(replacement, path);
      return actual.openSync(file, flags, mode);
    });
    expect(() => store.resolveSecret(NAME)).toThrow(
      expect.objectContaining({ code: 'AUTH_REQUIRED' }),
    );
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses public POSIX parent/file permissions instead of silently trusting them',
    async () => {
      await fs.chmod(root, 0o755);
      await expect(store.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await fs.chmod(root, 0o700);
      await store.save(NAME, FIRST);
      await fs.chmod(path, 0o644);
      expect(() => store.metadata(NAME)).toThrow(
        expect.objectContaining({ code: 'AUTH_REQUIRED' }),
      );
    },
  );

  it('retries a Windows sharing denial without removing the destination and preserves it on permanent failure', async () => {
    const windows = new DesktopKeyStore({ userData: root, encryption, platform: 'win32' });
    await windows.save(NAME, FIRST);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      expect(await actual.readFile(path, 'utf8')).not.toContain(SECOND);
      throw Object.assign(new Error(FIRST), { code: 'EPERM' });
    });
    await windows.save(NAME, SECOND);
    expect(windows.metadata(NAME).lastFour).toBe('9876');
    const before = await actual.readFile(path, 'utf8');
    let now = 0;
    let attempts = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(fs.rename).mockImplementation(() => {
      if (++attempts === 2) now = 1_000;
      return Promise.reject(Object.assign(new Error(FIRST), { code: 'EPERM' }));
    });
    await expect(windows.save(NAME, FIRST)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(attempts).toBe(2);
    expect(await actual.readFile(path, 'utf8')).toBe(before);
    expect((await fs.readdir(root)).sort()).toEqual(['credentials.json']);
  });
});
