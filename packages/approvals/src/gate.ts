import { randomBytes } from 'node:crypto';
import { NexarError, type Logger } from '@nexar/contracts';
import { approvalDenied } from './errors.js';
import { assertOutwardAction, fingerprintAction } from './fingerprint.js';
import { newApprovalId, type ApprovalStore } from './store.js';
import type { ApprovalRequest, OutwardAction, RiskLevel } from './types.js';

/** `deny-all`: no approval handler exists, every request is refused. `store`: wait on the store. */
export type ApprovalMode = 'deny-all' | 'store';

const DEFAULT_POLL_MS = 250;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface ApprovalGateOptions {
  readonly mode?: ApprovalMode;
  readonly store?: ApprovalStore;
  readonly clock?: () => Date;
  readonly instanceId?: string;
  readonly pollIntervalMs?: number;
  readonly defaultTtlMs?: number;
  readonly logger?: Logger;
}

export interface ApprovalContext {
  readonly summary: string;
  readonly risk: RiskLevel;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly clientId?: string;
  readonly metadata?: { readonly [k: string]: string | number | boolean };
  readonly ttlMs?: number;
  readonly signal?: AbortSignal;
}

/** Single-use proof that a human approved exactly one action. */
export interface ApprovalGrant {
  readonly approvalId: string;
  readonly fingerprint: string;
  /** Verifies the action is the approved one, then atomically spends the approval. */
  consume(actionAboutToExecute: OutwardAction): Promise<void>;
}

export interface DecideOptions {
  readonly by: string;
  readonly reason?: string;
  readonly clock?: () => Date;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Best-effort terminal transition; the caller fails closed regardless of the outcome. */
async function settle(
  store: ApprovalStore,
  id: string,
  to: 'expired' | 'cancelled',
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await store.transition(id, ['pending', 'approved'], to, {
      decidedAt: now.toISOString(),
      reason,
    });
  } catch {
    // Already decided or store unavailable: nothing more can be done safely.
  }
}

/** Approves or denies a pending, unexpired request. Used by approval interfaces (CLI, mobile). */
export async function decide(
  store: ApprovalStore,
  id: string,
  decision: 'approve' | 'deny',
  options: DecideOptions,
): Promise<ApprovalRequest> {
  if (typeof options.by !== 'string' || options.by.length === 0) {
    throw new NexarError('VALIDATION_ERROR', 'Decision requires a non-empty decider');
  }
  const now = (options.clock ?? (() => new Date()))();
  let record: ApprovalRequest | undefined;
  try {
    record = await store.get(id);
  } catch {
    throw approvalDenied('unknown-state', id);
  }
  if (record === undefined) throw approvalDenied('unknown-state', id);
  if (record.status !== 'pending') throw approvalDenied('invalid-state', id);
  if (now.getTime() >= Date.parse(record.expiresAt)) {
    await settle(store, id, 'expired', 'expired', now);
    throw approvalDenied('expired', id);
  }
  return store.transition(id, ['pending'], decision === 'approve' ? 'approved' : 'denied', {
    decidedAt: now.toISOString(),
    decidedBy: options.by,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
}

/** Fail-closed gate every outward or destructive action must pass before executing. */
export class ApprovalGate {
  readonly instanceId: string;
  private readonly mode: ApprovalMode;
  private readonly store: ApprovalStore | undefined;
  private readonly clock: () => Date;
  private readonly pollIntervalMs: number;
  private readonly defaultTtlMs: number;
  private readonly logger: Logger | undefined;

  constructor(options: ApprovalGateOptions = {}) {
    this.mode = options.mode ?? 'deny-all';
    this.store = options.store;
    if (this.mode === 'store' && this.store === undefined) {
      throw new NexarError('CONFIGURATION_ERROR', "Approval mode 'store' requires a store");
    }
    this.clock = options.clock ?? (() => new Date());
    this.instanceId = options.instanceId ?? `gate_${randomBytes(16).toString('hex')}`;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger;
  }

  /** Cancels pending/approved requests left by a different (previous) gate instance. */
  async recoverAfterRestart(): Promise<number> {
    const store = this.store;
    if (this.mode !== 'store' || store === undefined) return 0;
    let count = 0;
    for (const status of ['pending', 'approved'] as const) {
      for (const record of await store.list({ status })) {
        if (record.instanceId === this.instanceId) continue;
        try {
          await store.transition(record.id, [status], 'cancelled', {
            decidedAt: this.clock().toISOString(),
            reason: 'restart',
          });
          count++;
          this.logger?.info('approval.cancelled', { approvalId: record.id, reason: 'restart' });
        } catch {
          // Changed concurrently; leave to its owner.
        }
      }
    }
    return count;
  }

  async request(action: OutwardAction, ctx: ApprovalContext): Promise<ApprovalGrant> {
    const store = this.store;
    if (this.mode === 'deny-all' || store === undefined) throw approvalDenied('no-approver');
    assertOutwardAction(action);
    const fingerprint = fingerprintAction(action);

    const now = this.clock();
    const record: ApprovalRequest = {
      id: newApprovalId(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (ctx.ttlMs ?? this.defaultTtlMs)).toISOString(),
      instanceId: this.instanceId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
      ...(ctx.clientId === undefined ? {} : { clientId: ctx.clientId }),
      actionType: action.type,
      summary: ctx.summary,
      risk: ctx.risk,
      fingerprint,
      ...(ctx.metadata === undefined ? {} : { metadata: ctx.metadata }),
      status: 'pending',
    };
    try {
      await store.create(record);
    } catch {
      throw approvalDenied('store-failure');
    }
    this.logger?.info('approval.requested', {
      approvalId: record.id,
      actionType: record.actionType,
      risk: record.risk,
      taskId: record.taskId,
      expiresAt: record.expiresAt,
    });

    const expiresAtMs = Date.parse(record.expiresAt);
    for (;;) {
      if (ctx.signal?.aborted === true) {
        await settle(store, record.id, 'cancelled', 'aborted', this.clock());
        throw approvalDenied('aborted', record.id);
      }
      let current: ApprovalRequest | undefined;
      try {
        current = await store.get(record.id);
      } catch {
        throw approvalDenied('unknown-state', record.id);
      }
      if (current === undefined) throw approvalDenied('unknown-state', record.id);
      switch (current.status) {
        case 'approved':
          if (current.fingerprint !== fingerprint) throw approvalDenied('unknown-state', record.id);
          this.logger?.info('approval.approved', {
            approvalId: record.id,
            decidedBy: current.decidedBy,
            taskId: record.taskId,
          });
          return this.grant(record.id, fingerprint, expiresAtMs);
        case 'denied':
          this.logger?.info('approval.denied', { approvalId: record.id, taskId: record.taskId });
          throw approvalDenied('denied', record.id);
        case 'expired':
          throw approvalDenied('expired', record.id);
        case 'pending':
          if (this.clock().getTime() >= expiresAtMs) {
            await settle(store, record.id, 'expired', 'expired', this.clock());
            throw approvalDenied('expired', record.id);
          }
          await sleep(this.pollIntervalMs, ctx.signal);
          break;
        default:
          throw approvalDenied('unknown-state', record.id);
      }
    }
  }

  private grant(approvalId: string, fingerprint: string, expiresAtMs: number): ApprovalGrant {
    const store = this.store as ApprovalStore;
    let attempted = false;
    return {
      approvalId,
      fingerprint,
      consume: async (actionAboutToExecute) => {
        if (attempted) throw approvalDenied('already-consumed', approvalId);
        attempted = true;
        const now = this.clock();
        let actual: string;
        try {
          actual = fingerprintAction(actionAboutToExecute);
        } catch {
          await settle(store, approvalId, 'cancelled', 'fingerprint-mismatch', now);
          throw approvalDenied('fingerprint-mismatch', approvalId);
        }
        if (actual !== fingerprint) {
          await settle(store, approvalId, 'cancelled', 'fingerprint-mismatch', now);
          throw approvalDenied('fingerprint-mismatch', approvalId);
        }
        if (now.getTime() >= expiresAtMs) {
          await settle(store, approvalId, 'expired', 'expired', now);
          throw approvalDenied('expired', approvalId);
        }
        let current: ApprovalRequest | undefined;
        try {
          current = await store.get(approvalId);
        } catch {
          throw approvalDenied('unknown-state', approvalId);
        }
        if (current === undefined) throw approvalDenied('unknown-state', approvalId);
        if (current.status === 'consumed') throw approvalDenied('already-consumed', approvalId);
        if (current.fingerprint !== fingerprint) {
          throw approvalDenied('fingerprint-mismatch', approvalId);
        }
        try {
          await store.transition(approvalId, ['approved'], 'consumed', {
            decidedAt: now.toISOString(),
          });
        } catch (e) {
          if (e instanceof NexarError && e.code === 'APPROVAL_DENIED') throw e;
          throw approvalDenied('store-failure', approvalId);
        }
        this.logger?.info('approval.consumed', { approvalId });
      },
    };
  }
}
