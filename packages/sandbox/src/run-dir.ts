import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';

/** Linux `sun_path` is 108 bytes including the NUL; stay safely below it. */
export const MAX_SOCKET_PATH_BYTES = 100;

export interface RunDirOptions {
  /** Default `os.tmpdir()`. */
  readonly base?: string;
  /** Default: the current uid. */
  readonly uid?: number;
  /** Default: the current gid. */
  readonly gid?: number;
}

export interface RunDir {
  /** Host path (0700). */
  readonly path: string;
  readonly passwdPath: string;
  readonly groupPath: string;
  /** Where the egress proxy listens (proxy mode). */
  readonly socketPath: string;
  /** Idempotent. */
  remove(): Promise<void>;
}

/** Creates the per-launch directory holding the synthetic passwd/group and the proxy socket. */
export async function createRunDir(options: RunDirOptions = {}): Promise<RunDir> {
  const base = await realpath(options.base ?? tmpdir());
  const path = await mkdtemp(join(base, 'nexar-sbx-'));
  const remove = async (): Promise<void> => {
    await rm(path, { recursive: true, force: true });
  };
  try {
    await chmod(path, 0o700);
    const socketPath = join(path, 'proxy.sock');
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        'Run directory base path is too long for a unix socket',
        {
          details: { limit: MAX_SOCKET_PATH_BYTES },
        },
      );
    }
    const uid = options.uid ?? process.getuid?.() ?? 0;
    const gid = options.gid ?? process.getgid?.() ?? 0;
    const passwdPath = join(path, 'passwd');
    const groupPath = join(path, 'group');
    await writeFile(passwdPath, `agent:x:${uid}:${gid}:agent:/home/agent:/bin/sh\n`, {
      mode: 0o644,
    });
    await writeFile(groupPath, `agent:x:${gid}:\n`, { mode: 0o644 });
    let removed: Promise<void> | undefined;
    return {
      path,
      passwdPath,
      groupPath,
      socketPath,
      remove: () => (removed ??= remove()),
    };
  } catch (error) {
    await remove();
    throw error;
  }
}
