import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isOwnerCodexConnectionId,
  NexarError,
  type PersistentConnectionRecord,
} from '@nexar/contracts';
import { ensurePrivateStateDirectory, RUNTIME_HOMES_DIRECTORY } from './private-state.js';

/** Beside the home, not in it: a process that can write the home cannot forge its owner. */
const MARKER_FILE = '.nexar-runtime-home';
/** Left by the state guard, which secures a connection's directory before the home exists. */
const GUARD_MARKER = '.nexar-desktop-state';
const MARKER_BYTES = 64;

export interface CodexHomeStoreOptions {
  readonly userData: string;
  /** Test seam for the Windows ACL tool. */
  readonly secureDirectory?: (path: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
}

function refused(): NexarError {
  // Fixed text: never a path, id or account.
  return new NexarError('CONFIGURATION_ERROR', 'Codex home does not match its connection');
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Filesystem errors carry paths, which must not cross a package boundary. */
async function contained<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw error instanceof NexarError ? error : refused();
  }
}

/**
 * Private homes under one fixed root. Every path is derived from the immutable connection id, so
 * none crosses IPC, and nothing inside a home is opened: only the marker beside it.
 */
export class CodexHomeStore {
  private readonly root: string;
  private readonly secure: (path: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: CodexHomeStoreOptions) {
    this.root = join(options.userData, RUNTIME_HOMES_DIRECTORY);
    this.secure = options.secureDirectory ?? ((path) => ensurePrivateStateDirectory(path));
    this.platform = options.platform ?? process.platform;
  }

  /** A home reached across the WSL boundary is on the other host, whose permissions do not apply. */
  private offHost(): boolean {
    const { userData } = this.options;
    return (
      /^[\\/]{2}/.test(userData) || (this.platform === 'linux' && /^\/mnt(?:\/|$)/.test(userData))
    );
  }

  private connectionDir(record: PersistentConnectionRecord): string {
    const scope = record.credentialScope;
    if (
      !isOwnerCodexConnectionId(record.id) ||
      record.builtIn ||
      record.nativeHome === undefined ||
      scope.kind !== 'native-home' ||
      scope.runtimeId !== 'codex' ||
      scope.home !== 'private' ||
      this.offHost()
    )
      throw refused();
    return join(this.root, record.id);
  }

  /** A link anywhere on the way would redirect the home outside the fixed root. */
  private async assertDirectory(path: string): Promise<'present' | 'absent'> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw refused();
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid) throw refused();
      return 'present';
    } catch (error) {
      if (missing(error)) return 'absent';
      throw error;
    }
  }

  private async readMarker(dir: string): Promise<string | undefined> {
    let file;
    try {
      file = await open(join(dir, MARKER_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (missing(error)) return undefined;
      throw refused();
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MARKER_BYTES) throw refused();
      const bytes = Buffer.alloc(MARKER_BYTES);
      const { bytesRead } = await file.read(bytes, 0, MARKER_BYTES, 0);
      return bytes.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  }

  private async assertPrivate(path: string): Promise<void> {
    if (this.platform === 'win32') return; // The ACL tool verified the descriptor at creation.
    if (((await lstat(path)).mode & 0o077) !== 0) throw refused();
  }

  /** The verified home, or `undefined` while none exists. Any mismatch refuses. */
  resolve(record: PersistentConnectionRecord): Promise<string | undefined> {
    return contained(async () => {
      const dir = this.connectionDir(record);
      if ((await this.assertDirectory(this.options.userData)) === 'absent') throw refused();
      if ((await this.assertDirectory(this.root)) === 'absent') return undefined;
      if ((await this.assertDirectory(dir)) === 'absent') return undefined;
      if ((await this.readMarker(dir)) !== record.nativeHome?.marker) throw refused();
      const home = join(dir, 'codex');
      if ((await this.assertDirectory(home)) === 'absent') return undefined;
      await this.assertPrivate(dir);
      await this.assertPrivate(home);
      return home;
    });
  }

  /** Creates and verifies the private home before any process can write to it. */
  ensure(record: PersistentConnectionRecord): Promise<string> {
    return contained(async () => {
      const dir = this.connectionDir(record);
      if ((await this.assertDirectory(this.options.userData)) === 'absent') throw refused();
      if ((await this.assertDirectory(this.root)) === 'absent') {
        await mkdir(this.root, { mode: 0o700 });
        await this.assertDirectory(this.root);
      }
      await this.sweep(record);
      const present = (await this.assertDirectory(dir)) === 'present';
      const marker = present ? await this.readMarker(dir) : undefined;
      if (marker === undefined) {
        // An interrupted creation leaves nothing else. Anything more is not this store's.
        if (present && (await readdir(dir)).some((entry) => entry !== GUARD_MARKER))
          throw refused();
        // Also on a retry: the descriptor is only verified here, while the directory is empty.
        await this.secure(dir);
        if ((await this.assertDirectory(dir)) === 'absent') throw refused();
        if (this.platform !== 'win32') await chmod(dir, 0o700);
        const file = await open(
          join(dir, MARKER_FILE),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          await file.writeFile(record.nativeHome!.marker);
        } finally {
          await file.close();
        }
      } else if (marker !== record.nativeHome?.marker) {
        throw refused();
      }
      const home = join(dir, 'codex');
      if ((await this.assertDirectory(home)) === 'absent') await mkdir(home, { mode: 0o700 });
      const verified = await this.resolve(record);
      if (verified === undefined) throw refused();
      return verified;
    });
  }

  /** What an interrupted removal left. It holds no marker to verify, only one known name. */
  private async sweep(record: PersistentConnectionRecord): Promise<void> {
    await rm(this.doomed(record), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  private doomed(record: PersistentConnectionRecord): string {
    return join(this.root, `.deleting-${record.id}`);
  }

  /**
   * Removes one verified home. Links inside it are unlinked, never followed. The rename makes this
   * all-or-nothing: an interrupted removal cannot leave a half-deleted home that looks unmarked.
   */
  remove(record: PersistentConnectionRecord): Promise<void> {
    return contained(async () => {
      const dir = this.connectionDir(record);
      if ((await this.assertDirectory(this.options.userData)) === 'absent') throw refused();
      if ((await this.assertDirectory(this.root)) === 'absent') return;
      await this.sweep(record);
      if ((await this.assertDirectory(dir)) === 'absent') return;
      if ((await this.readMarker(dir)) !== record.nativeHome?.marker) throw refused();
      await rename(dir, this.doomed(record));
      await this.sweep(record);
    });
  }
}
