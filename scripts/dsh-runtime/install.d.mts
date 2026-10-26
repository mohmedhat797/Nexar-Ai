import type { renameSync } from 'node:fs';
import type { spawnSubprocess } from '../local-ci/process-util.mjs';

export function installDshRuntime(options: {
  target: string;
  pinDir: string;
  run?: typeof spawnSubprocess;
  rename?: typeof renameSync;
  report?: (record: Readonly<Record<string, unknown>>) => void;
}): Promise<string>;
