import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DSH_PINNED_VERSION,
  dshLaunchFor,
  type DshLaunch,
} from '@nexar/integration-deepseek-harness';

/*
 * Where the DeepSeek Harness runtime comes from (ADR-030). Packaged builds ship it under
 * `<resources>/dsh-runtime/` (outside the asar, inside the install directory) with a generated
 * `runtime.json` (`{ "package", "version", "entry" }`) naming the entry script inside `node_modules`;
 * the entry must be a regular file contained in that directory by realpath, with no link on the way,
 * and the manifest's version must be the pinned one. Development and tests may name an absolute
 * `.js` entry in the owner's settings (`cowork.dshEntry`), tests through the test override, and
 * unpackaged builds through `NEXAR_DSH_ENTRY`. The runtime is launched as plain Node through this
 * executable (`ELECTRON_RUN_AS_NODE`), never a shell. Nothing here touches the network.
 */

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_ENTRY = 'lib/bin.js';
const MAX_MANIFEST_BYTES = 4096;

export interface DshRuntimeSources {
  /** The test override; main passes it only under the test-only `NEXAR_DESKTOP_USER_DATA` override. */
  readonly testEntry?: string | undefined;
  /** `cowork.dshEntry` from the owner's settings (validated absolute `.js`). */
  readonly settingsEntry?: string | undefined;
  /** `process.resourcesPath` of a packaged app. */
  readonly resourcesPath?: string | undefined;
  /** `NEXAR_DSH_ENTRY` of an unpackaged (development) build; main never passes it when packaged. */
  readonly devEntry?: string | undefined;
}

const sameFile = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The canonical packaged entry named by `runtime.json`, or `undefined` when it is absent or not
 * trustworthy (bad manifest, version other than the pin, escaping or linked path, not a file).
 */
export async function packagedDshEntry(resourcesPath: string): Promise<string | undefined> {
  if (!isAbsolute(resourcesPath)) return undefined;
  try {
    const root = await realpath(join(resourcesPath, 'dsh-runtime'));
    const raw = await readFile(join(root, 'runtime.json'), 'utf8');
    if (raw.length > MAX_MANIFEST_BYTES) return undefined;
    const manifest: unknown = JSON.parse(raw);
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return undefined;
    }
    const { package: name, version, entry = DEFAULT_ENTRY } = manifest as Record<string, unknown>;
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) return undefined;
    if (version !== DSH_PINNED_VERSION) return undefined;
    if (typeof entry !== 'string' || !entry.endsWith('.js') || isAbsolute(entry)) return undefined;
    const modules = join(root, 'node_modules');
    const path = resolve(modules, name, entry);
    const rel = relative(modules, path);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return undefined;
    }
    // Any link on the way makes the canonical path differ from the one the manifest names.
    const canonical = await realpath(path);
    if (!sameFile(canonical, path)) return undefined;
    if (!(await lstat(canonical)).isFile()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/** The entry to launch: the test override, the owner's setting, the packaged runtime, then development. */
export async function resolveDshEntry(sources: DshRuntimeSources): Promise<string | undefined> {
  if (sources.testEntry !== undefined && sources.testEntry !== '') return sources.testEntry;
  if (sources.settingsEntry !== undefined) return sources.settingsEntry;
  if (sources.resourcesPath !== undefined) {
    const packaged = await packagedDshEntry(sources.resourcesPath);
    if (packaged !== undefined) return packaged;
  }
  return sources.devEntry !== undefined && sources.devEntry !== '' ? sources.devEntry : undefined;
}

/** The launch for an entry: this executable as plain Node. `undefined` when the entry is unusable. */
export function dshLaunchForEntry(entry: string): DshLaunch | undefined {
  try {
    return dshLaunchFor(entry, {
      nodeCommand: process.execPath,
      nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch {
    return undefined;
  }
}
