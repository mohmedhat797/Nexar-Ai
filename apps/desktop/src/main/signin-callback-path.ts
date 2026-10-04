import { fileURLToPath } from 'node:url';
import type { ControlGatewayLaunch } from './control-gateway-path.js';

/*
 * How Desktop launches the ChatGPT sign-in callback child: this executable as plain Node
 * (`ELECTRON_RUN_AS_NODE`) running the self-contained `signin-callback.cjs` that `scripts/build.mjs`
 * bundles beside `main.js`. Packaged, the file is unpacked from the asar.
 */

const ASAR = /([\\/])app\.asar([\\/])/;

export function signinCallbackScriptPath(moduleUrl: string = import.meta.url): string {
  const path = fileURLToPath(new URL('./signin-callback.cjs', moduleUrl));
  return path.replace(ASAR, '$1app.asar.unpacked$2');
}

export function signinCallbackLaunch(moduleUrl?: string): ControlGatewayLaunch {
  return {
    command: process.execPath,
    args: [signinCallbackScriptPath(moduleUrl)],
    // Explicit and minimal: the child inherits nothing else.
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}
