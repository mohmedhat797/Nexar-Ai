import {
  NexarError,
  type NativeSubscriptionRuntime,
  type SubscriptionRuntimeId,
} from '@nexar/contracts';
import {
  SubscriptionArgsSchema,
  SubscriptionListSchema,
  SubscriptionRowSchema,
  SUBSCRIPTION_RUNTIME_IDS,
  type SubscriptionRow,
} from '../shared/subscriptions.js';
import { CHANNELS } from '../shared/channels.js';
import { NoArgs, defineChannel, type ChannelDefinition } from './channel.js';

/** Vendor-owned account state: never stores credentials, vendor output, or error details. */
export class SubscriptionService {
  private readonly rows = new Map<SubscriptionRuntimeId, SubscriptionRow>();
  private readonly jobs = new Map<SubscriptionRuntimeId, AbortController>();
  private readonly probes = new Map<SubscriptionRuntimeId, Promise<SubscriptionRow>>();
  private readonly probeControllers = new Map<SubscriptionRuntimeId, AbortController>();
  private disposed = false;

  constructor(
    private readonly runtimes: Readonly<Record<SubscriptionRuntimeId, NativeSubscriptionRuntime>>,
    private readonly onChanging?: (runtime: SubscriptionRuntimeId) => void,
  ) {}

  async list(): Promise<readonly SubscriptionRow[]> {
    return SubscriptionListSchema.parse(
      await Promise.all(SUBSCRIPTION_RUNTIME_IDS.map((id) => this.refresh(id))),
    );
  }

  refresh(runtime: SubscriptionRuntimeId): Promise<SubscriptionRow> {
    if (this.disposed) return Promise.resolve(this.row(runtime));
    if (this.jobs.has(runtime)) return Promise.resolve(this.row(runtime));
    const pending = this.probes.get(runtime);
    if (pending) return pending;
    const controller = new AbortController();
    this.probeControllers.set(runtime, controller);
    const probe = this.read(runtime, controller.signal).finally(() => {
      this.probes.delete(runtime);
      this.probeControllers.delete(runtime);
    });
    this.probes.set(runtime, probe);
    return probe;
  }

  isSigningIn(runtime: SubscriptionRuntimeId): boolean {
    return this.jobs.has(runtime);
  }

  async start(runtime: SubscriptionRuntimeId): Promise<SubscriptionRow> {
    if (this.disposed) throw new NexarError('CONFIGURATION_ERROR', 'Subscription service closed');
    if (this.jobs.has(runtime)) throw new NexarError('CONFLICT', 'Sign-in is already running');
    this.notifyChanging(runtime);
    // Reserve before awaiting the probe so simultaneous IPC calls cannot launch two logins.
    const controller = new AbortController();
    this.jobs.set(runtime, controller);
    this.set(runtime, { ...this.row(runtime), loginState: 'running' });
    void this.finish(runtime, controller);
    return Promise.resolve(this.row(runtime));
  }

  cancel(runtime: SubscriptionRuntimeId): Promise<SubscriptionRow> {
    const controller = this.jobs.get(runtime);
    if (!controller) return Promise.resolve(this.row(runtime));
    controller.abort();
    return Promise.resolve(this.set(runtime, { ...this.row(runtime), loginState: 'cancelled' }));
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) job.abort();
    for (const probe of this.probeControllers.values()) probe.abort();
  }

  private async finish(runtime: SubscriptionRuntimeId, controller: AbortController): Promise<void> {
    try {
      const pending = this.probes.get(runtime);
      const preflight = pending ? await pending : await this.read(runtime, controller.signal);
      if (controller.signal.aborted) return;
      if (!preflight.loginSupported || preflight.status === 'unavailable') {
        this.set(runtime, { ...preflight, loginState: 'unavailable' });
        return;
      }
      const outcome = await this.runtimes[runtime].login(controller.signal);
      const row = controller.signal.aborted
        ? this.row(runtime)
        : await this.read(runtime, controller.signal);
      this.set(runtime, { ...row, loginState: controller.signal.aborted ? 'cancelled' : outcome });
    } catch {
      this.set(runtime, {
        ...this.row(runtime),
        loginState: controller.signal.aborted ? 'cancelled' : 'failed',
      });
    } finally {
      this.notifyChanging(runtime);
      this.jobs.delete(runtime);
    }
  }

  private async read(
    runtime: SubscriptionRuntimeId,
    signal: AbortSignal,
  ): Promise<SubscriptionRow> {
    try {
      // Construct the DTO explicitly: additional vendor fields are never forwarded.
      const probe = await this.runtimes[runtime].probe(signal);
      return this.set(runtime, {
        runtime,
        method: 'subscription',
        usableBy: runtime,
        status: probe.status,
        authMode: probe.authMode,
        loginSupported: probe.loginSupported,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        loginState: this.row(runtime).loginState,
      });
    } catch {
      return this.set(runtime, { ...this.row(runtime), status: 'unknown', authMode: 'unknown' });
    }
  }

  private row(runtime: SubscriptionRuntimeId): SubscriptionRow {
    return (
      this.rows.get(runtime) ?? {
        runtime,
        method: 'subscription',
        status: 'unknown',
        authMode: 'unknown',
        loginSupported: false,
        loginState: 'idle',
        usableBy: runtime,
      }
    );
  }

  private notifyChanging(runtime: SubscriptionRuntimeId): void {
    try {
      this.onChanging?.(runtime);
    } catch {
      /* Public inventory listener cannot affect native sign-in. */
    }
  }

  private set(runtime: SubscriptionRuntimeId, row: SubscriptionRow): SubscriptionRow {
    const safe = SubscriptionRowSchema.parse(row);
    this.rows.set(runtime, safe);
    return safe;
  }
}

export const subscriptionChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.subscriptionsList]: defineChannel(NoArgs, (_args, { deps }) =>
    service(deps.subscriptions).list(),
  ),
  [CHANNELS.subscriptionsRefresh]: defineChannel(SubscriptionArgsSchema, ({ runtime }, { deps }) =>
    service(deps.subscriptions).refresh(runtime),
  ),
  [CHANNELS.subscriptionsLogin]: defineChannel(SubscriptionArgsSchema, ({ runtime }, { deps }) =>
    service(deps.subscriptions).start(runtime),
  ),
  [CHANNELS.subscriptionsCancel]: defineChannel(SubscriptionArgsSchema, ({ runtime }, { deps }) =>
    service(deps.subscriptions).cancel(runtime),
  ),
};

function service(value: SubscriptionService | undefined): SubscriptionService {
  if (!value) throw new NexarError('CONFIGURATION_ERROR', 'Subscription service unavailable');
  return value;
}
