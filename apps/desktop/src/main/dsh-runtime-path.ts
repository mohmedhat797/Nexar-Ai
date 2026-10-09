import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dshLaunchFor, type DshLaunch } from '@nexar/integration-deepseek-harness';

/*
 * Where the DeepSeek Harness runtime comes from (ADR-030). Packaged builds ship it under
 * `<resources>/dsh-runtime/` with a small generated `runtime.json` (`{ "package", "entry" }`) naming
 * the entry script inside `node_modules`; development and tests may name an absolute `.js` entry in
 * the owner's settings (`cowork.dshEntry`), and tests may name one through the test override. The
 * runtime is launched as plain Node through this executable (`ELECTRON_RUN_AS_NODE`), never a shell.
 */

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_ENTRY = 'lib/bin.js';

export interface DshRuntimeSources {
  /** `cowork.dshEntry` from the owner's settings (validated absolute `.js`). */
  readonly settingsEntry?: string | undefined;
  /** The test override; main passes it only under the test-only `NEXAR_DESKTOP_USER_DATA` override. */
  readonly testEntry?: string | undefined;
  /** `process.resourcesPath` of a packaged app. */
  readonly resourcesPath?: string | undefined;
}

/** The packaged entry named by `runtime.json`, or `undefined` when it is absent or not trustworthy. */
export async function packagedDshEntry(resourcesPath: string): Promise<string | undefined> {
  if (!isAbsolute(resourcesPath)) return undefined;
  const root = join(resourcesPath, 'dsh-runtime');
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
    return undefined;
  const { package: name, entry = DEFAULT_ENTRY } = manifest as Record<string, unknown>;
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) return undefined;
  if (typeof entry !== 'string' || !entry.endsWith('.js') || isAbsolute(entry)) return undefined;
  const modules = join(root, 'node_modules');
  const path = resolve(modules, name, entry);
  const rel = relative(modules, path);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    ? undefined
    : path;
}

/** The entry to launch, in order: the test override, the owner's setting, the packaged runtime. */
export async function resolveDshEntry(sources: DshRuntimeSources): Promise<string | undefined> {
  if (sources.testEntry !== undefined && sources.testEntry !== '') return sources.testEntry;
  if (sources.settingsEntry !== undefined) return sources.settingsEntry;
  return sources.resourcesPath === undefined ? undefined : packagedDshEntry(sources.resourcesPath);
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
