import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { relayScriptPath } from './relay-path.js';

const run = promisify(execFile);

describe('bridge relay bundle', () => {
  it('resolves beside the compiled CLI modules', () => {
    const path = relayScriptPath('file:///C:/dev/nexar/apps/cli/dist/relay-path.js');
    expect(path.replace(/\\/g, '/')).toMatch(/\/apps\/cli\/dist\/bridge-relay\.cjs$/);
  });

  it('builds into one self-contained CommonJS file that runs without the workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexar-relay-'));
    try {
      const out = join(dir, 'bridge-relay.cjs');
      const script = fileURLToPath(new URL('../scripts/build-relay.mjs', import.meta.url));
      await run(process.execPath, [script, out]);
      expect((await stat(out)).isFile()).toBe(true);
      expect(await readFile(out, 'utf8')).not.toContain('@nexar/');
      // Without NEXAR_BRIDGE_ENDPOINT it must stop on its own, not hang.
      const result = await run(process.execPath, [out], { env: {}, timeout: 10_000 }).then(
        () => 0,
        (error: { code?: number }) => error.code ?? -1,
      );
      expect(result).not.toBe(-1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
