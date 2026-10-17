import { NexarError } from '@nexar/contracts';
import { CHANNELS } from '../shared/channels.js';
import {
  ConnectionAddArgsSchema,
  ConnectionDtoSchema,
  ConnectionIdArgsSchema,
  ConnectionListSchema,
  ConnectionRotateArgsSchema,
} from '../shared/connections.js';
import { ChatGptPlanStatusSchema } from '../shared/chatgpt-plan.js';
import { NoArgs, defineChannel, type ChannelDefinition } from './channel.js';
import type { ConnectionManager } from './connection-manager.js';

function requireConnectionManager(manager: ConnectionManager | undefined): ConnectionManager {
  if (manager === undefined) {
    throw new NexarError('CONFIGURATION_ERROR', 'Connection manager is not initialized');
  }
  return manager;
}

export const connectionChannels: Readonly<Record<string, ChannelDefinition>> = {
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

  [CHANNELS.connectionRemove]: defineChannel(ConnectionIdArgsSchema, async (args, ctx) => {
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
    ConnectionIdArgsSchema,
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

  [CHANNELS.chatgptPlanReplaceAccount]: defineChannel(NoArgs, async (_args, ctx) => {
    const manager = requireConnectionManager(ctx.deps.connectionManager);
    await manager.replacePlanAccount();
    if (ctx.deps.chatgptPlan !== undefined) {
      return ChatGptPlanStatusSchema.parse(await ctx.deps.chatgptPlan.status());
    }
    return ChatGptPlanStatusSchema.parse({
      state: 'signed-out',
      reason: 'disconnected',
      message: 'ChatGPT is not connected',
    });
  }),
};
