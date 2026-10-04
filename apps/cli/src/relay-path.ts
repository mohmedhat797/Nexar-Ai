import { fileURLToPath } from 'node:url';

/**
 * Where the bundled bridge relay (`scripts/build-relay.mjs`) sits: beside the compiled CLI modules in
 * `dist/`. The plane passes it as `LaunchServices.relayScript` so a lane's sandbox can run it.
 */
export function relayScriptPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('./bridge-relay.cjs', moduleUrl));
}
