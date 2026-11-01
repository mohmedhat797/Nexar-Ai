import { describe, expect, it } from 'vitest';
import {
  linuxAcceptanceNode,
  linuxAcceptanceRuntime,
} from '../scripts/dsh-runtime/acceptance-env.mjs';

describe('isolated Linux runtime acceptance inputs', () => {
  it('uses the exact versioned Node toolchain while preserving the machine DSH selection', () => {
    expect(linuxAcceptanceRuntime({})).toEqual({
      NEXAR_DSH_BIN: '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      NEXAR_DSH_TOOLCHAIN: `/opt/node-v24.22.2-linux-${process.arch}:/opt/dsh/lib/node_modules`,
    });
  });

  it('validates an explicit Linux Node executable without falling back to the old toolchain', () => {
    expect(linuxAcceptanceNode({ NEXAR_SEC02_LINUX_NODE_BIN: '/opt/candidate/bin/node' })).toBe(
      '/opt/candidate/bin/node',
    );
    for (const value of ['node', '/a/../node', '/a//node', '/a b', '/a;echo']) {
      expect(() => linuxAcceptanceNode({ NEXAR_SEC02_LINUX_NODE_BIN: value })).toThrow(
        /^Invalid isolated Linux Node executable$/,
      );
    }
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
