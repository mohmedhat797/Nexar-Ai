import { fileURLToPath } from 'node:url';

/*
 * How Desktop launches the loopback Chat Completions translator (ADR-027 section 7A): this executable
 * as plain Node (`ELECTRON_RUN_AS_NODE`) running the self-contained `control-gateway.cjs` that
 * `scripts/build.mjs` bundles beside `main.js`. Packaged, the file is unpacked from the asar.
 */

const ASAR = /([\\/])app\.asar([\\/])/;

export interface ControlGatewayLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function controlGatewayScriptPath(moduleUrl: string = import.meta.url): string {
  const path = fileURLToPath(new URL('./control-gateway.cjs', moduleUrl));
  return path.replace(ASAR, '$1app.asar.unpacked$2');
}

export function controlGatewayLaunch(moduleUrl?: string): ControlGatewayLaunch {
  return {
    command: process.execPath,
    args: [controlGatewayScriptPath(moduleUrl)],
    // Explicit and minimal: the child inherits nothing else.
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}
