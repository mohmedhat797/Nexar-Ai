import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COWORK_PROFILE,
  decideCoworkPermission,
  type LocalAcpSessionOptions,
} from '@nexar/integration-deepseek-harness';
import type { Logger } from '@nexar/contracts';
import { WslCoworkBackend } from './wsl-cowork.js';

const COMMAND = process.env['NEXAR_SEC02_WSL_COMMAND'];
const DISTRO = process.env['NEXAR_SEC02_WSL_DISTRO'] ?? 'nexar-plane';
const TOKEN = 'sec02-synthetic-host-grant';
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe.skipIf(process.platform !== 'win32' || COMMAND === undefined)(
  'SEC02 Windows to actual WSL Cowork',
  () => {
    async function fixture(allow = true, hold = false, marker = 'SEC02-APPROVED-WINDOWS-INPUT') {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'sec02-windows-wsl-')));
      dirs.push(root);
      const scratch = join(root, 'scratch');
      await mkdir(scratch);
      const outside = join(root, 'outside-synthetic.txt');
      await writeFile(outside, 'WINDOWS-OUTSIDE-SYNTHETIC-MARKER');
      const requests: Record<string, unknown>[] = [];
      const server = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (s: string) => (raw += s));
        req.on('end', () => {
          const body = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[] };
          requests.push(body);
          if (hold) return;
          const count = body.messages?.filter((m) => m.role === 'tool').length ?? 0;
          const tool =
            count === 0
              ? { name: 'read', args: { file_path: '/inputs/cowork/input.md' } }
              : count === 1
                ? {
                    name: 'write',
                    args: {
                      file_path: '/work/proposal.md',
                      content: '# SEC02 Windows draft',
                      sandbox_permissions: 'workspace-write',
                      justification: 'Requested draft',
                    },
                  }
                : undefined;
          const delta =
            tool === undefined
              ? { role: 'assistant', content: 'SEC02-WINDOWS-DONE' }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: `sec02_${String(count)}`,
                      type: 'function',
                      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                    },
                  ],
                };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const [d, finish] of [
            [delta, null],
            [{}, tool === undefined ? 'stop' : 'tool_calls'],
          ] as const)
            res.write(
              `data: ${JSON.stringify({ id: 'sec02', object: 'chat.completion.chunk', created: 0, model: 'nexar-control', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`,
            );
          res.end('data: [DONE]\n\n');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const decisions: string[] = [];
      const options: LocalAcpSessionOptions = {
        launch: { command: 'never-spawned-on-windows', args: [], env: {} },
        profile: COWORK_PROFILE,
        scratchBase: root,
        scratchDir: scratch,
        dshHome: join(root, 'unused-home'),
        permissionMode: 'read-only',
        control: {
          baseURL: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`,
          token: TOKEN,
        },
        requiredContext: 'SEC02-WINDOWS-REQUIRED-MEMORY',
        prompt: 'Read the approved input and write a proposal.',
        parentEnv: { DEEPSEEK_API_KEY: 'must-not-inherit' },
        signal: new AbortController().signal,
        timeoutMs: 90_000,
        logger,
        decide: (input) => {
          decisions.push(input.tool);
          const decision = decideCoworkPermission(input, {
            scratchRoot: scratch,
            permission: allow ? 'drafts-only' : 'read-only',
          });
          return Promise.resolve(decision.decision === 'allow' ? 'allow' : 'reject');
        },
      };
      let child: ChildProcess | undefined;
      const trackedSpawn = ((command, args, options) => {
        child = spawn(command, args ?? [], options ?? {});
        return child;
      }) as typeof spawn;
      const backend = new WslCoworkBackend(
        {
          getCodePlane: () =>
            Promise.resolve({
              valid: true,
              value: { distro: DISTRO, command: COMMAND as string, projects: {} },
            }),
        },
        trackedSpawn,
      );
      const bytes = Buffer.from(marker);
      const scope = {
        endpoint: 'never-used-without-delegation',
        standalone: true,
        inputs: [
          {
            name: 'input.md',
            data: bytes.toString('base64'),
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      };
      return {
        root,
        scratch,
        outside,
        requests,
        decisions,
        options,
        backend,
        scope,
        crash: () => child?.kill(),
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }
    it('runs the real isolated helper, relays model calls and approvals, and returns validated draft bytes', async () => {
      const f = await fixture();
      try {
        expect(await f.backend.probe()).toMatchObject({ state: 'ready', version: '0.2.0-rc.2' });
        const result = await f.backend.run(f.options, f.scope);
        expect(result.text).toContain('SEC02-WINDOWS-DONE');
        expect(await readFile(join(f.scratch, 'proposal.md'), 'utf8')).toBe(
          '# SEC02 Windows draft',
        );
        expect(f.decisions).toContain('write');
        expect(f.requests.length).toBeGreaterThanOrEqual(3);
        for (const request of f.requests)
          expect(JSON.stringify(request)).toContain('SEC02-WINDOWS-REQUIRED-MEMORY');
        expect(JSON.stringify(f.requests.at(-1))).toContain('SEC02-APPROVED-WINDOWS-INPUT');
        expect(JSON.stringify(f.requests)).not.toContain('must-not-inherit');
        expect(await readFile(f.outside, 'utf8')).toBe('WINDOWS-OUTSIDE-SYNTHETIC-MARKER');
      } finally {
        await f.close();
      }
    }, 150_000);
    it('preserves read-only denial across the real permission round trip', async () => {
      const f = await fixture(false);
      try {
        await f.backend.run(f.options, f.scope);
        await expect(readFile(join(f.scratch, 'proposal.md'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(f.decisions).toContain('write');
      } finally {
        await f.close();
      }
    }, 150_000);
    it('cancels an actual isolated runtime while its controlled gateway is waiting', async () => {
      const f = await fixture(true, true);
      const controller = new AbortController();
      try {
        const result = f.backend.run({ ...f.options, signal: controller.signal }, f.scope);
        const rejected = expect(result).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
        await expect.poll(() => f.requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
        controller.abort();
        await rejected;
        await expect(readFile(join(f.scratch, 'proposal.md'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        controller.abort();
        await f.close();
      }
    }, 90_000);
    it('keeps simultaneous turns and their approved input contents separate', async () => {
      const a = await fixture(true, false, 'SEC02-TURN-A-PRIVATE');
      const b = await fixture(true, false, 'SEC02-TURN-B-PRIVATE');
      try {
        await Promise.all([a.backend.run(a.options, a.scope), b.backend.run(b.options, b.scope)]);
        expect(JSON.stringify(a.requests)).toContain('SEC02-TURN-A-PRIVATE');
        expect(JSON.stringify(a.requests)).not.toContain('SEC02-TURN-B-PRIVATE');
        expect(JSON.stringify(b.requests)).toContain('SEC02-TURN-B-PRIVATE');
        expect(JSON.stringify(b.requests)).not.toContain('SEC02-TURN-A-PRIVATE');
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    }, 150_000);
    it('fails a disconnected helper without importing partial output and can start a fresh isolated turn', async () => {
      const failed = await fixture(true, true);
      const fresh = await fixture();
      try {
        const running = failed.backend.run(failed.options, failed.scope);
        const rejected = expect(running).rejects.toBeDefined();
        await expect.poll(() => failed.requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
        failed.crash();
        await rejected;
        await expect(readFile(join(failed.scratch, 'proposal.md'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect((await fresh.backend.run(fresh.options, fresh.scope)).text).toContain(
          'SEC02-WINDOWS-DONE',
        );
      } finally {
        await Promise.all([failed.close(), fresh.close()]);
      }
    }, 150_000);
  },
);
