import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { NexarError } from '@nexar/contracts';
import {
  publicRuntimeEnvironment,
  runRuntimeCommand,
  spawnRuntime,
  terminateProcessTree,
} from '@nexar/process';
import { OpenWorkerHttpClient } from './client.js';
import type { OpenWorkerClient } from './client.js';

/** Supported upstream range (ADR-026): `>=0.3.0 <0.4.0`. */
export const SUPPORTED_OPENWORKER_RANGE = { min: [0, 3, 0], maxExclusive: [0, 4, 0] } as const;

export type OpenWorkerState =
  | 'ready'
  | 'openworker-missing'
  | 'unsupported-version'
  | 'startup-failed'
  | 'configuration-missing';

export interface OpenWorkerStatus {
  readonly state: OpenWorkerState;
  readonly version?: string;
  readonly reason: string;
}

const REASONS: Readonly<Record<OpenWorkerState, string>> = {
  ready: 'OpenWorker is ready',
  'openworker-missing': 'OpenWorker is not installed',
  'unsupported-version': 'OpenWorker version is not supported',
  'startup-failed': 'OpenWorker did not start',
  'configuration-missing': 'OpenWorker is not configured',
};

export interface OpenWorkerSupervisorOptions {
  readonly executable: string;
  /** Executable for `version`; defaults to `executable`. */
  readonly versionExecutable?: string;
  /** Private state directory (absolute). */
  readonly stateDir: string;
  readonly parentPid: number;
  /** Environment the public subset is taken from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: typeof nodeSpawn;
  readonly clock?: () => number;
  readonly startupTimeoutMs?: number;
  /** Health probe override (tests); defaults to `GET /v1/health`. */
  readonly probe?: (client: OpenWorkerHttpClient) => Promise<boolean>;
}

export interface ProviderEntry {
  readonly provider: string;
  readonly apiKey: string;
  /** An OpenAI-compatible endpoint on this machine: `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl?: string;
}

const VERSION_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const PROVIDER_NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** Upstream's provider routes report a refusal as 200 `{ ok: false, error }`. */
const refused = (result: unknown): boolean =>
  typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/;

function parseVersion(output: string): readonly [number, number, number] | undefined {
  const match = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(output);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const NOT_STARTED: OpenWorkerStatus = {
  state: 'startup-failed',
  reason: 'OpenWorker has not been started',
};

/** Owns one private `openworker-server` (ADR-026 §1, §6): probe, launch, health, stop. */
export class OpenWorkerSupervisor {
  readonly #options: OpenWorkerSupervisorOptions;
  #status: OpenWorkerStatus = NOT_STARTED;
  #starting: Promise<OpenWorkerStatus> | undefined;
  #child: ChildProcess | undefined;
  #http: OpenWorkerHttpClient | undefined;
  #stopping = false;
  /** Bumped by `stop()`: a launch started before it is abandoned and never spawns or reports ready. */
  #generation = 0;
  #launchAbort: AbortController | undefined;

  constructor(options: OpenWorkerSupervisorOptions) {
    this.#options = options;
  }

  status(): OpenWorkerStatus {
    return this.#status;
  }

  /** The session client of the running server; `undefined` unless `ready`. */
  client(): OpenWorkerClient | undefined {
    return this.#status.state === 'ready' ? this.#http : undefined;
  }

  /** Idempotent: concurrent and later calls share one server; a failed start may be retried. */
  start(): Promise<OpenWorkerStatus> {
    if (this.#starting === undefined) {
      const attempt = this.#launch().then((status) => {
        if (status.state !== 'ready' && this.#starting === attempt) this.#starting = undefined;
        return status;
      });
      this.#starting = attempt;
    }
    return this.#starting;
  }

  /** Ends the server, and abandons a start in progress (its version probe or server is ended too). */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#generation += 1;
    this.#launchAbort?.abort();
    this.#launchAbort = undefined;
    const child = this.#child;
    this.#child = undefined;
    this.#http = undefined;
    this.#starting = undefined;
    this.#status = NOT_STARTED;
    if (child !== undefined) await terminateProcessTree(child, this.#options.env ?? process.env);
  }

  #readyHttp(): OpenWorkerHttpClient {
    const http = this.#http;
    if (this.#status.state !== 'ready' || http === undefined) {
      throw new NexarError('INTEGRATION_UNAVAILABLE', 'OpenWorker is not ready');
    }
    return http;
  }

  /**
   * One `POST /v1/providers` per entry; keys travel in the request body only. Upstream merges the
   * fields into the stored profile and drops an optional field sent empty, so `base_url` is always
   * sent: without `baseUrl` it is cleared, and a direct key never reaches an earlier endpoint.
   * Upstream answers a refusal with 200 `{ ok: false }`.
   */
  async configureProviders(entries: readonly ProviderEntry[]): Promise<void> {
    const http = this.#readyHttp();
    for (const entry of entries) {
      if (
        !PROVIDER_NAME.test(entry.provider) ||
        entry.apiKey === '' ||
        (entry.baseUrl !== undefined && !LOOPBACK_BASE_URL.test(entry.baseUrl))
      ) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid OpenWorker provider entry');
      }
    }
    for (const entry of entries) {
      try {
        const result = await http.request('POST', '/v1/providers', {
          name: entry.provider,
          fields: { api_key: entry.apiKey, base_url: entry.baseUrl ?? '' },
        });
        if (refused(result)) throw new Error('refused');
      } catch {
        throw new NexarError('CONFIGURATION_ERROR', 'OpenWorker provider configuration failed');
      }
    }
  }

  /** `DELETE /v1/providers/{name}`: upstream forgets the whole stored profile (key and endpoint). */
  async removeProvider(provider: string): Promise<void> {
    const http = this.#readyHttp();
    if (!PROVIDER_NAME.test(provider)) {
      throw new NexarError('VALIDATION_ERROR', 'Invalid OpenWorker provider entry');
    }
    try {
      if (refused(await http.request('DELETE', `/v1/providers/${provider}`))) {
        throw new Error('refused');
      }
    } catch {
      throw new NexarError('CONFIGURATION_ERROR', 'OpenWorker provider removal failed');
    }
  }

  #fail(state: OpenWorkerState, version?: string): OpenWorkerStatus {
    this.#status = {
      state,
      ...(version === undefined ? {} : { version }),
      reason: REASONS[state],
    };
    return this.#status;
  }

  async #launch(): Promise<OpenWorkerStatus> {
    const options = this.#options;
    if (
      options.executable === '' ||
      !isAbsolute(options.stateDir) ||
      !Number.isInteger(options.parentPid) ||
      options.parentPid <= 0
    ) {
      return this.#fail('configuration-missing');
    }
    this.#stopping = false;
    const generation = this.#generation;
    const stopped = (): boolean => generation !== this.#generation;
    const abort = new AbortController();
    this.#launchAbort = abort;
    const parentEnv = options.env ?? process.env;
    const publicEnv = publicRuntimeEnvironment(parentEnv);
    const spawnImpl = options.spawn ?? spawnRuntime;

    // 1. Version probe: bounded, shell-free, public environment only.
    try {
      await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    } catch {
      return this.#fail('startup-failed');
    }
    const probe = await runRuntimeCommand({
      command: options.versionExecutable ?? options.executable,
      args: ['version'],
      cwd: options.stateDir,
      env: publicEnv,
      signal: abort.signal,
      timeoutMs: VERSION_TIMEOUT_MS,
      interaction: 'probe',
      spawnImpl,
    });
    if (stopped()) return NOT_STARTED;
    if (probe.kind === 'unavailable') return this.#fail('openworker-missing');
    if (probe.kind !== 'exited' || probe.exitCode !== 0) return this.#fail('startup-failed');
    const parsed = parseVersion(probe.stdout);
    if (parsed === undefined) return this.#fail('unsupported-version');
    const version = parsed.join('.');
    if (
      compare(parsed, SUPPORTED_OPENWORKER_RANGE.min) < 0 ||
      compare(parsed, SUPPORTED_OPENWORKER_RANGE.maxExclusive) >= 0
    ) {
      return this.#fail('unsupported-version', version);
    }

    // 2. Launch with exactly the allowlisted environment.
    let port: number;
    try {
      port = await freeLoopbackPort();
    } catch {
      return this.#fail('startup-failed', version);
    }
    // Stopped while probing: never spawn a server nobody will stop.
    if (stopped()) return NOT_STARTED;
    const token = randomBytes(32).toString('hex');
    const env: Record<string, string> = {
      ...publicEnv,
      COWORKER_STATE_DIR: options.stateDir,
      COWORKER_API_TOKEN: token,
      COWORKER_EXIT_WITH_PARENT: '1',
      COWORKER_PARENT_PID: String(options.parentPid),
      COWORKER_STATE_LOCK: 'strict',
    };
    let child: ChildProcess;
    try {
      child = spawnImpl(options.executable, ['--host', '127.0.0.1', '--port', String(port)], {
        cwd: options.stateDir,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return this.#fail('openworker-missing');
    }
    // Output is drained and discarded: it is never retained or logged.
    child.stdout?.resume();
    child.stderr?.resume();
    let exited = false;
    child.once('error', () => (exited = true));
    child.once('exit', () => {
      exited = true;
      if (this.#child === child && !this.#stopping && this.#status.state === 'ready') {
        this.#child = undefined;
        this.#http = undefined;
        this.#fail('startup-failed', version);
      }
    });
    this.#child = child;

    // 3. Wait for health within the bound.
    const http = new OpenWorkerHttpClient({ port, token });
    const clock = options.clock ?? Date.now;
    const deadline = clock() + (options.startupTimeoutMs ?? 30_000);
    const healthy = options.probe ?? ((client: OpenWorkerHttpClient) => client.health());
    while (!exited && !stopped() && clock() < deadline) {
      const up = await healthy(http);
      if (stopped()) break;
      if (up) {
        this.#http = http;
        this.#status = { state: 'ready', version, reason: REASONS.ready };
        return this.#status;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    // `stop()` already ended this launch's server (and may have started a newer one): leave it.
    if (stopped()) return NOT_STARTED;
    await this.stop();
    return this.#fail('startup-failed', version);
  }
}
