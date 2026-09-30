import {
  KNOWN_CAPABILITIES,
  NexarError,
  adapterId,
  estimated,
  measured,
  resourceId,
  type ExecutionAdapter,
  type ExecutionContext,
  type ExecutionRequest,
  type ExecutionResult,
  type NexarErrorCode,
  type ResourceDescriptor,
  type ResourceState,
} from '@nexar/contracts';

export const ECHO_ADAPTER_ID = adapterId('echo');

export interface EchoAdapterOptions {
  /** Artificial latency before answering; honors the abort signal. */
  readonly delayMs?: number;
  /** Failure injection: execute() rejects with a NexarError of this code. */
  readonly failWith?: NexarErrorCode;
}

function cancelled(): NexarError {
  return new NexarError('EXECUTION_CANCELLED', 'echo execution cancelled');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Deterministic, offline adapter: answers with the prompt it was given. Never touches the network. */
export class EchoExecutionAdapter implements ExecutionAdapter {
  readonly id = ECHO_ADAPTER_ID;
  readonly displayName = 'Nexar Echo';
  private readonly delayMs: number;
  private readonly failWith: NexarErrorCode | undefined;

  constructor(options: EchoAdapterOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.failWith = options.failWith;
  }

  supports(resource: ResourceDescriptor): boolean {
    return resource.runtime.adapter === ECHO_ADAPTER_ID;
  }

  probe(): Promise<ResourceState> {
    return Promise.resolve({
      availability: 'available',
      auth: 'not-required',
      observedAt: new Date().toISOString(),
    });
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    if (this.delayMs > 0) {
      await wait(this.delayMs, context.signal);
    } else if (context.signal.aborted) {
      throw cancelled();
    }
    if (this.failWith !== undefined) {
      throw new NexarError(this.failWith, `echo adapter injected failure: ${this.failWith}`);
    }
    const prompt = request.task.input.prompt;
    const text = `[echo:${request.resource.id}] ${prompt}`;
    context.onEvent?.({ type: 'status', message: 'echoing prompt' });
    context.onEvent?.({ type: 'text-delta', text });
    const basis = 'chars/4 heuristic';
    return {
      text,
      artifacts: [],
      usage: {
        inputTokens: estimated(Math.ceil(prompt.length / 4), basis),
        outputTokens: estimated(Math.ceil(text.length / 4), basis),
        costUsd: measured(0),
        turns: measured(1),
      },
      resolved: { provider: 'nexar', model: 'echo' },
      retries: 0,
    };
  }
}

/**
 * A valid descriptor for the echo test double. It claims every known capability so it can
 * satisfy any task kind in offline tests; it is not a statement about real model ability.
 */
export function echoResource(overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    id: resourceId('local-echo'),
    displayName: 'Local Echo',
    kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
    capabilities: [...KNOWN_CAPABILITIES],
    runtime: { adapter: ECHO_ADAPTER_ID, locality: 'local' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'local',
    ...overrides,
  };
}
