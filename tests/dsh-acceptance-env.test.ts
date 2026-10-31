import { describe, expect, it } from 'vitest';
import { linuxAcceptanceRuntime } from '../scripts/dsh-runtime/acceptance-env.mjs';

describe('isolated Linux runtime acceptance inputs', () => {
  it('preserves the existing machine runtime when no override is supplied', () => {
    expect(linuxAcceptanceRuntime({})).toEqual({
      NEXAR_DSH_BIN: '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      NEXAR_DSH_TOOLCHAIN: '/opt/node:/opt/dsh/lib/node_modules',
    });
  });

  it('selects an isolated candidate without mutating the machine runtime', () => {
    expect(
      linuxAcceptanceRuntime({
        NEXAR_SEC02_LINUX_DSH_ENTRY:
          '/home/nexar/candidate/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
        NEXAR_SEC02_LINUX_DSH_TOOLCHAIN: '/opt/node:/home/nexar/candidate/runtime/node_modules',
      }),
    ).toEqual({
      NEXAR_DSH_BIN: '/home/nexar/candidate/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
      NEXAR_DSH_TOOLCHAIN: '/opt/node:/home/nexar/candidate/runtime/node_modules',
    });
  });

  it.each(['relative/bin.js', '/a/../bin.js', '/a//bin.js', '/a;echo', '/a\nsecret', '/a b'])(
    'rejects invalid entry %j without echoing it',
    (entry) => {
      expect(() => linuxAcceptanceRuntime({ NEXAR_SEC02_LINUX_DSH_ENTRY: entry })).toThrow(
        /^Invalid isolated Linux acceptance runtime$/,
      );
    },
  );

  it.each(['relative', '/opt/node:', '/opt/node:/a/../b', '/opt/node:/a b'])(
    'rejects invalid toolchain %j',
    (toolchain) => {
      expect(() => linuxAcceptanceRuntime({ NEXAR_SEC02_LINUX_DSH_TOOLCHAIN: toolchain })).toThrow(
        /^Invalid isolated Linux acceptance runtime$/,
      );
    },
  );
});
