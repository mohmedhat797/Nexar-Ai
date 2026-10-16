import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import { NexarError, isNexarError, normalizeReviewOf } from '@nexar/contracts';
import {
  COWORK_HELPER_CAPABILITIES,
  COWORK_HELPER_PROTOCOL,
  COWORK_HELPER_PROTOCOL_VERSION,
  COWORK_HELPER_RELEASE,
  DSH_PINNED_VERSION,
  JsonRpcStdioClient,
  parseCoworkFiles,
  stageCoworkFiles,
  type CoworkFile,
  type DshRuntimeStatus,
  type LocalAcpResult,
  type LocalAcpSessionOptions,
} from '@nexar/integration-deepseek-harness';
import { terminateProcessTree } from '@nexar/process';
import type { SettingsStore } from './settings-store.js';

export interface CoworkExecutionBackend {
  probe(): Promise<DshRuntimeStatus>;
  run(
    options: LocalAcpSessionOptions,
    scope: {
      readonly endpoint: string;
      readonly standalone: boolean;
      readonly inputs: readonly CoworkFile[];
    },
  ): Promise<LocalAcpResult>;
}

const Permission = z.strictObject({
  tool: z.string().min(1).max(128),
  kind: z.string().max(128),
  toolCallId: z.string().min(1).max(256),
  rawInput: z.unknown(),
  // PermissionDecisionInput is deliberately smaller than an upstream tool/approval object.
});
const fail = (): NexarError =>
  new NexarError(
    'SANDBOX_UNAVAILABLE',
    'Isolated Cowork is unavailable; check the WSL sandbox helper',
  );
const object = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
};

export function coworkWslArguments(target: {
  readonly distro: string;
  readonly command: string;
}): string[] {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.distro) ||
    !/^\/[A-Za-z0-9._/-]{1,255}$/.test(target.command) ||
    target.command.includes('..')
  )
    throw fail();
  return ['-d', target.distro, '--exec', target.command, 'cowork', 'serve', '--stdio'];
}

/** Fixed destination and per-turn grant; remote requests cannot select a URL, path, headers or token. */
export async function forwardCoworkGateway(
  baseURL: string,
  token: string,
  raw: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const p = object(raw);
  if (
    Object.keys(p).join(',') !== 'body' ||
    typeof p.body !== 'string' ||
    p.body.length > 6 * 1024 * 1024 ||
    !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v1$/.test(baseURL)
  )
    throw fail();
  const body = Buffer.from(p.body, 'base64');
  if (body.length > 4 * 1024 * 1024 || body.toString('base64') !== p.body) throw fail();
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
    signal,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body !== null)
    for await (const rawChunk of response.body) {
      const chunk = rawChunk as Uint8Array;
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        await response.body.cancel().catch(() => undefined);
        throw fail();
      }
      chunks.push(Buffer.from(chunk));
    }
  return {
    status: response.status,
    body: Buffer.concat(chunks).toString('base64'),
    contentType:
      response.headers.get('content-type')?.includes('text/event-stream') === true
        ? 'text/event-stream'
        : 'application/json',
  };
}

export async function forwardCoworkBridge(
  endpoint: string,
  token: string,
  raw: unknown,
  standalone: boolean,
  signal: AbortSignal,
): Promise<string> {
  const p = object(raw);
  if (
    Object.keys(p).join(',') !== 'frame' ||
    typeof p.frame !== 'string' ||
    p.frame.length > 4 * 1024 * 1024 ||
    !p.frame.endsWith('\n') ||
    p.frame.trim().includes('\n')
  )
    throw fail();
  const frame = object(JSON.parse(p.frame));
  if (frame.token !== token || frame.v !== 1 || !['submit', 'status'].includes(String(frame.op)))
    throw fail();
  if (frame.op === 'submit') {
    const request = object(frame.request);
    if (
      (request.documentRefs !== undefined &&
        (!Array.isArray(request.documentRefs) || request.documentRefs.length !== 0)) ||
      (standalone && normalizeReviewOf(request.reviewOf) !== undefined)
    )
      throw fail();
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      socket.destroy();
      if (value === undefined) reject(fail());
      else resolve(value);
    };
    const abort = (): void => finish();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    socket.setTimeout(150_000, () => finish());
    socket.once('connect', () => socket.write(p.frame as string));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4 * 1024 * 1024) finish();
      else if (buffer.includes('\n')) finish(buffer.slice(0, buffer.indexOf('\n') + 1));
    });
    socket.once('error', () => finish());
    socket.once('close', () => finish());
  });
}

const ALLOWED_HELLO_KEYS: ReadonlySet<string> = new Set([
  'protocol',
  'protocolVersion',
  'helperVersion',
  'version',
  'isolation',
  'capabilities',
]);
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

export function verifyCoworkHello(raw: unknown): void {
  const answer = object(raw);
  if (
    Object.keys(answer).some((k) => !ALLOWED_HELLO_KEYS.has(k)) ||
    typeof answer.protocol !== 'string' ||
    typeof answer.version !== 'string' ||
    answer.isolation !== 'WSL2_BUBBLEWRAP' ||
    (answer.protocolVersion !== undefined &&
      (typeof answer.protocolVersion !== 'number' || !Number.isInteger(answer.protocolVersion))) ||
    (answer.helperVersion !== undefined && typeof answer.helperVersion !== 'string') ||
    (answer.capabilities !== undefined &&
      (!Array.isArray(answer.capabilities) ||
        answer.capabilities.some((c) => typeof c !== 'string')))
  ) {
    throw fail();
  }
  const caps = answer.capabilities as readonly string[] | undefined;
  if (
    answer.protocol !== COWORK_HELPER_PROTOCOL ||
    answer.protocolVersion !== COWORK_HELPER_PROTOCOL_VERSION ||
    answer.helperVersion !== COWORK_HELPER_RELEASE ||
    answer.version !== DSH_PINNED_VERSION ||
    caps === undefined ||
    COWORK_HELPER_CAPABILITIES.some((cap) => !caps.includes(cap))
  ) {
    throw new NexarError(
      'INTEGRATION_UNAVAILABLE',
      'Incompatible Cowork helper or runtime version',
      {
        details: {
          state: 'unsupported-version',
          ...(SAFE_VERSION.test(answer.version) ? { version: answer.version } : {}),
        },
      },
    );
  }
}

/** The trusted host bridge travels over WSL stdio; the sandbox gets only its own Unix sockets. */
export class WslCoworkBackend implements CoworkExecutionBackend {
  constructor(
    private readonly settings: Pick<SettingsStore, 'getCodePlane'>,
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly helloTimeoutMs = 90_000,
  ) {}

  private async connect(
    signal?: AbortSignal,
  ): Promise<{ child: ChildProcess; peer: JsonRpcStdioClient }> {
    const config = await this.settings.getCodePlane();
    const systemRoot = process.env['SystemRoot'];
    if (
      !config.valid ||
      process.platform !== 'win32' ||
      systemRoot === undefined ||
      !win32.isAbsolute(systemRoot)
    )
      throw fail();
    const child = this.spawnImpl(
      win32.join(systemRoot, 'System32', 'wsl.exe'),
      coworkWslArguments(config.value),
      {
        env: { SystemRoot: systemRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      },
    );
    if (child.stdout === null || child.stdin === null) throw fail();
    child.stderr?.on('data', () => undefined);
    const peer = new JsonRpcStdioClient({ input: child.stdout, output: child.stdin });
    child.once('error', () => peer.close());
    try {
      const answer = await peer.request('cowork/hello', undefined, {
        timeoutMs: this.helloTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      verifyCoworkHello(answer);
      return { child, peer };
    } catch (error) {
      peer.close();
      await terminateProcessTree(child).catch(() => undefined);
      if (isNexarError(error) && error.code === 'INTEGRATION_UNAVAILABLE') throw error;
      throw fail();
    }
  }

  async probe(): Promise<DshRuntimeStatus> {
    try {
      const { child, peer } = await this.connect();
      peer.close();
      await terminateProcessTree(child).catch(() => undefined);
      return { state: 'ready', version: DSH_PINNED_VERSION };
    } catch (error) {
      if (isNexarError(error) && error.code === 'INTEGRATION_UNAVAILABLE') {
        const version = (error.details as { version?: unknown } | undefined)?.version;
        return {
          state: 'unsupported-version',
          ...(typeof version === 'string' ? { version } : {}),
        };
      }
      return { state: 'startup-failed' };
    }
  }

  async run(
    options: LocalAcpSessionOptions,
    scope: {
      readonly endpoint: string;
      readonly standalone: boolean;
      readonly inputs: readonly CoworkFile[];
    },
  ): Promise<LocalAcpResult> {
    const { child, peer } = await this.connect(options.signal);
    const activeCallbacks: Record<
      'cowork/gateway' | 'cowork/bridge' | 'cowork/permission',
      number
    > = {
      'cowork/gateway': 0,
      'cowork/bridge': 0,
      'cowork/permission': 0,
    };
    const callbackLimits: Readonly<
      Record<'cowork/gateway' | 'cowork/bridge' | 'cowork/permission', number>
    > = {
      'cowork/gateway': 4,
      'cowork/bridge': 4,
      'cowork/permission': 1,
    };
    let live = true;
    const abort = (): void => {
      void peer.request('cowork/cancel', undefined, { timeoutMs: 2000 }).catch(() => undefined);
    };
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = AbortSignal.any([options.signal, deadline]);
    signal.addEventListener('abort', abort, { once: true });
    peer.setRequestHandler((request) => {
      if (
        request.method !== 'cowork/gateway' &&
        request.method !== 'cowork/bridge' &&
        request.method !== 'cowork/permission'
      )
        return undefined;
      const method = request.method;
      if (!live || signal.aborted || activeCallbacks[method] >= callbackLimits[method])
        return Promise.resolve({ error: { code: -32000, message: 'POLICY_REJECTED' } });
      activeCallbacks[method]++;
      const operation = async (): Promise<unknown> => {
        if (method === 'cowork/gateway')
          return forwardCoworkGateway(
            options.control.baseURL,
            options.control.token,
            request.params,
            signal,
          );
        if (method === 'cowork/bridge')
          return forwardCoworkBridge(
            scope.endpoint,
            options.control.token,
            request.params,
            scope.standalone,
            signal,
          );
        const input = Permission.parse(request.params);
        if (!['write', 'edit'].includes(input.tool)) return options.decide(input);
        const rawInput = object(input.rawInput);
        if (typeof rawInput.file_path !== 'string' || rawInput.file_path.includes('\\'))
          return 'reject';
        const target = posix.resolve('/work', rawInput.file_path);
        const relative = posix.relative('/work', target);
        if (
          relative === '' ||
          relative.startsWith('..') ||
          posix.isAbsolute(relative) ||
          relative.includes('/')
        )
          return 'reject';
        return options.decide({
          ...input,
          rawInput: { ...rawInput, file_path: join(options.scratchDir, relative) },
        });
      };
      return operation()
        .then(
          (result) => ({ result }),
          () => ({ error: { code: -32000, message: 'POLICY_REJECTED' } }),
        )
        .finally(() => {
          activeCallbacks[method]--;
        });
    });
    peer.onNotification((n) => {
      if (n.method !== 'cowork/event' || !live) return;
      const event = object(n.params);
      if (
        event.type === 'text-delta' &&
        typeof event.text === 'string' &&
        event.text.length <= 256_000
      )
        options.onEvent?.({ type: 'text-delta', text: event.text });
      else if (
        event.type === 'tool-call' &&
        typeof event.name === 'string' &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(event.name)
      )
        options.onEvent?.({ type: 'tool-call', name: event.name });
      else if (event.type === 'status')
        options.onEvent?.({ type: 'status', message: 'Running isolated Cowork' });
    });
    try {
      if (signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'Cowork cancelled');
      const raw = object(
        await peer.request(
          'cowork/run',
          {
            prompt: options.prompt,
            requiredContext: options.requiredContext ?? '',
            token: options.control.token,
            timeoutMs: options.timeoutMs,
            inputs: parseCoworkFiles(scope.inputs),
            standalone: scope.standalone,
          },
          { timeoutMs: options.timeoutMs + 10_000 },
        ),
      );
      if (signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'Cowork cancelled');
      if (
        typeof raw.text !== 'string' ||
        raw.text.length > 1_000_000 ||
        typeof raw.sessionId !== 'string' ||
        !['end_turn', 'max_tokens'].includes(String(raw.stopReason))
      )
        throw fail();
      await stageCoworkFiles(options.scratchDir, raw.files);
      return {
        text: raw.text,
        sessionId: raw.sessionId,
        stopReason: raw.stopReason as 'end_turn' | 'max_tokens',
      };
    } catch (error) {
      if (options.signal.aborted) throw new NexarError('EXECUTION_CANCELLED', 'Cowork cancelled');
      if (deadline.aborted) throw new NexarError('EXECUTION_TIMEOUT', 'Cowork timed out');
      throw error;
    } finally {
      live = false;
      signal.removeEventListener('abort', abort);
      peer.close();
      await terminateProcessTree(child).catch(() => undefined);
    }
  }
}
