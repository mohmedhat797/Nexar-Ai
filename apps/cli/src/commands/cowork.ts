import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { NexarError, isNexarError } from '@nexar/contracts';
import {
  COWORK_PROFILE,
  DSH_PINNED_VERSION,
  JsonRpcStdioClient,
  dshLaunchFor,
  parseCoworkFiles,
  readCoworkFile,
  stageCoworkFiles,
  runSandboxedCoworkSession,
  coworkScratchEscape,
} from '@nexar/integration-deepseek-harness';
import { SandboxLauncher, checkSandboxAvailability } from '@nexar/sandbox';
import { parseWslConf } from '../plane-readiness.js';
import { relayScriptPath } from '../relay-path.js';
import type { Command, CommandContext } from '../args.js';
import { UsageError } from '../io.js';

const PROTOCOL = 'nexar-cowork@1';
const MAX_BYTES = 4 * 1024 * 1024;
const record = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new NexarError('VALIDATION_ERROR', 'Invalid Cowork frame');
  return v as Record<string, unknown>;
};

async function serve(ctx: CommandContext): Promise<number> {
  if (ctx.io.stdinChunks === undefined || process.platform !== 'linux')
    throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork requires the Linux sandbox helper');
  const node = await realpath(process.execPath);
  // Owner configuration only. The remote run request cannot choose a runtime or host path.
  const entry = await realpath(
    typeof ctx.values['dsh-entry'] === 'string'
      ? ctx.values['dsh-entry']
      : '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  );
  const runtimeRoot = dirname(dirname(entry));
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (manifest.version !== DSH_PINNED_VERSION)
    throw new NexarError('INTEGRATION_UNAVAILABLE', 'Cowork runtime version is unsupported');
  const wslConf = parseWslConf(await readFile('/etc/wsl.conf', 'utf8'));
  if (wslConf.automount !== 'disabled' || wslConf.interop !== 'disabled')
    throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork requires a hardened WSL distribution');
  const availability = await checkSandboxAvailability();
  if (!availability.available || availability.socatPath === undefined)
    throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork sandbox prerequisites are unavailable');
  const launcher = new SandboxLauncher({
    toolchainPaths: [dirname(dirname(node)), dirname(dirname(runtimeRoot))],
  });
  const peer = new JsonRpcStdioClient({
    input: Readable.from(ctx.io.stdinChunks()),
    output: new Writable({
      write(chunk: Buffer, _encoding, done) {
        ctx.io.stdout(chunk.toString('utf8'));
        done();
      },
    }),
  });
  const controller = new AbortController();
  let active: Promise<unknown> | undefined;
  let used = false;
  const closed = new Promise<void>((resolve) =>
    peer.onClose(() => {
      controller.abort();
      resolve();
    }),
  );
  peer.setRequestHandler((request) => {
    if (request.method === 'cowork/hello')
      return Promise.resolve({
        result: { protocol: PROTOCOL, version: manifest.version, isolation: 'WSL2_BUBBLEWRAP' },
      });
    if (request.method === 'cowork/cancel') {
      controller.abort();
      return Promise.resolve({ result: true });
    }
    if (request.method !== 'cowork/run' || used) return undefined;
    used = true;
    active = run(request.params).then(
      (result) => ({ result }),
      (error: unknown) => ({
        error: { code: -32000, message: isNexarError(error) ? error.code : 'INTERNAL_ERROR' },
      }),
    );
    return active as Promise<{ result: unknown } | { error: { code: number; message: string } }>;
  });

  async function run(raw: unknown): Promise<unknown> {
    const p = record(raw);
    if (
      Object.keys(p).some(
        (k) =>
          !['prompt', 'requiredContext', 'token', 'timeoutMs', 'inputs', 'standalone'].includes(k),
      ) ||
      typeof p.prompt !== 'string' ||
      p.prompt.length > 256_000 ||
      typeof p.requiredContext !== 'string' ||
      p.requiredContext.length > 32_768 ||
      typeof p.token !== 'string' ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(p.token) ||
      typeof p.timeoutMs !== 'number' ||
      !Number.isInteger(p.timeoutMs) ||
      p.timeoutMs < 1000 ||
      p.timeoutMs > 3_600_000 ||
      typeof p.standalone !== 'boolean'
    )
      throw new NexarError('VALIDATION_ERROR', 'Invalid Cowork run');
    const inputs = parseCoworkFiles(p.inputs);
    const token = p.token;
    const base = await realpath(await mkdtemp(join(tmpdir(), 'nexar-cowork-')));
    const scratch = join(base, 'scratch'),
      home = join(base, 'home'),
      inputDir = join(base, 'inputs'),
      services = join(base, 'services');
    const sockets = new Set<Socket>();
    const gateway = createHttpServer((req, res) => {
      void (async () => {
        if (
          req.method !== 'POST' ||
          req.url !== '/v1/chat/completions' ||
          req.headers.authorization !== `Bearer ${token}`
        ) {
          res.writeHead(403).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BYTES) throw new Error('size');
          chunks.push(chunk as Buffer);
        }
        const answer = record(
          await peer.request(
            'cowork/gateway',
            { body: Buffer.concat(chunks).toString('base64') },
            { signal: controller.signal, timeoutMs: 150_000 },
          ),
        );
        if (
          typeof answer.status !== 'number' ||
          !Number.isInteger(answer.status) ||
          answer.status < 100 ||
          answer.status > 599 ||
          typeof answer.body !== 'string' ||
          answer.body.length > 12 * 1024 * 1024 ||
          !['application/json', 'text/event-stream'].includes(String(answer.contentType))
        )
          throw new Error('reply');
        res.writeHead(answer.status, { 'content-type': String(answer.contentType) });
        res.end(Buffer.from(answer.body, 'base64'));
      })().catch(() => {
        res.writeHead(502).end();
      });
    });
    const bridge = createNetServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let buffer = '';
      let busy = false;
      socket.setTimeout(150_000, () => socket.destroy());
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_BYTES) {
          socket.destroy();
          return;
        }
        if (!buffer.includes('\n')) return;
        if (busy || buffer.indexOf('\n') !== buffer.length - 1) {
          socket.destroy();
          return;
        }
        busy = true;
        const frame = buffer;
        buffer = '';
        void peer
          .request('cowork/bridge', { frame }, { signal: controller.signal, timeoutMs: 150_000 })
          .then((answer) => {
            if (typeof answer !== 'string' || answer.length > MAX_BYTES) throw new Error('reply');
            socket.write(answer);
            busy = false;
          })
          .catch(() => socket.destroy());
      });
    });
    gateway.maxConnections = 4;
    gateway.requestTimeout = 150_000;
    bridge.maxConnections = 4;
    gateway.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    try {
      for (const dir of [scratch, home, inputDir, services]) await mkdir(dir, { mode: 0o700 });
      await stageCoworkFiles(inputDir, inputs);
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          gateway.once('error', reject);
          gateway.listen(join(services, 'gateway.sock'), resolve);
        }),
        new Promise<void>((resolve, reject) => {
          bridge.once('error', reject);
          bridge.listen(join(services, 'bridge.sock'), resolve);
        }),
      ]);
      await Promise.all(
        ['gateway.sock', 'bridge.sock'].map((name) => chmod(join(services, name), 0o600)),
      );
      const relay = relayScriptPath();
      if (relay === undefined)
        throw new NexarError('SANDBOX_UNAVAILABLE', 'Cowork bridge relay is unavailable');
      const outcome = await runSandboxedCoworkSession({
        launch: dshLaunchFor(entry, { nodeCommand: node }),
        profile: COWORK_PROFILE,
        launcher,
        scratchBase: base,
        scratchDir: scratch,
        dshHome: home,
        inputDir,
        nodeCommand: node,
        services: { dir: services, gateway: true, bridge: true, relayScript: relay },
        permissionMode: 'read-only',
        control: { baseURL: '', token },
        prompt: `${p.prompt}\n\nApproved inputs are read-only files in /inputs/cowork. Draft output belongs in /work.`,
        requiredContext: p.requiredContext,
        parentEnv: {},
        signal: controller.signal,
        timeoutMs: p.timeoutMs,
        logger: ctx.logger,
        standalone: p.standalone,
        decide: async (input) => {
          const rawInput =
            typeof input.rawInput === 'object' && input.rawInput !== null
              ? (input.rawInput as Record<string, unknown>)
              : {};
          const target = typeof rawInput.file_path === 'string' ? rawInput.file_path : undefined;
          let local: string | undefined;
          if (input.tool === 'write' || input.tool === 'edit') {
            if (target === undefined || target.includes('\\')) return 'reject';
            const rel = posix.relative('/work', posix.resolve('/work', target));
            if (rel === '' || rel.startsWith('..') || posix.isAbsolute(rel)) return 'reject';
            local = join(scratch, rel);
            if (await coworkScratchEscape(scratch, local)) return 'reject';
          }
          const answer = await peer.request('cowork/permission', input, {
            signal: controller.signal,
            timeoutMs: p.timeoutMs as number,
          });
          return answer === 'allow' &&
            (local === undefined || !(await coworkScratchEscape(scratch, local)))
            ? 'allow'
            : 'reject';
        },
        onEvent: (event) => {
          void peer.notify('cowork/event', event).catch(() => undefined);
        },
      });
      const files = [];
      for (const name of (await readdir(scratch)).sort()) {
        if (!/\.(md|txt|json|csv)$/i.test(name)) continue;
        try {
          files.push(await readCoworkFile(scratch, name));
        } catch {
          /* Untrusted outputs are never followed. */
        }
      }
      return { ...outcome, files: parseCoworkFiles(files) };
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [gateway, bridge].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await rm(base, { recursive: true, force: true });
    }
  }
  await closed;
  await active;
  return 0;
}

export const coworkCommand: Command = {
  name: 'cowork',
  summary: 'Private isolated Cowork stdio helper',
  usage: 'nexar cowork serve --stdio',
  options: { stdio: { type: 'boolean' }, 'dsh-entry': { type: 'string' } },
  async run(ctx) {
    if (ctx.positionals.join(' ') !== 'serve' || ctx.values.stdio !== true)
      throw new UsageError('use cowork serve --stdio');
    return serve(ctx);
  },
};
