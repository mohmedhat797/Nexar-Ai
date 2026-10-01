import { stat as fsStat } from 'node:fs/promises';
import type { DiscoverySource, ResourceDescriptor } from '@nexar/contracts';

/** The part of `fs.Stats` that binary lookup reads. */
export interface FileStatLike {
  isFile(): boolean;
  readonly mode: number;
}

/** `stat` seam (follows symlinks); rejects when the path does not exist. */
export type StatFn = (path: string) => Promise<FileStatLike>;

export interface FindOnPathOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly stat?: StatFn;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  windows: boolean,
): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * True when `binary` exists on `env.PATH` as a regular file (POSIX: with an executable bit;
 * Windows: with a `PATHEXT` extension). A `stat` only: the binary is never executed or read.
 */
export async function isBinaryOnPath(binary: string, options: FindOnPathOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const stat = options.stat ?? ((path: string) => fsStat(path));
  const rawPath = envValue(options.env, 'PATH', windows);
  if (rawPath === undefined || rawPath === '') return false;
  const sep = windows ? ';' : ':';
  const dirSep = windows ? '\\' : '/';
  const extensions = windows
    ? [
        '',
        ...(envValue(options.env, 'PATHEXT', true) ?? DEFAULT_PATHEXT)
          .split(';')
          .filter((e) => e !== ''),
      ]
    : [''];
  for (const raw of rawPath.split(sep)) {
    const dir = windows ? raw.replace(/^"(.*)"$/, '$1') : raw;
    if (dir === '') continue;
    const base = dir.endsWith(dirSep) || (windows && dir.endsWith('/')) ? dir : dir + dirSep;
    for (const ext of extensions) {
      // On Windows a bare name without an executable extension is not runnable.
      if (windows && ext === '') continue;
      try {
        const info = await stat(base + binary + ext);
        if (!info.isFile()) continue;
        if (!windows && (info.mode & 0o111) === 0) continue;
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}

export interface CliDiscoverySourceInput extends FindOnPathOptions {
  /** `cli:<name>`. */
  readonly id: string;
  readonly binary: string;
  /** The integration's default descriptor builder; the found path is never put into it. */
  readonly build: () => ResourceDescriptor;
}

/** A source yielding the integration's default descriptor when its binary is on `PATH`. */
export function cliDiscoverySource(input: CliDiscoverySourceInput): DiscoverySource {
  return {
    id: input.id,
    async discover(): Promise<readonly ResourceDescriptor[]> {
      const found = await isBinaryOnPath(input.binary, {
        env: input.env,
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.stat === undefined ? {} : { stat: input.stat }),
      });
      return found ? [input.build()] : [];
    },
  };
}
