import { fileURLToPath } from 'node:url';

/*
 * How OpenWorker launches the Intelligence Bridge relay (ADR-027 section 9a): this executable as plain
 * Node (`ELECTRON_RUN_AS_NODE`) running the self-contained `bridge-relay.cjs` that `scripts/build.mjs`
 * bundles beside `main.js`. Packaged, the file is unpacked from the asar (a child cannot read it
 * from inside the archive).
 */

const ASAR = /([\\/])app\.asar([\\/])/;

export interface RelayLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function relayScriptPath(moduleUrl: string = import.meta.url): string {
  const path = fileURLToPath(new URL('./bridge-relay.cjs', moduleUrl));
  return path.replace(ASAR, '$1app.asar.unpacked$2');
}

export function relayLaunch(moduleUrl?: string): RelayLaunch {
  return {
    command: process.execPath,
    args: [relayScriptPath(moduleUrl)],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}
