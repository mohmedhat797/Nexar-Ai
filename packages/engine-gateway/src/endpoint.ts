import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  INTELLIGENCE_LIMITS,
  NexarError,
  normalizeCapabilitiesInput,
  normalizeReviewOf,
  toNexarError,
  type BridgeGrant,
  type ControlEngine,
  type ControlResourcePolicy,
  type ControlTurnRequest,
  type IntelligenceRequest,
  type Logger,
  type NexarErrorCode,
  type ReviewDimensions,
  resolveReviewDimensions,
} from '@nexar/contracts';
import type { StrategySettings } from '@nexar/resource-controller';
import {
  IntelligenceBridge,
  DelegationUnitLimit,
  type BridgeAllocator,
  type BridgeEvent,
  type ChildExecutor,
} from './bridge.js';
import type { ControlEvent, ControlModelGateway } from './gateway.js';

/*
 * The host end of the Intelligence Bridge (Desktop main, or the plane that runs a lane) (ADR-027 section 9a): a local pipe or socket (never a
 * port) over which the stdio relay reaches the IntelligenceBridge. Authentication is one token per
 * grant; lineage, project, access and budget come from the grant, never from a request.
 */

export interface BridgeEndpointLimits {
  readonly maxFrameBytes: number;
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
}

export const DEFAULT_ENDPOINT_LIMITS: BridgeEndpointLimits = {
  // Room for a 4 MiB control turn (CONTROL_TURN_LIMITS.maxRequestBytes) plus the envelope.
  maxFrameBytes: 4 * 1024 * 1024 + 64 * 1024,
  maxConnections: 4,
  idleTimeoutMs: 150_000,
};

/** What Desktop mints for one engine turn. */
export interface BridgeGrantInput {
  /** Trusted host selection constraint; never accepted on the relay request. */
  readonly reviewDimensions?: ReviewDimensions;
  readonly sessionId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly projectId: string;
  readonly engine: ControlEngine;
  readonly access: 'read-only' | 'draft';
  readonly budgetUsd?: number;
  readonly maxUnits: number;
  readonly ttlMs: number;
  /** Trusted host object reused across this turn's gateway/delegation grants; absent on the wire. */
  readonly unitLimit?: DelegationUnitLimit;
}

export interface BridgeHostOptions {
  readonly allocator: BridgeAllocator;
  readonly executor: ChildExecutor;
  readonly clock: () => Date;
  readonly newId: () => string;
  readonly logger: Logger;
  /** The private (0700) runtime directory; the socket file lives here on POSIX. */
  readonly runtimeDir: string;
  /**
   * POSIX only: listen exactly here instead of on a random name in 
untimeDir. The parent must
   * already exist as a real (non-symlink) directory; the socket is created 0600.
   */
  readonly endpointPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly limits?: Partial<BridgeEndpointLimits>;
  readonly strategySettings?: StrategySettings;
  readonly onEvent?: (event: BridgeEvent) => void;
  /** The Control Model Gateway behind the `control` op; without it the op is POLICY_REJECTED. */
  readonly gateway?: ControlModelGateway;
}

interface StoredGrant {
  readonly controlDecisionId?: string;
  readonly tokenHash: Buffer;
  readonly expiresAtMs: number;
  readonly grant: BridgeGrant;
  readonly lineage: IntelligenceRequest['lineage'];
}

// --- protocol -------------------------------------------------------------------------------------

const UNIT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const SubmitArgs = z.strictObject({
  unitId: z.string().regex(UNIT_ID),
  reviewOf: z.preprocess(normalizeReviewOf, z.string().regex(UNIT_ID).optional()),
  kind: z.string().min(1).max(64).optional(),
  capabilities: z.preprocess(
    normalizeCapabilitiesInput,
    z.array(z.string().min(1).max(64)).max(16).optional(),
  ),
  qualityClass: z.enum(['basic', 'standard', 'high']).optional(),
  input: z.string(),
  documentRefs: z
    .array(z.string().min(1).max(INTELLIGENCE_LIMITS.maxDocumentRefChars))
    .max(INTELLIGENCE_LIMITS.maxDocumentRefs)
    .optional(),
  access: z.enum(['read-only', 'draft']),
  timeoutMs: z.number().int().positive().max(INTELLIGENCE_LIMITS.maxTimeoutMs).optional(),
});

const ControlArgs = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().optional(),
        toolCalls: z
          .array(
            z.strictObject({
              id: z.string().min(1).max(128),
              name: z.string().min(1).max(64),
              arguments: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        toolCallId: z.string().min(1).max(128).optional(),
        extras: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(64),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  settings: z
    .strictObject({ maxOutputTokens: z.number().int().positive().max(1_000_000).optional() })
    .optional(),
});

const Envelope = {
  v: z.literal(1),
  id: z.string().min(1).max(64),
  token: z.string().min(1).max(256),
};
const RequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...Envelope, op: z.literal('submit'), request: SubmitArgs }),
  z.strictObject({ ...Envelope, op: z.literal('status'), jobId: z.string().min(1).max(128) }),
  z.strictObject({ ...Envelope, op: z.literal('control'), turn: ControlArgs }),
]);

type Response =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly code: NexarErrorCode };

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

// --- the host -------------------------------------------------------------------------------------

export class BridgeHost {
  private readonly bridge: IntelligenceBridge;
  private readonly grants = new Map<string, StoredGrant>();
  /** Control decisions that emitted `control.failed` (ids only; bounded by the active decisions). */
  private readonly failedDecisions = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private readonly limits: BridgeEndpointLimits;
  private readonly platform: NodeJS.Platform;
  private abort = new AbortController();
  private server: Server | undefined;
  private path: string | undefined;

  constructor(private readonly options: BridgeHostOptions) {
    this.limits = { ...DEFAULT_ENDPOINT_LIMITS, ...options.limits };
    this.platform = options.platform ?? process.platform;
    this.bridge = new IntelligenceBridge({
      allocator: options.allocator,
      executor: options.executor,
      clock: options.clock,
      newId: options.newId,
      logger: options.logger,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.strategySettings === undefined
        ? {}
        : { strategySettings: options.strategySettings }),
    });
  }

  /** The pipe or socket path; only valid once started. */
  endpoint(): string {
    if (this.path === undefined) throw new NexarError('CONFLICT', 'The bridge host is not started');
    return this.path;
  }

  /** Opens a turn-scoped grant. The token is returned once; only its hash is kept. */
  mint(
    input: BridgeGrantInput,
    control?: { readonly policy: ControlResourcePolicy },
  ): {
    readonly grantId: string;
    readonly token: string;
    readonly controlDecisionId?: string;
    readonly resourceId?: string;
  } {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1) {
      throw new NexarError('VALIDATION_ERROR', 'ttlMs must be a positive integer');
    }
    if (
      input.unitLimit !== undefined &&
      (!DelegationUnitLimit.is(input.unitLimit) ||
        !input.unitLimit.matches(input) ||
        !Number.isInteger(input.maxUnits) ||
        input.maxUnits < 1 ||
        input.maxUnits > input.unitLimit.maximum)
    ) {
      throw new NexarError('VALIDATION_ERROR', 'Invalid turn delegation scope');
    }
    const reviewDimensions = resolveReviewDimensions(input.reviewDimensions);
    this.sweep();
    const { gateway } = this.options;
    if (control !== undefined && gateway === undefined) {
      throw new NexarError('POLICY_REJECTED', 'Control is not available');
    }
    const grantId = this.options.newId();
    const lineage = {
      rootSessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      depth: 1,
    };
    // Throws NO_ELIGIBLE_RESOURCE before anything is opened; the caller decides on a fallback.
    const decision =
      control === undefined || gateway === undefined
        ? undefined
        : gateway.begin(input.engine, control.policy, lineage);
    const controlDecisionId = decision?.controlDecisionId;
    const token = randomBytes(32).toString('hex');
    const expiresAtMs = this.options.clock().getTime() + input.ttlMs;
    const grant: BridgeGrant = {
      grantId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      projectId: input.projectId,
      engine: input.engine,
      access: input.access,
      ...(reviewDimensions === undefined ? {} : { reviewDimensions }),
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
      maxUnits: input.maxUnits,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.bridge.open(grant, input.unitLimit);
    this.grants.set(grantId, {
      ...(controlDecisionId === undefined ? {} : { controlDecisionId }),
      tokenHash: sha256(token),
      expiresAtMs,
      grant,
      lineage: { ...lineage, chain: ['nexar', input.engine] },
    });
    return {
      grantId,
      token,
      ...(decision === undefined
        ? {}
        : { controlDecisionId: decision.controlDecisionId, resourceId: decision.resourceId }),
    };
  }

  /** Feed the gateway's events here (its `onEvent`): `controlFailed` reads them. */
  noteControlEvent(event: ControlEvent): void {
    if (event.type === 'control.failed') this.failedDecisions.add(event.controlDecisionId);
  }

  /** True when the grant's current control decision emitted `control.failed`. */
  controlFailed(grantId: string): boolean {
    const id = this.grants.get(grantId)?.controlDecisionId;
    return id !== undefined && this.failedDecisions.has(id);
  }

  /**
   * After a control failure: a new decision on the next eligible resource, stored on the grant (the
   * token and grant stay). Throws the gateway's `POLICY_REJECTED` / `NO_ELIGIBLE_RESOURCE` unchanged.
   */
  restartControl(grantId: string): {
    readonly controlDecisionId: string;
    readonly resourceId: string;
  } {
    const stored = this.grants.get(grantId);
    const { gateway } = this.options;
    if (stored?.controlDecisionId === undefined || gateway === undefined) {
      throw new NexarError('POLICY_REJECTED', 'Control is not available');
    }
    const next = gateway.restart(stored.controlDecisionId);
    this.failedDecisions.delete(stored.controlDecisionId);
    this.grants.set(grantId, {
      ...stored,
      controlDecisionId: next.controlDecisionId,
    });
    return { controlDecisionId: next.controlDecisionId, resourceId: next.resourceId };
  }

  revoke(grantId: string): void {
    const stored = this.grants.get(grantId);
    if (stored?.controlDecisionId !== undefined) {
      this.options.gateway?.end(stored.controlDecisionId);
      this.failedDecisions.delete(stored.controlDecisionId);
    }
    this.grants.delete(grantId);
    this.bridge.close(grantId);
  }

  private starting: Promise<string> | undefined;

  /**
   * Starts the endpoint on first need (the first grant of the session) and returns its path; later
   * calls share it. The pipe or socket therefore exists only once delegation is actually used.
   */
  ensureStarted(): Promise<string> {
    this.starting ??= this.start().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  /** Listens on a fresh per-launch pipe or socket and returns its path. */
  async start(): Promise<string> {
    if (this.server !== undefined) throw new NexarError('CONFLICT', 'The bridge host is started');
    const { endpointPath } = this.options;
    let path: string;
    if (this.platform === 'win32') {
      if (endpointPath !== undefined) {
        throw new NexarError('VALIDATION_ERROR', 'A fixed bridge endpoint path needs unix sockets');
      }
      path = `\\\\.\\pipe\\nexar-bridge-${randomBytes(16).toString('hex')}`;
    } else if (endpointPath !== undefined) {
      path = endpointPath;
      await checkFixedPath(path);
      await removeStaleSocket(path);
    } else {
      await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 });
      path = join(this.options.runtimeDir, `bridge-${randomBytes(16).toString('hex')}.sock`);
      await removeStaleSocket(path);
    }
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', () => this.options.logger.warn('bridge.endpoint.error'));
    if (this.platform !== 'win32') await chmod(path, 0o600);
    this.server = server;
    this.path = path;
    return path;
  }

  /** Closes the endpoint and every grant. Safe to call twice. */
  async stop(): Promise<void> {
    const { server, path } = this;
    this.server = undefined;
    this.abort.abort();
    this.abort = new AbortController();
    for (const id of [...this.grants.keys()]) this.revoke(id);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (path !== undefined && this.platform !== 'win32') await unlink(path).catch(() => undefined);
    this.path = undefined;
    this.starting = undefined;
  }

  // --- connections --------------------------------------------------------------------------------

  private accept(socket: Socket): void {
    if (this.sockets.size >= this.limits.maxConnections) {
      this.reject('RESOURCE_UNAVAILABLE');
      socket.end(`${JSON.stringify({ id: '', ok: false, code: 'RESOURCE_UNAVAILABLE' })}\n`);
      return;
    }
    this.sockets.add(socket);
    // A dropped connection (the translator's HTTP client went away) cancels its in-flight turn.
    const closed = new AbortController();
    socket.on('close', () => {
      this.sockets.delete(socket);
      closed.abort();
    });
    socket.on('error', () => socket.destroy());
    // A model turn can outlast the idle bound; only an idle connection is closed.
    let inflight = 0;
    socket.setTimeout(this.limits.idleTimeoutMs, () => {
      if (inflight === 0) socket.destroy();
    });

    let pending = Buffer.alloc(0);
    let closing = false;
    let chain: Promise<unknown> = Promise.resolve();
    const reply = (response: Response): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
    };
    const refuse = (code: NexarErrorCode): void => {
      closing = true;
      this.reject(code);
      chain = chain.then(() => {
        reply({ id: '', ok: false, code });
        socket.end();
      });
    };

    socket.on('data', (chunk: Buffer) => {
      if (closing) return;
      pending = Buffer.concat([pending, chunk]);
      for (let end = pending.indexOf(0x0a); end !== -1; end = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (line.length > this.limits.maxFrameBytes) return refuse('VALIDATION_ERROR');
        const text = line.toString('utf8');
        chain = chain.then(async () => {
          inflight++;
          try {
            reply(await this.handle(text, AbortSignal.any([this.abort.signal, closed.signal])));
          } finally {
            inflight--;
          }
        });
      }
      if (pending.length > this.limits.maxFrameBytes) refuse('VALIDATION_ERROR');
    });
  }

  private async handle(text: string, signal: AbortSignal): Promise<Response> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.fail('', 'VALIDATION_ERROR');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return this.fail('', 'VALIDATION_ERROR');
    }
    const fields = raw as Record<string, unknown>;
    const id = typeof fields['id'] === 'string' && fields['id'].length <= 64 ? fields['id'] : '';
    // Authenticate before looking at anything else: the token alone chooses the grant.
    const stored =
      typeof fields['token'] === 'string' ? this.authenticate(fields['token']) : undefined;
    if (stored === undefined) return this.fail(id, 'AUTH_REQUIRED');
    try {
      const parsed = RequestSchema.safeParse(raw);
      if (!parsed.success) return this.fail(id, 'VALIDATION_ERROR');
      const request = parsed.data;
      if (request.op === 'status') {
        return { id, ok: true, value: this.bridge.status(stored.grant.grantId, request.jobId) };
      }
      if (request.op === 'control') {
        const { gateway } = this.options;
        if (gateway === undefined || stored.controlDecisionId === undefined) {
          return this.fail(id, 'POLICY_REJECTED');
        }
        const { lineage } = stored;
        const value = await gateway.turn(
          {
            lineage: {
              rootSessionId: lineage.rootSessionId,
              turnId: lineage.turnId,
              correlationId: lineage.correlationId,
              depth: lineage.depth,
            },
            engine: stored.grant.engine,
            controlDecisionId: stored.controlDecisionId,
            // Zod's optional keys carry `undefined`; the gateway re-validates the bounds.
            ...(request.turn as Pick<ControlTurnRequest, 'messages' | 'tools' | 'settings'>),
          },
          signal,
        );
        return { id, ok: true, value };
      }
      const a = request.request;
      const submitted = this.bridge.submit(stored.grant.grantId, {
        lineage: stored.lineage,
        unitId: a.unitId,
        ...(a.reviewOf === undefined ? {} : { reviewOf: a.reviewOf }),
        kind: a.kind ?? 'general',
        requirements: {
          capabilities: a.capabilities ?? [],
          ...(a.qualityClass === undefined ? {} : { qualityClass: a.qualityClass }),
        },
        input: a.input,
        ...(a.documentRefs === undefined ? {} : { documentRefs: a.documentRefs }),
        access: a.access,
        ...(a.timeoutMs === undefined ? {} : { timeoutMs: a.timeoutMs }),
      });
      return { id, ok: true, value: submitted };
    } catch (error) {
      return this.fail(id, toNexarError(error).code);
    }
  }

  /** Constant-time over every stored hash; expired grants are closed first. */
  private authenticate(token: string): StoredGrant | undefined {
    this.sweep();
    const presented = sha256(token);
    let match: StoredGrant | undefined;
    for (const stored of this.grants.values()) {
      if (timingSafeEqual(presented, stored.tokenHash)) match = stored;
    }
    return match;
  }

  private sweep(): void {
    const now = this.options.clock().getTime();
    for (const [grantId, stored] of this.grants) {
      if (now >= stored.expiresAtMs) this.revoke(grantId);
    }
  }

  private fail(id: string, code: NexarErrorCode): Response {
    this.reject(code);
    return { id, ok: false, code };
  }

  private reject(code: NexarErrorCode): void {
    this.options.logger.warn('bridge.endpoint.rejected', { code });
  }
}

/** A fixed endpoint path must be absolute and sit directly in an existing, real directory. */
async function checkFixedPath(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new NexarError('VALIDATION_ERROR', 'The bridge endpoint path must be absolute');
  }
  let parent;
  try {
    parent = await lstat(dirname(path));
  } catch {
    throw new NexarError('VALIDATION_ERROR', 'The bridge endpoint directory does not exist');
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new NexarError('POLICY_REJECTED', 'The bridge endpoint directory is not usable');
  }
}

/** Removes a leftover file at `path` only when it is a socket this user owns. */
async function removeStaleSocket(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  if (!stats.isSocket() || (uid !== undefined && stats.uid !== uid)) {
    throw new NexarError('POLICY_REJECTED', 'The bridge endpoint path is not usable');
  }
  await unlink(path);
}
