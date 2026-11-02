import {
  NexarError,
  type NativeSubscriptionLoginOutcome,
  type NativeSubscriptionRuntime,
} from '@nexar/contracts';
import {
  CodexLoginArgsSchema,
  CodexLoginStatusSchema,
  type CodexLoginArgs,
  type CodexLoginState,
  type CodexLoginStatus,
} from '../shared/connections.js';
import type { CodexLoginLease, ConnectionManager } from './connection-manager.js';

export interface CodexLoginDeps {
  readonly manager: Pick<ConnectionManager, 'beginCodexLogin' | 'completeCodexLogin'>;
  /** The native port for one private home; composed by the host, never told about other homes. */
  readonly runtime: (home: string) => NativeSubscriptionRuntime;
}

/**
 * The one way a sign-in starts for an owner Codex connection, and only from an owner action: no
 * refresh, probe, inventory or execution path holds this service. A sign-in counts only when the
 * vendor CLI then reports its own account, so an API key found in the home never signs in.
 */
export class CodexLoginService {
  private readonly jobs = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();
  private readonly states = new Map<string, CodexLoginState>();
  private disposed = false;

  constructor(private readonly deps: CodexLoginDeps) {}

  async start(raw: CodexLoginArgs): Promise<CodexLoginStatus> {
    const args = CodexLoginArgsSchema.parse(raw);
    const id = args.connectionId;
    if (this.disposed) throw new NexarError('CONFIGURATION_ERROR', 'Sign-in service closed');
    if (this.jobs.has(id)) throw new NexarError('CONFLICT', 'Sign-in is already running');
    // Reserve before awaiting admission so simultaneous IPC calls cannot launch two logins.
    const controller = new AbortController();
    this.jobs.set(id, controller);
    let lease: CodexLoginLease;
    try {
      lease = await this.deps.manager.beginCodexLogin(args);
    } catch (error) {
      this.jobs.delete(id);
      throw error;
    }
    this.states.set(id, 'running');
    const run = this.run(id, lease, controller).finally(() => this.running.delete(run));
    this.running.add(run);
    return this.status(id);
  }

  cancel(connectionId: string): CodexLoginStatus {
    const job = this.jobs.get(connectionId);
    if (job !== undefined) {
      job.abort();
      this.states.set(connectionId, 'cancelled');
    }
    return this.status(connectionId);
  }

  /** Reports the last sign-in action only. It starts nothing and runs no process. */
  status(connectionId: string): CodexLoginStatus {
    return CodexLoginStatusSchema.parse({
      connectionId,
      loginState: this.states.get(connectionId) ?? 'idle',
    });
  }

  /** Resolves once every vendor process has ended; quitting must wait, or one outlives the app. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.jobs.values()) job.abort();
    await Promise.allSettled(this.running);
  }

  private async run(
    id: string,
    lease: CodexLoginLease,
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
    let outcome: NativeSubscriptionLoginOutcome = 'failed';
    try {
      const runtime = this.deps.runtime(lease.home);
      const before = await runtime.probe(signal);
      if (!before.loginSupported || before.status === 'unavailable') {
        outcome = 'unavailable';
        return;
      }
      outcome = await runtime.login(signal);
      if (outcome !== 'succeeded') return;
      // The vendor may have rewritten the home by now, so a failed check still has to be recorded.
      const after = await runtime.probe(signal).catch(() => undefined);
      const verified = after?.status === 'connected' && after.authMode === 'vendor-account';
      await this.deps.manager.completeCodexLogin(lease, { verified });
      if (!verified) outcome = 'failed';
    } catch {
      outcome = 'failed';
    } finally {
      this.jobs.delete(id);
      lease.release();
      this.states.set(id, signal.aborted ? 'cancelled' : outcome);
    }
  }
}
