import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnRuntime } from '@nexar/process';
import { describe, expect, it } from 'vitest';
import { runProcess } from './process.js';

// Real Windows command parsing: fakes cannot prove that cmd.exe preserves untrusted argv.
describe.skipIf(process.platform !== 'win32')('Windows npm command shims', () => {
  it('refuses arbitrary batch files and implicit current-directory runtime lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexar unsupported shim '));
    try {
      await writeFile(join(dir, 'unsafe.cmd'), '@echo off\r\necho should never run\r\n');
      expect(() => spawnRuntime('unsafe.cmd', [], { cwd: dir, env: { PATH: dir } })).toThrow(
        expect.objectContaining({ code: 'INTEGRATION_UNAVAILABLE' }),
      );
      expect(() => spawnRuntime('unsafe', [], { cwd: dir, env: { PATH: '' } })).toThrow(
        expect.objectContaining({ code: 'INTEGRATION_UNAVAILABLE' }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves PATHEXT and preserves literal arguments in a path with spaces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexar shim spaces '));
    try {
      await writeFile(join(dir, 'args.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
      // npm installs the POSIX shell shim alongside its Windows .cmd shim.
      await writeFile(join(dir, 'fake-runtime'), '#!/bin/sh\nexit 99\n');
      await writeFile(
        join(dir, 'fake-runtime.cmd'),
        `@echo off\r\n"${process.execPath}" "%~dp0args.cjs" %*\r\n`,
      );
      const args = [
        '',
        'two words',
        'quote"inside',
        'a&b|c<d>e',
        '%PATH%',
        '(paren)',
        'العربية',
        'line one\nline two',
        'trailing\\',
      ];
      const result = await runProcess({
        command: 'fake-runtime',
        args,
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir};${join(process.execPath, '..')}`,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        timeoutMs: 5000,
        signal: new AbortController().signal,
        spawnImpl: spawnRuntime,
      });
      expect(result.kind).toBe('exited');
      if (result.kind !== 'exited') throw new Error('shim failed');
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
