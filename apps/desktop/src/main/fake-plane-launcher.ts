import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PlaneLauncher } from './plane-connection.js';

/**
 * Test support: launches `tests/fixtures/fake-plane.mjs` (a hand-written `nexar plane serve`) with
 * this runtime instead of `wsl.exe`. Never imported by the app itself.
 */
export const FAKE_PLANE_SCRIPT = fileURLToPath(
  new URL('../../../../tests/fixtures/fake-plane.mjs', import.meta.url),
);

export interface FakePlaneLauncher extends PlaneLauncher {
  /** Number of planes launched. */
  launches: number;
  /** The targets the launcher was asked for (owner configuration only). */
  readonly targets: { readonly distro: string; readonly command: string }[];
  /** Every process started, so a test can assert none is left behind. */
  readonly children: ChildProcess[];
}

/** `env` holds only `NEXAR_FAKE_PLANE_*` selectors; nothing of this process's environment leaks. */
export function fakePlaneLauncher(env: Record<string, string> = {}): FakePlaneLauncher {
  const launcher = ((target) => {
    launcher.launches += 1;
    launcher.targets.push({ distro: target.distro, command: target.command });
    const child = spawn(process.execPath, [FAKE_PLANE_SCRIPT], {
      env: {
        ...(process.env['SystemRoot'] === undefined
          ? {}
          : { SystemRoot: process.env['SystemRoot'] }),
        ...env,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    launcher.children.push(child);
    return child;
  }) as FakePlaneLauncher;
  launcher.launches = 0;
  (launcher as { targets: unknown }).targets = [];
  (launcher as { children: unknown }).children = [];
  return launcher;
}
