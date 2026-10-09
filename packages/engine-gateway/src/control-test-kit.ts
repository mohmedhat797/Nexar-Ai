import {
  adapterId,
  measured,
  resourceId,
  type Logger,
  type ModelTurnPortRequest,
  type ModelTurnPort,
  type ResourceSnapshot,
} from '@nexar/contracts';
import { ControlModelGateway, type ControlEvent } from './gateway.js';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  ResourceIntelligencePolicy,
} from '@nexar/resource-controller';

/** Test support: a real Control Model Gateway over fake candidates and a fake model-turn port. */

type PortResult = Awaited<ReturnType<ModelTurnPort['turn']>>;

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export const controlSnapshot = (id: string): ResourceSnapshot => ({
  descriptor: {
    id: resourceId(id),
    displayName: id,
    kind: { type: 'model', provider: 'acme', model: id, access: 'api' },
    capabilities: ['text-generation', 'knowledge-work', 'reasoning', 'model-turn'],
    runtime: { adapter: adapterId('test'), locality: 'remote' },
    auth: { mode: 'none' },
    cost: { model: 'free' },
    dataLocality: 'third-party',
  },
  state: {
    availability: 'available',
    auth: 'authenticated',
    observedAt: '2026-01-01T00:00:00.000Z',
  },
});

export const okTurn = (text = 'hello', extras?: Record<string, unknown>): PortResult => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: measured(3), outputTokens: measured(1) },
  ...(extras === undefined ? {} : { extras }),
});

export interface FakeControl {
  readonly gateway: ControlModelGateway;
  /** Every request the fake port received, with the resource it ran on. */
  readonly calls: { readonly resource: string; readonly request: ModelTurnPortRequest }[];
}

export function createFakeControl(options: {
  readonly resources?: readonly string[];
  readonly turn?: (request: ModelTurnPortRequest) => Promise<PortResult> | PortResult;
  readonly onEvent?: (event: ControlEvent) => void;
  /** Extra attempts on the same resource after a retryable failure (default: the gateway's). */
  readonly retries?: number;
}): FakeControl {
  const calls: FakeControl['calls'][number][] = [];
  const turn = options.turn ?? (() => okTurn());
  let n = 0;
  const gateway = new ControlModelGateway({
    ports: (descriptor) => ({
      turn: (request) => {
        calls.push({ resource: descriptor.id, request });
        return Promise.resolve(turn(request));
      },
    }),
    candidates: () => (options.resources ?? ['res-a']).map((id) => controlSnapshot(id)),
    policy: new ResourceIntelligencePolicy({
      taskKinds: DEFAULT_TASK_KIND_RULES,
      settings: DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
    }),
    clock: () => new Date('2026-03-01T12:00:00.000Z'),
    newId: () => `dec-${String(++n)}`,
    logger: silentLogger,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  });
  return { gateway, calls };
}
