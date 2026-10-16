import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  measured,
  type Logger,
  type ModelTurnPort,
  type ModelTurnPortRequest,
  type ResourceSnapshot,
  type RouteDecision,
} from '@nexar/contracts';
import {
  BridgeHost,
  ControlModelGateway,
  type BridgeEvent,
  type BridgeGrantInput,
  type ControlEvent,
} from '@nexar/engine-gateway';
import { controlSnapshot, okTurn, silentLogger } from '@nexar/engine-gateway/testing';
import { DSH_PINNED_VERSION, type DshLaunch } from '@nexar/integration-deepseek-harness';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  ResourceIntelligencePolicy,
} from '@nexar/resource-controller';
import { delegate, rootCorrelation, type CoworkRequest } from '@nexar/operating';
import type { RelayLaunch } from './bridge-relay-path.js';
import { ControlGatewayChild } from './control-gateway-child.js';
import type { DshCoworkServiceOptions } from './dsh-cowork.js';

/*
 * Test support for the DeepSeek Harness Cowork lane: the real runner over the protocol-faithful fake
 * ACP agent, a real BridgeHost + Control Model Gateway + loopback translator child over a fake model
 * port, and a hand-built Cowork request. Nothing here reaches a network or a paid API.
 */

const FAKE_ACP = fileURLToPath(
  new URL('../../../../integrations/deepseek-harness/src/test/fake-dsh-acp.mjs', import.meta.url),
);

export const SESSION_ID = `ses_${'a'.repeat(32)}`;
export const TURN_ID = `turn_${'b'.repeat(32)}`;

export interface TestRuntime {
  readonly dir: string;
  readonly relayFile: string;
  readonly gatewayFile: string;
  readonly wrapper: string;
  dispose(): Promise<void>;
}

/** Bundles the relay and the translator child as `scripts/build.mjs` does; writes the fake DSH entry. */
export async function buildTestRuntime(): Promise<TestRuntime> {
  const dir = await mkdtemp(join(tmpdir(), 'nexar-dsh-cowork-'));
  const relayFile = join(dir, 'bridge-relay.cjs');
  await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../../../integrations/mcp/src/bridge-relay-main.ts', import.meta.url),
      ),
    ],
    outfile: relayFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: 'silent',
  });
  const gatewayFile = join(dir, 'control-gateway.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../control-gateway/main.ts', import.meta.url))],
    outfile: gatewayFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  // `dsh --version` answers the pinned version; anything else is the fake ACP agent (its
  // `--fake-*` settings travel as argv because the child's environment is allowlisted).
  const wrapper = join(dir, 'fake-dsh-entry.mjs');
  await writeFile(
    wrapper,
    `const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith('--wrapper-' + name + '='))?.split('=')[1];
if (args.includes('--version')) {
  if (flag('exit') !== undefined) process.exit(Number(flag('exit')));
  process.stdout.write((flag('version') ?? ${JSON.stringify(DSH_PINNED_VERSION)}) + '\\n');
} else {
  await import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});
}
`,
  );
  return {
    dir,
    relayFile,
    gatewayFile,
    wrapper,
    dispose: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

/** A launch of the fake agent (or of the version probe) with `--fake-*` / `--wrapper-*` settings. */
export function fakeLaunch(runtime: TestRuntime, settings: Record<string, string> = {}): DshLaunch {
  return {
    command: process.execPath,
    args: [
      runtime.wrapper,
      ...Object.entries(settings).map(([name, value]) => `--${name}=${value}`),
    ],
    env: {},
  };
}

type PortResult = Awaited<ReturnType<ModelTurnPort['turn']>>;
export type TurnHandler = (
  resource: string,
  request: ModelTurnPortRequest,
) => Promise<PortResult> | PortResult;

/** The fake model: asks for `write_file` once, then answers (the fake agent's gateway loop). */
export function writeThenAnswer(
  request: ModelTurnPortRequest,
  options: { readonly path?: string; readonly content?: string; readonly final?: string } = {},
): PortResult {
  const last = request.messages.at(-1);
  if (last?.role === 'tool') return okTurn(options.final ?? 'FINAL-DRAFT-TEXT');
  return {
    ...okTurn(),
    text: '',
    toolCalls: [
      {
        id: 'call_1',
        name: 'write_file',
        arguments: {
          path: options.path ?? 'proposal.md',
          content: options.content ?? '# Proposal\n\nDRAFT-CONTENT\n',
        },
      },
    ],
    finishReason: 'tool-calls' as const,
  };
}

/** A pi-style model resource of one connection (a distinct provider per resource id). */
export function modelSnapshot(id: string, provider: string): ResourceSnapshot {
  const base = controlSnapshot(id);
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      kind: { type: 'model', provider, model: id, access: 'api' },
    },
  };
}

export interface ControlKit {
  readonly host: NonNullable<DshCoworkServiceOptions['bridgeHost']>;
  readonly gateway: ControlModelGateway;
  readonly child: ControlGatewayChild;
  readonly relay: () => RelayLaunch;
  readonly attach: (sink: (event: BridgeEvent) => void) => void;
  /** Host calls in order (`mint`, `restart`, `revoke`). */
  readonly calls: string[];
  readonly grants: BridgeGrantInput[];
  readonly tokens: string[];
  /** Every model turn the fake port ran, with the resource it ran on. */
  readonly turns: { readonly resource: string; readonly request: ModelTurnPortRequest }[];
  readonly events: ControlEvent[];
  stop(): Promise<void>;
}

export interface ControlKitOptions {
  readonly runtime: TestRuntime;
  /** Directory for the bridge's endpoint file. */
  readonly runtimeDir: string;
  readonly logger?: Logger;
  /** `[resource id, provider]` pairs; each provider is its own connection. Default: `res-a`, `res-b`. */
  readonly resources?: readonly (readonly [string, string])[];
  readonly turn?: TurnHandler;
}

/** A real BridgeHost + Control Model Gateway + translator child over a fake model port. */
export function controlKit(options: ControlKitOptions): ControlKit {
  const resources = options.resources ?? [
    ['res-a', 'alpha'],
    ['res-b', 'beta'],
  ];
  const logger = options.logger ?? silentLogger;
  const hostRef: { current?: BridgeHost } = {};
  let sink: ((event: BridgeEvent) => void) | undefined;
  const turns: ControlKit['turns'] = [];
  const events: ControlEvent[] = [];
  const handler: TurnHandler = options.turn ?? ((_resource, request) => writeThenAnswer(request));
  let n = 0;
  const gateway = new ControlModelGateway({
    ports: (descriptor) => ({
      turn: (request) => {
        turns.push({ resource: descriptor.id, request });
        return Promise.resolve(handler(descriptor.id, request));
      },
    }),
    candidates: () => resources.map(([id, provider]) => modelSnapshot(id, provider)),
    policy: new ResourceIntelligencePolicy({
      taskKinds: DEFAULT_TASK_KIND_RULES,
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    }),
    clock: () => new Date('2026-03-01T12:00:00.000Z'),
    newId: () => `dec-${String(++n)}`,
    logger,
    retries: 0,
    onEvent: (event) => {
      events.push(event);
      hostRef.current?.noteControlEvent(event);
    },
  });
  let g = 0;
  const real = new BridgeHost({
    allocator: {
      allocate: (ledger) =>
        Promise.resolve({
          decision: {
            outcome: 'selected',
            selected: { resourceId: 'res-a' },
          } as unknown as RouteDecision,
          ledger,
        }),
    },
    executor: () =>
      Promise.resolve({
        text: 'DELEGATED-ANSWER',
        resourceId: 'res-a',
        usage: { inputTokens: measured(1), outputTokens: measured(1), costUsd: measured(0) },
      }),
    clock: () => new Date(),
    newId: () => `g${String(++g)}`,
    logger,
    runtimeDir: options.runtimeDir,
    gateway,
    onEvent: (event) => sink?.(event),
  });
  hostRef.current = real;
  const child = new ControlGatewayChild({
    endpoint: () => real.ensureStarted(),
    logger,
    launch: {
      command: process.execPath,
      args: [options.runtime.gatewayFile],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  });
  const calls: string[] = [];
  const grants: BridgeGrantInput[] = [];
  const tokens: string[] = [];
  const host: ControlKit['host'] = {
    ensureStarted: () => real.ensureStarted(),
    mint: (...args: Parameters<BridgeHost['mint']>) => {
      calls.push('mint');
      grants.push(args[0]);
      const grant = real.mint(...args);
      tokens.push(grant.token);
      return grant;
    },
    revoke: (grantId: string) => {
      calls.push('revoke');
      real.revoke(grantId);
    },
    restartControl: (grantId: string) => {
      calls.push('restart');
      return real.restartControl(grantId);
    },
    controlFailed: (grantId: string) => real.controlFailed(grantId),
  };
  return {
    host,
    gateway,
    child,
    relay: () => ({
      command: process.execPath,
      args: [options.runtime.relayFile],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }),
    attach: (next) => {
      sink = next;
    },
    calls,
    grants,
    tokens,
    turns,
    events,
    stop: async () => {
      await child.stop();
      await real.stop();
    },
  };
}

export interface BuiltRequest {
  readonly request: CoworkRequest;
  readonly progress: string[];
  readonly tasks: string[];
}

/** A Cowork request as the Operating Layer builds it (a depth 1 `dsh` correlation). */
export function coworkRequest(
  projectId: string,
  over: Partial<CoworkRequest> = {},
  ids: { readonly sessionId?: string; readonly turnId?: string } = {},
): BuiltRequest {
  const sessionId = ids.sessionId ?? SESSION_ID;
  const turnId = ids.turnId ?? TURN_ID;
  const progress: string[] = [];
  const tasks: string[] = [];
  return {
    progress,
    tasks,
    request: {
      sessionId,
      turnId,
      projectId,
      kind: 'general',
      prompt: 'Write a short solution proposal',
      correlation: delegate(rootCorrelation(sessionId, turnId), 'dsh'),
      permission: 'drafts-only',
      onTask: (id) => {
        tasks.push(id);
        return Promise.resolve();
      },
      onProgress: (type, message) => void progress.push(`${type}: ${message}`),
      ...over,
    },
  };
}

/** The fake agent's record file (`--fake-record=`), or `undefined` before it exists. */
export async function readFakeRecord(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined; // mid-rename
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A `spawn` that records every call (command, args and the complete environment). */
export function recordingSpawn(): {
  readonly spawn: typeof nodeSpawn;
  readonly calls: { readonly args: readonly string[]; readonly env: Record<string, string> }[];
} {
  const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ args, env: { ...(options['env'] as Record<string, string>) } });
    return (nodeSpawn as (...a: unknown[]) => ReturnType<typeof nodeSpawn>)(command, args, options);
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}
