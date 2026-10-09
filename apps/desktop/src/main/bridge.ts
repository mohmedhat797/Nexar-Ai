import { isNexarError } from '@nexar/contracts';
import type { z } from 'zod';
import type { BridgeResult } from '../shared/api.js';
import { CHANNELS, type ChannelName } from '../shared/channels.js';
import { approvalChannels } from './approvals.js';
import { artifactChannels } from './artifacts.js';
import { behaviorChannels } from './behavior.js';
import { codeChannels } from './code.js';
import { coworkChannels } from './cowork.js';
import {
  JobRegistry,
  NoArgs,
  defineChannel,
  safeError,
  type BridgeDeps,
  type CallContext,
  type ChannelDefinition,
} from './channel.js';
import { createOperating } from './operating.js';
import { projectChannels } from './projects.js';
import { chatgptPlanChannels } from './chatgpt-plan.js';
import { providerChannels } from './providers.js';
import { subscriptionChannels } from './subscriptions.js';
import { inventoryChannels } from './provider-inventory.js';
import { localEndpointChannels } from './local-endpoints.js';
import { PROVIDER_ERROR_MESSAGE } from '../shared/providers.js';
import { resourceChannels } from './resources.js';
import { sessionChannels } from './sessions.js';
import { SettingsPatchSchema } from './settings-store.js';
import { taskChannels } from './tasks.js';
import { workflowChannels } from './workflows.js';

export type ChannelTable = Readonly<Record<string, ChannelDefinition>>;

export interface Bridge {
  /** `{ channel → { schema, handler } }`; exported so tests can call handlers without Electron. */
  readonly table: ChannelTable;
  readonly jobs: JobRegistry;
  /** Validates, runs and maps errors; never throws. */
  invoke(channel: string, raw: unknown, emit: CallContext['emit']): Promise<BridgeResult<unknown>>;
}

const MAX_MESSAGE_CHARS = 300;

function validationMessage(error: z.ZodError): string {
  const lines = error.issues.map(
    (i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`,
  );
  return `Invalid request: ${lines.join('; ')}`.slice(0, MAX_MESSAGE_CHARS);
}

/** Builds the channel table over the given dependencies. */
export function createBridge(deps: BridgeDeps): Bridge {
  const table: ChannelTable = {
    [CHANNELS.appInfo]: defineChannel(NoArgs, () => Promise.resolve(deps.appInfo)),
    [CHANNELS.settingsGet]: defineChannel(NoArgs, () => deps.settings.get()),
    [CHANNELS.settingsSet]: defineChannel(SettingsPatchSchema, (patch) => deps.settings.set(patch)),
    ...projectChannels,
    ...providerChannels,
    ...chatgptPlanChannels,
    ...subscriptionChannels,
    ...inventoryChannels,
    ...localEndpointChannels,
    ...resourceChannels,
    ...taskChannels,
    ...artifactChannels,
    ...approvalChannels,
    ...workflowChannels,
    ...sessionChannels,
    ...codeChannels,
    ...coworkChannels,
    ...behaviorChannels,
  };
  const jobs = new JobRegistry();
  const operating = createOperating(deps, jobs);

  async function invoke(
    channel: string,
    raw: unknown,
    emit: CallContext['emit'],
  ): Promise<BridgeResult<unknown>> {
    const definition = Object.hasOwn(table, channel) ? table[channel] : undefined;
    if (definition === undefined) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Unknown channel' } };
    }
    const parsed = definition.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: channel.startsWith('providers:')
            ? PROVIDER_ERROR_MESSAGE
            : validationMessage(parsed.error),
        },
      };
    }
    try {
      const value = await definition.handler(parsed.data as never, {
        deps,
        jobs,
        emit,
        operating,
      });
      return { ok: true, value };
    } catch (error) {
      if (isNexarError(error)) {
        deps.logger.info('bridge call failed', { channel, code: error.code });
        return {
          ok: false,
          error: channel.startsWith('providers:')
            ? { code: error.code, message: PROVIDER_ERROR_MESSAGE }
            : safeError(error),
        };
      }
      // Anything else may carry paths or internals: log the class only, answer generically.
      deps.logger.error('bridge call crashed', {
        channel,
        errorName: channel.startsWith('providers:')
          ? 'ProviderError'
          : error instanceof Error
            ? error.name
            : 'unknown',
      });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal error' } };
    }
  }

  return { table, jobs, invoke };
}

/** Every channel name the table must define (checked by a unit test). */
export const ALL_CHANNELS: readonly ChannelName[] = Object.values(CHANNELS);
