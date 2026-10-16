import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxLauncher, checkSandboxAvailability } from '@nexar/sandbox';
import { COWORK_PROFILE } from '../profiles.js';
import { dshLaunchFor } from '../runtime/resolve.js';
import { makeLogger } from '../test/support.js';
import { runSandboxedCoworkSession } from './sandboxed.js';

const ENTRY =
  process.env['NEXAR_DSH_ENTRY'] ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
const available =
  process.platform === 'linux' && existsSync(ENTRY) && (await checkSandboxAvailability()).available;
const dirs: string[] = [];
const TOKEN = 'sec02-synthetic-gateway-grant';
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nexar-sec02-real-')));
  dirs.push(root);
  const scratch = join(root, 'scratch'),
    home = join(root, 'home'),
    services = join(root, 'services'),
    inputs = join(root, 'inputs');
  for (const dir of [scratch, home, services, inputs]) await mkdir(dir, { mode: 0o700 });
  const node = await realpath(process.execPath);
  const entry = await realpath(ENTRY);
  const launcher = new SandboxLauncher({
    toolchainPaths: [dirname(dirname(node)), dirname(dirname(dirname(dirname(entry))))],
  });
  return { root, scratch, home, services, inputs, node, entry, launcher };
}

describe.skipIf(!available)('SEC02 real Cowork OS boundary (offline)', () => {
  it('kernel hides synthetic host files, other turns, Windows drives, IPC and interop; network is isolated', async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside.txt');
    await writeFile(outside, 'SEC02-SYNTHETIC-OUTSIDE');
    await writeFile(join(f.home, 'private.txt'), 'SEC02-OTHER-TURN-PRIVATE');
    await writeFile(join(f.inputs, 'approved.md'), 'SEC02-READ-ONLY-INPUT');
    await writeFile(join(f.scratch, 'allowed.txt'), 'allowed');
    await symlink(outside, join(f.scratch, 'escape.txt'));
    const host = createNetServer((socket) => socket.end('must-not-reach-host'));
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
    const hostPort = (host.address() as AddressInfo).port;
    const windowsFixture = process.env['NEXAR_SEC02_WINDOWS_FIXTURE'];
    const hidden = [
      outside,
      join(f.home, 'private.txt'),
      '/mnt/c',
      '/mnt/d',
      '/run/WSL',
      '/proc/sys/fs/binfmt_misc/WSLInterop',
      '/var/run/docker.sock',
      '/work/../outside.txt',
      '/work/escape.txt',
      ...(windowsFixture === undefined ? [] : [windowsFixture]),
    ];
    const script = `const fs=require('node:fs'),net=require('node:net'); const result={};
      for(const p of ${JSON.stringify(hidden)}){
        try{fs.readFileSync(p);result[p]='READABLE'}catch(e){result[p]=e.code}
      }
      result.allowed=fs.readFileSync('/work/allowed.txt','utf8');
      result.input=fs.readFileSync('/inputs/cowork/approved.md','utf8');
      try{fs.writeFileSync('/inputs/cowork/approved.md','bad');result.inputWrite='WRITTEN'}catch(e){result.inputWrite=e.code}
      try{fs.writeFileSync(${JSON.stringify(outside)},'bad');result.write='WRITTEN'}catch(e){result.write=e.code}
      ${windowsFixture === undefined ? '' : `try{fs.writeFileSync(${JSON.stringify(windowsFixture)},'bad');result.windowsWrite='WRITTEN'}catch(e){result.windowsWrite=e.code}`}
      result.env=Object.keys(process.env).sort();
      const s=net.connect({host:'127.0.0.1',port:${String(hostPort)}});s.on('connect',()=>{result.network='CONNECTED';s.end();console.log(JSON.stringify(result))});s.on('error',e=>{result.network=e.code;console.log(JSON.stringify(result))});s.setTimeout(2000,()=>{result.network='TIMEOUT';s.destroy();console.log(JSON.stringify(result))});`;
    const prepared = await f.launcher.prepare(
      {
        command: f.node,
        args: ['-e', script],
        env: {},
        workspace: f.scratch,
        workspaceAccess: 'read-write',
        network: { mode: 'none' },
        mounts: [{ hostPath: f.inputs, sandboxPath: '/inputs/cowork', access: 'read-only' }],
      },
      new AbortController().signal,
    );
    try {
      const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(prepared.command, [...prepared.args], {
          cwd: prepared.cwd,
          env: { ...prepared.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let text = '',
          stderr = '';
        child.stdout.on('data', (b: Buffer) => (text += b.toString()));
        child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve({ code, text })
            : reject(new Error(`probe exited ${String(code)}: ${stderr}`)),
        );
      });
      const values = JSON.parse(result.text) as Record<string, unknown>;
      expect(values.allowed).toBe('allowed');
      expect(values.input).toBe('SEC02-READ-ONLY-INPUT');
      expect(['EROFS', 'EACCES', 'EPERM']).toContain(values.inputWrite);
      expect(values.write).toBe('ENOENT');
      for (const path of hidden) expect(['ENOENT', 'EACCES', 'EPERM']).toContain(values[path]);
      if (windowsFixture !== undefined)
        expect(['ENOENT', 'EACCES', 'EPERM']).toContain(values.windowsWrite);
      expect(['ECONNREFUSED', 'ENETUNREACH', 'EACCES', 'EPERM']).toContain(values.network);
      expect(values.env).not.toContain('WSL_INTEROP');
      expect(values.env).not.toContain('SSH_AUTH_SOCK');
      expect(await readFile(outside, 'utf8')).toBe('SEC02-SYNTHETIC-OUTSIDE');
    } finally {
      await prepared.dispose();
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  }, 30_000);

  it('runs actual pinned DSH with Cowork tools, approvals, required context, a read-only input and a draft', async () => {
    const f = await fixture();
    await writeFile(join(f.inputs, 'input.md'), 'SEC02-APPROVED-INPUT');
    const requests: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (s: string) => (raw += s));
      req.on('end', () => {
        const body = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[] };
        requests.push(body);
        const toolCount = body.messages?.filter((m) => m.role === 'tool').length ?? 0;
        const tool =
          toolCount === 0
            ? { name: 'read', args: { file_path: '/inputs/cowork/input.md' } }
            : toolCount === 1
              ? {
                  name: 'write',
                  args: {
                    file_path: '/work/draft.md',
                    content: '# SEC02 verified draft',
                    sandbox_permissions: 'workspace-write',
                    justification: 'Create the requested draft',
                  },
                }
              : undefined;
        const delta =
          tool === undefined
            ? { role: 'assistant', content: 'SEC02-DRAFT-DONE' }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${String(toolCount)}`,
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
    await new Promise<void>((resolve) => server.listen(join(f.services, 'gateway.sock'), resolve));
    await chmod(join(f.services, 'gateway.sock'), 0o600);
    const decisions: string[] = [];
    try {
      const result = await runSandboxedCoworkSession({
        launch: dshLaunchFor(f.entry, { nodeCommand: f.node }),
        profile: COWORK_PROFILE,
        launcher: f.launcher,
        scratchBase: f.root,
        scratchDir: f.scratch,
        dshHome: f.home,
        inputDir: f.inputs,
        nodeCommand: f.node,
        services: { dir: f.services, gateway: true, bridge: false },
        permissionMode: 'read-only',
        control: { baseURL: '', token: TOKEN },
        prompt: 'Read /inputs/cowork/input.md and create the draft in /work.',
        requiredContext: 'SEC02-REQUIRED-CONTEXT',
        parentEnv: { DEEPSEEK_API_KEY: 'must-not-inherit' },
        signal: new AbortController().signal,
        timeoutMs: 90_000,
        logger: makeLogger(),
        decide: (input) => {
          decisions.push(input.tool);
          return Promise.resolve(input.tool === 'write' ? 'allow' : 'reject');
        },
      });
      expect(result.text).toContain('SEC02-DRAFT-DONE');
      expect(decisions).toContain('write');
      expect(await readFile(join(f.scratch, 'draft.md'), 'utf8')).toBe('# SEC02 verified draft');
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(requests.at(-1))).toContain('SEC02-APPROVED-INPUT');
      for (const request of requests)
        expect(JSON.stringify(request)).toContain('SEC02-REQUIRED-CONTEXT');
      const tools = (requests[0]?.tools as { function: { name: string } }[]).map(
        (t) => t.function.name,
      );
      expect(tools).toContain('write');
      expect(tools.some((t) => /bash|pwsh|subagent|workflow|web|plugin_manager/.test(t))).toBe(
        false,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
