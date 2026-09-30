import {
  NexarError,
  unknownResourceState,
  type Capability,
  type ResourceDescriptor,
  type ResourceId,
  type ResourceKindType,
  type ResourceSnapshot,
  type ResourceState,
} from '@nexar/contracts';

/** Observes the current state of one resource; may throw or reject, the registry contains it. */
export type ResourceProbe = (
  descriptor: ResourceDescriptor,
  signal: AbortSignal,
) => Promise<ResourceState>;

/** Discovery seam: anything that can enumerate resource descriptors. */
export interface ResourceSource {
  readonly name: string;
  discover(signal: AbortSignal): Promise<readonly ResourceDescriptor[]>;
}

/** A source backed by a fixed array of descriptors. */
export class StaticResourceSource implements ResourceSource {
  readonly name: string;
  private readonly descriptors: readonly ResourceDescriptor[];

  constructor(descriptors: readonly ResourceDescriptor[], name = 'static') {
    this.descriptors = [...descriptors];
    this.name = name;
  }

  discover(): Promise<readonly ResourceDescriptor[]> {
    return Promise.resolve(this.descriptors);
  }
}

/** Narrowing criteria for listing resources; every given field must match. */
export interface ResourceFilter {
  readonly kinds?: readonly ResourceKindType[];
  /** All-of. */
  readonly capabilities?: readonly Capability[];
  readonly ids?: readonly ResourceId[];
  /** All-of. */
  readonly tags?: readonly string[];
}

export interface RegisterOptions {
  readonly probe?: ResourceProbe;
}

export interface RefreshOptions {
  readonly signal?: AbortSignal;
  readonly ids?: readonly ResourceId[];
  /** Per-probe timeout; default 5000. */
  readonly timeoutMs?: number;
}

export interface LoadFromOptions {
  readonly signal?: AbortSignal;
  readonly probeFor?: (descriptor: ResourceDescriptor) => ResourceProbe | undefined;
}

/** Knows which resources exist and their last observed state; makes no routing decisions. */
export interface ResourceRegistry {
  register(descriptor: ResourceDescriptor, options?: RegisterOptions): void;
  unregister(id: ResourceId): boolean;
  get(id: ResourceId): ResourceDescriptor | undefined;
  has(id: ResourceId): boolean;
  list(filter?: ResourceFilter): readonly ResourceDescriptor[];
  getState(id: ResourceId): ResourceState | undefined;
  setState(id: ResourceId, state: ResourceState): void;
  snapshot(filter?: ResourceFilter): readonly ResourceSnapshot[];
  refresh(options?: RefreshOptions): Promise<readonly ResourceSnapshot[]>;
  loadFrom(source: ResourceSource, options?: LoadFromOptions): Promise<number>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Freezes a value and everything reachable through plain objects and arrays. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function matches(d: ResourceDescriptor, filter: ResourceFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.ids !== undefined && !filter.ids.includes(d.id)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(d.kind.type)) return false;
  if (
    filter.capabilities !== undefined &&
    !filter.capabilities.every((c) => d.capabilities.includes(c))
  ) {
    return false;
  }
  if (filter.tags !== undefined && !filter.tags.every((t) => d.tags?.includes(t) === true)) {
    return false;
  }
  return true;
}

function failureState(detail: string, observedAt: string): ResourceState {
  return { availability: 'unknown', auth: 'unknown', detail, observedAt };
}

function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
  return `probe failed: ${message}`.slice(0, 200);
}

interface Entry {
  readonly descriptor: ResourceDescriptor;
  readonly probe: ResourceProbe | undefined;
  state: ResourceState;
}

/** Runs a probe with a timeout and the caller's abort signal; always settles. */
async function runProbe(
  probe: ResourceProbe,
  descriptor: ResourceDescriptor,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<ResourceState> {
  const controller = new AbortController();
  const abort = (reason: string) => () => controller.abort(new Error(reason));
  const onOuterAbort = abort('refresh aborted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${String(timeoutMs)}ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => {
      reject(controller.signal.reason as Error);
    });
  });
  guard.catch(() => undefined);
  if (outer?.aborted === true) {
    onOuterAbort();
  } else {
    outer?.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await Promise.race([probe(descriptor, controller.signal), guard]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

export class InMemoryResourceRegistry implements ResourceRegistry {
  private readonly entries = new Map<ResourceId, Entry>();
  private readonly clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  register(descriptor: ResourceDescriptor, options: RegisterOptions = {}): void {
    if (this.entries.has(descriptor.id)) {
      throw new NexarError('CONFIGURATION_ERROR', `Resource already registered: ${descriptor.id}`, {
        details: { resourceId: descriptor.id },
      });
    }
    this.entries.set(descriptor.id, {
      descriptor: deepFreeze(structuredClone(descriptor)),
      probe: options.probe,
      state: deepFreeze(unknownResourceState(this.now())),
    });
  }

  unregister(id: ResourceId): boolean {
    return this.entries.delete(id);
  }

  get(id: ResourceId): ResourceDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  has(id: ResourceId): boolean {
    return this.entries.has(id);
  }

  list(filter?: ResourceFilter): readonly ResourceDescriptor[] {
    return this.select(filter).map((e) => e.descriptor);
  }

  getState(id: ResourceId): ResourceState | undefined {
    return this.entries.get(id)?.state;
  }

  setState(id: ResourceId, state: ResourceState): void {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new NexarError('CONFIGURATION_ERROR', `Unknown resource: ${id}`, {
        details: { resourceId: id },
      });
    }
    entry.state = deepFreeze(structuredClone(state));
  }

  snapshot(filter?: ResourceFilter): readonly ResourceSnapshot[] {
    return this.select(filter).map((e) => ({ descriptor: e.descriptor, state: e.state }));
  }

  async refresh(options: RefreshOptions = {}): Promise<readonly ResourceSnapshot[]> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const targets = this.select(
      options.ids === undefined ? undefined : { ids: options.ids },
    ).filter((e) => e.probe !== undefined);
    const results = await Promise.allSettled(
      targets.map((e) =>
        runProbe(e.probe as ResourceProbe, e.descriptor, timeoutMs, options.signal),
      ),
    );
    results.forEach((result, i) => {
      const entry = targets[i] as Entry;
      // Skip resources unregistered while probing.
      if (this.entries.get(entry.descriptor.id) !== entry) return;
      entry.state = deepFreeze(
        result.status === 'fulfilled'
          ? structuredClone(result.value)
          : failureState(describeError(result.reason), this.now()),
      );
    });
    return this.snapshot(options.ids === undefined ? undefined : { ids: options.ids });
  }

  async loadFrom(source: ResourceSource, options: LoadFromOptions = {}): Promise<number> {
    const signal = options.signal ?? new AbortController().signal;
    const descriptors = await source.discover(signal);
    for (const descriptor of descriptors) {
      const probe = options.probeFor?.(descriptor);
      this.register(descriptor, probe === undefined ? {} : { probe });
    }
    return descriptors.length;
  }

  private select(filter: ResourceFilter | undefined): Entry[] {
    return [...this.entries.values()].filter((e) => matches(e.descriptor, filter));
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
