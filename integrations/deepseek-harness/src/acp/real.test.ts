import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxLauncher } from '@nexar/sandbox';
import { makeTempDir } from '../test/support.js';
import { SANDBOX_DSH_HOME, spawnPrepared } from './launch.js';

// Opt-in: runs the real `dsh --profile acp` through the REAL SandboxLauncher (no network, no
// credentials) and performs initialize -> session/new -> session/close. No prompt, no model call.
// NEXAR_DSH_TOOLCHAIN is a colon-separated list of host dirs that make `dsh` and node visible.
describe.skipIf(!process.env.NEXAR_DSH_BIN)(
  'dsh --profile acp (real, sandboxed, credential-free)',
  () => {
    it('completes the ACP handshake and opens and closes a session', async () => {
      const root = realpathSync(makeTempDir('nexar-dsh-acp-real-'));
      const workspace = join(root, 'ws');
      const state = join(root, 'dsh-state');
      mkdirSync(workspace);
      mkdirSync(state, { mode: 0o700 });

      const launcher = new SandboxLauncher({
        toolchainPaths: (process.env.NEXAR_DSH_TOOLCHAIN ?? '').split(':').filter(Boolean),
        runDirBase: root,
      });
      const prepared = await launcher.prepare(
        {
          command: process.env.NEXAR_DSH_BIN as string,
          args: ['--profile', 'acp'],
          env: { DSH_HOME: SANDBOX_DSH_HOME },
          workspace,
          workspaceAccess: 'read-write',
          network: { mode: 'none' },
          mounts: [{ hostPath: state, sandboxPath: SANDBOX_DSH_HOME, access: 'read-write' }],
        },
        new AbortController().signal,
      );
      const proc = spawnPrepared(prepared);
      try {
        const init = await proc.client.request<{ protocolVersion?: number }>(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          { timeoutMs: 60_000 },
        );
        expect(init.protocolVersion).toBe(1);

        const created = await proc.client.request<{ sessionId?: string }>(
          'session/new',
          { cwd: prepared.workspacePath, mcpServers: [] },
          { timeoutMs: 60_000 },
        );
        expect(typeof created.sessionId).toBe('string');

        await proc.client.request(
          'session/close',
          { sessionId: created.sessionId },
          { timeoutMs: 30_000 },
        );
      } finally {
        await proc.stop();
        await prepared.dispose();
      }
    }, 180_000);
  },
);
