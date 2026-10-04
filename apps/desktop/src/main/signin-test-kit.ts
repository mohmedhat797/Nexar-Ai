import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ControlGatewayLaunch } from './control-gateway-path.js';

/*
 * Test kit: bundles the real sign-in callback child (as `scripts/build.mjs` does) into a temporary
 * directory so tests can run the actual artifact as a subprocess. Not used by production code.
 */

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export async function bundleSigninChild(): Promise<{
  readonly launch: ControlGatewayLaunch;
  readonly dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'nexar-signin-child-'));
  const outfile = join(dir, 'signin-callback.cjs');
  await build({
    entryPoints: [at('../signin-callback/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    alias: {
      '@nexar/integration-openai-account': at(
        '../../../../integrations/openai-account/src/index.ts',
      ),
    },
  });
  return {
    dir,
    launch: {
      command: process.execPath,
      args: [outfile],
      // Same shape as production's explicit env (SystemRoot only because Windows Node needs it).
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...(process.platform === 'win32' && process.env['SystemRoot'] !== undefined
          ? { SystemRoot: process.env['SystemRoot'] }
          : {}),
      },
    },
  };
}
