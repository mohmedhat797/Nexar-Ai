import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kernelString, parseWslConf, readBoundedText } from './plane-readiness.js';

describe('parseWslConf', () => {
  it('keeps the WSL defaults for an empty file or absent keys', () => {
    expect(parseWslConf('')).toEqual({ automount: 'enabled', interop: 'enabled' });
    expect(parseWslConf('[boot]\nsystemd=true\n')).toEqual({
      automount: 'enabled',
      interop: 'enabled',
    });
  });

  it('reads both toggles independently', () => {
    const text = '[automount]\nenabled=false\n[interop]\nenabled=true\n';
    expect(parseWslConf(text)).toEqual({ automount: 'disabled', interop: 'enabled' });
    expect(parseWslConf('[interop]\nenabled=false\n')).toEqual({
      automount: 'enabled',
      interop: 'disabled',
    });
  });

  it('tolerates spacing, case, quotes, CRLF and comments', () => {
    const text = [
      '# managed by the plane image',
      '[ Automount ]  # section comment',
      '  Enabled = "FALSE"  # inline',
      ';another comment',
      '[INTEROP]\r',
      "enabled='false'\r",
    ].join('\r\n');
    expect(parseWslConf(text)).toEqual({ automount: 'disabled', interop: 'disabled' });
  });

  it('ignores the key in other sections and outside any section', () => {
    expect(
      parseWslConf('enabled=false\n[boot]\nenabled=false\n[network]\nenabled=false\n'),
    ).toEqual({
      automount: 'enabled',
      interop: 'enabled',
    });
  });

  it('reports a value that is not true or false as unknown', () => {
    expect(parseWslConf('[automount]\nenabled=maybe\n[interop]\nenabled=\n')).toEqual({
      automount: 'unknown',
      interop: 'unknown',
    });
  });

  it('lets the last assignment win', () => {
    expect(parseWslConf('[automount]\nenabled=true\nenabled=false\n').automount).toBe('disabled');
  });

  it('does not treat appendix keys as the toggle', () => {
    expect(parseWslConf('[automount]\nenabledX=false\noptions=enabled=false\n').automount).toBe(
      'enabled',
    );
  });
});

describe('kernelString', () => {
  it('trims, strips control characters and bounds the length', () => {
    expect(kernelString('5.15.153.1-microsoft-standard-WSL2\n')).toBe(
      '5.15.153.1-microsoft-standard-WSL2',
    );
    expect(kernelString('a\u001b[31mb')).toBe('a [31mb');
    expect(kernelString('k'.repeat(500))).toHaveLength(200);
  });

  it('is unknown when there is nothing', () => {
    expect(kernelString(undefined)).toBe('unknown');
    expect(kernelString('  \n')).toBe('unknown');
  });
});

describe('readBoundedText', () => {
  it('reads at most the bound and returns undefined for a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexar-readiness-'));
    try {
      await writeFile(join(dir, 'big'), 'x'.repeat(1000));
      expect(await readBoundedText(join(dir, 'big'), 100)).toBe('x'.repeat(100));
      expect(await readBoundedText(join(dir, 'missing'), 100)).toBeUndefined();
      expect(await readBoundedText(dir, 100)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
