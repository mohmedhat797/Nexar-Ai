import {
  NexarError,
  connectionOf,
  isControlCompatible,
  isChatGptPlanCredential,
  type ControlResourcePolicy,
} from '@nexar/contracts';
import type { BehaviorProfile } from '@nexar/operating';
import type { OperatingMode } from '@nexar/sessions';
import {
  LOCKED_RULES,
  REASONING_EFFORT_NOTE,
  UNSUPPORTED_OPTIONS,
  CODE_CONTROL_READ_ONLY_REASON,
  COWORK_CONTROL_INVALID_REASON,
  DEFAULT_CONTROL_POLICY_VIEW,
  type BehaviorPatch,
  type BehaviorView,
  type ControlCandidate,
  type ControlPolicyView,
  type ControlView,
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

function toPolicyView(policy: ControlResourcePolicy): ControlPolicyView {
  return {
    mode: policy.mode,
    ...(policy.resourceId === undefined ? {} : { resourceId: policy.resourceId }),
    fallback: policy.fallback,
  };
}

/** Desktop registry resources that can drive OpenWorker's control loop (capability check only). */
function coworkCandidates(ctx: CallContext): ControlCandidate[] {
  return ctx.deps.engine
    .composition()
    .runtime.registry.list()
    .filter((descriptor) => isControlCompatible(descriptor, 'openworker'))
    .filter((descriptor) => {
      if (ctx.deps.providerInventory === undefined) return true;
      if (descriptor.metadata?.['inventory'] !== undefined)
        return ctx.deps.providerInventory.isAvailable(descriptor);
      return (
        !(
          (descriptor.auth.mode === 'subscription' || descriptor.auth.mode === 'oauth') &&
          isChatGptPlanCredential(descriptor.auth.credential)
        ) || ctx.deps.providerInventory.isModelAvailable('chatgpt-plan', descriptor)
      );
    })
    .map((descriptor) => {
      const connection = connectionOf(descriptor);
      return {
        id: descriptor.id,
        label: descriptor.displayName,
        ...(connection === undefined
          ? {}
          : {
              provider: connection.provider,
              method: connection.method,
              support: connection.support,
            }),
      };
    });
}

async function coworkControl(ctx: CallContext): Promise<ControlView> {
  const orchestration = await ctx.deps.settings.getOrchestration();
  const candidates = coworkCandidates(ctx);
  if (!orchestration.valid) {
    return {
      policy: DEFAULT_CONTROL_POLICY_VIEW,
      editable: false,
      candidates,
      reason: COWORK_CONTROL_INVALID_REASON,
    };
  }
  const effectiveResourceId = await ctx.deps.cowork
    ?.effectiveControlResourceId()
    .catch(() => undefined);
  return {
    policy: toPolicyView(orchestration.value.cowork.controlResource),
    editable: true,
    candidates,
    ...(effectiveResourceId === undefined ? {} : { effectiveResourceId }),
  };
}

/** Read-only: the plane owns the Code policy. Never probes: it reads the plane's last status. */
function codeControl(ctx: CallContext): ControlView {
  const status = ctx.deps.codePlane?.cachedStatus();
  if (ctx.deps.codePlane !== undefined && status === undefined) void ctx.deps.codePlane.refresh();
  const policy = status?.codeControl;
  return {
    policy: policy === undefined ? DEFAULT_CONTROL_POLICY_VIEW : toPolicyView(policy),
    editable: false,
    candidates: (status?.planeResources ?? [])
      .filter((resource) => resource.control.dsh)
      .map((resource) => ({
        id: resource.id,
        label: resource.id,
        provider: resource.provider,
        method: resource.method,
        support: resource.support,
      })),
    ...(policy === undefined ? { reason: CODE_CONTROL_READ_ONLY_REASON } : {}),
  };
}

async function view(ctx: CallContext): Promise<BehaviorView> {
  const behavior = await ctx.deps.settings.getBehavior();
  if (!behavior.valid) throw new NexarError('CONFIGURATION_ERROR', INVALID);
  return {
    settings: behavior.value,
    lockedRules: LOCKED_RULES,
    unsupported: UNSUPPORTED_OPTIONS,
    reasoningEffort: REASONING_EFFORT_NOTE,
    control: { cowork: await coworkControl(ctx), code: codeControl(ctx) },
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
    .some(
      (resource) =>
        resource.id === id &&
        (resource.metadata?.['inventory'] === undefined ||
          ctx.deps.providerInventory?.isAvailable(resource) !== false),
    );
}

export const behaviorChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.behaviorGet]: defineChannel(NoArgs, (_args, ctx) => view(ctx)),
  [CHANNELS.behaviorSet]: defineChannel(BehaviorPatchSchema, async (patch, ctx) => {
    for (const id of [patch.cowork?.preferredResourceId, patch.code?.preferredResourceId]) {
      if (typeof id === 'string' && !known(ctx, id)) {
        throw new NexarError('VALIDATION_ERROR', 'Unknown resource');
      }
    }
    if (patch.code?.controlResource !== undefined) {
      throw new NexarError('POLICY_REJECTED', CODE_CONTROL_READ_ONLY_REASON);
    }
    const control = patch.cowork?.controlResource;
    // A pin can only choose among resources that can drive the loop; nothing is written otherwise.
    if (control?.resourceId !== undefined) {
      const { resourceId } = control;
      if (!coworkCandidates(ctx).some((candidate) => candidate.id === resourceId)) {
        throw new NexarError('VALIDATION_ERROR', 'Unknown or incompatible control resource');
      }
    }
    const rest: BehaviorPatch = {
      ...(patch.cowork === undefined
        ? {}
        : {
            cowork: {
              permission: patch.cowork.permission,
              preferredResourceId: patch.cowork.preferredResourceId,
            },
          }),
      ...(patch.code === undefined ? {} : { code: patch.code }),
    };
    const hasRest =
      patch.cowork?.permission !== undefined ||
      patch.cowork?.preferredResourceId !== undefined ||
      patch.code !== undefined;
    // Both sections are checked before either is written, so a damaged one leaves the other alone.
    if (control !== undefined && !(await ctx.deps.settings.getOrchestration()).valid) {
      throw new NexarError('CONFIGURATION_ERROR', COWORK_CONTROL_INVALID_REASON);
    }
    if (hasRest && !(await ctx.deps.settings.getBehavior()).valid) {
      throw new NexarError('CONFIGURATION_ERROR', INVALID);
    }
    if (control !== undefined) {
      await ctx.deps.settings.setCoworkControlResource(control);
      // Availability follows the policy: re-check in the background (never a paid call).
      void ctx.deps.cowork?.refresh().catch(() => undefined);
    }
    if (hasRest) await ctx.deps.settings.setBehavior(rest);
    return view(ctx);
  }),
};
