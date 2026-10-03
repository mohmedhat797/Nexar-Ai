import { NexarError } from '@nexar/contracts';
import type { BehaviorProfile } from '@nexar/operating';
import type { OperatingMode } from '@nexar/sessions';
import {
  LOCKED_RULES,
  REASONING_EFFORT_NOTE,
  UNSUPPORTED_OPTIONS,
  type BehaviorView,
} from '../shared/behavior.js';
import { CHANNELS } from '../shared/channels.js';
import { NoArgs, defineChannel, type CallContext, type ChannelDefinition } from './channel.js';
import { BehaviorPatchSchema, type SettingsStore } from './settings-store.js';

/*
 * AI behavior settings (NXR-053): the renderer reads and patches the two supported permissions and
 * the preferred resource per mode. The locked rules and the unsupported options are constants of
 * this build; nothing the renderer sends can change them. A damaged section fails closed.
 */

const INVALID = 'The AI behavior settings are not valid';

async function view(settings: Pick<SettingsStore, 'getBehavior'>): Promise<BehaviorView> {
  const behavior = await settings.getBehavior();
  if (!behavior.valid) throw new NexarError('CONFIGURATION_ERROR', INVALID);
  return {
    settings: behavior.value,
    lockedRules: LOCKED_RULES,
    unsupported: UNSUPPORTED_OPTIONS,
    reasoningEffort: REASONING_EFFORT_NOTE,
  };
}

/**
 * The profile a turn of this session mode runs with. The preferred resource becomes an NRC owner
 * preference (hard filters still apply); a damaged section throws, so no turn starts on a guess.
 */
export async function behaviorProfile(
  settings: Pick<SettingsStore, 'getBehavior'>,
  mode: OperatingMode,
): Promise<BehaviorProfile> {
  const behavior = await settings.getBehavior();
  if (!behavior.valid) throw new NexarError('CONFIGURATION_ERROR', INVALID);
  const { cowork, code } = behavior.value;
  const preferred = (mode === 'cowork' ? cowork : code).preferredResourceId;
  return {
    ...(preferred === undefined ? {} : { preferredResourceIds: [preferred] }),
    cowork: { permission: cowork.permission },
    code: { permission: code.permission },
  };
}

function known(ctx: CallContext, id: string): boolean {
  return ctx.deps.engine
    .composition()
    .runtime.registry.list()
    .some((resource) => resource.id === id);
}

export const behaviorChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.behaviorGet]: defineChannel(NoArgs, (_args, ctx) => view(ctx.deps.settings)),
  [CHANNELS.behaviorSet]: defineChannel(BehaviorPatchSchema, async (patch, ctx) => {
    for (const id of [patch.cowork?.preferredResourceId, patch.code?.preferredResourceId]) {
      if (typeof id === 'string' && !known(ctx, id)) {
        throw new NexarError('VALIDATION_ERROR', 'Unknown resource');
      }
    }
    await ctx.deps.settings.setBehavior(patch);
    return view(ctx.deps.settings);
  }),
};
