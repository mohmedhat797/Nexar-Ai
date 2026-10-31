import { NexarError } from '@nexar/contracts';
import { CHANNELS } from '../shared/channels.js';
import {
  ConnectionAddArgsSchema,
  ConnectionDtoSchema,
  ConnectionIdArgsSchema,
  ConnectionListSchema,
  ConnectionRotateArgsSchema,
  ConnectionPrepareArgsSchema,
  ConnectionConfirmationSchema,
  ConnectionConfirmedArgsSchema,
} from '../shared/connections.js';
import { ChatGptPlanStatusSchema, CHATGPT_PLAN_MESSAGES } from '../shared/chatgpt-plan.js';
import { NoArgs, defineChannel, type ChannelDefinition } from './channel.js';
import type { ConnectionManager } from './connection-manager.js';

function requireConnectionManager(manager: ConnectionManager | undefined): ConnectionManager {
  if (manager === undefined) {
    throw new NexarError('CONFIGURATION_ERROR', 'Connection manager is not initialized');
  }
  return manager;
}

export const connectionChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.connectionPrepare]: defineChannel(ConnectionPrepareArgsSchema, async (args, ctx) =>
    ConnectionConfirmationSchema.parse(
      await requireConnectionManager(ctx.deps.connectionManager).prepareAction(args),
    ),
  ),
  [CHANNELS.connectionList]: defineChannel(NoArgs, async (_args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const records = await manager.listConnections();
    return ConnectionListSchema.parse(records.map((r) => manager.toDto(r)));
  }),

  [CHANNELS.connectionAdd]: defineChannel(ConnectionAddArgsSchema, async (args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const record = await manager.addApiConnection(args);
    return ConnectionDtoSchema.parse(manager.toDto(record));
  }),

  [CHANNELS.connectionDisable]: defineChannel(ConnectionIdArgsSchema, async (args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const record = await manager.disableConnection(args);
    return ConnectionDtoSchema.parse(manager.toDto(record));
  }),

  [CHANNELS.connectionEnable]: defineChannel(ConnectionIdArgsSchema, async (args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const record = await manager.enableConnection(args);
    return ConnectionDtoSchema.parse(manager.toDto(record));
  }),

  [CHANNELS.connectionRemove]: defineChannel(ConnectionConfirmedArgsSchema, async (args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const record = await manager.removeConnection(args);
    return ConnectionDtoSchema.parse(manager.toDto(record));
  }),

  [CHANNELS.connectionRestore]: defineChannel(ConnectionIdArgsSchema, async (args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const record = await manager.restoreConnection(args);
    return ConnectionDtoSchema.parse(manager.toDto(record));
  }),

  [CHANNELS.connectionForgetCredentials]: defineChannel(
    ConnectionConfirmedArgsSchema,
    async (args, ctx) => {
      const manager = requireConnectionManager(ctx.deps.connectionManager);
      const record = await manager.forgetCredential(args);
      return ConnectionDtoSchema.parse(manager.toDto(record));
    },
  ),

  [CHANNELS.connectionRotateKey]: defineChannel(ConnectionRotateArgsSchema, async (args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    const record = await manager.rotateCredential(args);
    return ConnectionDtoSchema.parse(manager.toDto(record));
  }),

  [CHANNELS.chatgptPlanReplaceAccount]: defineChannel(
    ConnectionConfirmedArgsSchema,
    async (args, ctx) => {
      const manager = requireConnectionManager(ctx.deps.connectionManager);
      await manager.replacePlanAccount(args);
      if (ctx.deps.chatgptPlan !== undefined) {
        return ChatGptPlanStatusSchema.parse(await ctx.deps.chatgptPlan.status());
      }
      return ChatGptPlanStatusSchema.parse({
        state: 'signed-out',
        reason: 'disconnected',
        message: CHATGPT_PLAN_MESSAGES.disconnected,
      });
    },
  ),
};
