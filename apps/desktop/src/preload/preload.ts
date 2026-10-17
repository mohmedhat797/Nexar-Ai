import { contextBridge, ipcRenderer } from 'electron';
import type { NexarApi, SessionEvent, TaskEvent } from '../shared/api.js';
import { CHANNELS, SESSION_EVENT_CHANNEL, TASK_EVENT_CHANNEL } from '../shared/channels.js';
import { z } from 'zod';
import {
  ProviderArgsSchema,
  ProviderListSchema,
  ProviderRowSchema,
  PROVIDER_ERROR_MESSAGE,
} from '../shared/providers.js';
import type { BridgeResult } from '../shared/api.js';
import { ChatGptPlanStatusSchema } from '../shared/chatgpt-plan.js';
import {
  InventoryArgsSchema,
  InventoryListSchema,
  InventoryRowSchema,
} from '../shared/provider-inventory.js';
import {
  EndpointListSchema,
  EndpointSaveSchema,
  EndpointRemoveSchema,
} from '../shared/local-endpoints.js';
import {
  SubscriptionArgsSchema,
  SubscriptionListSchema,
  SubscriptionRowSchema,
} from '../shared/subscriptions.js';
import {
  ConnectionAddArgsSchema,
  ConnectionDtoSchema,
  ConnectionIdArgsSchema,
  ConnectionListSchema,
  ConnectionRotateArgsSchema,
} from '../shared/connections.js';

/** One fixed channel per method; arguments are always an object (validated in the main process). */
const invoke = <R>(channel: string, args: unknown): Promise<R> =>
  ipcRenderer.invoke(channel, args ?? {}) as Promise<R>;

/** Validate the credential-free provider surface in both directions at the preload boundary. */
async function invokeProvider<S extends z.ZodType>(
  channel: string,
  args: unknown,
  schema: S,
  argsSchema: z.ZodType = ProviderArgsSchema,
): Promise<BridgeResult<z.output<S>>> {
  if (!argsSchema.safeParse(args).success) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: PROVIDER_ERROR_MESSAGE } };
  }
  let result: unknown;
  try {
    result = await ipcRenderer.invoke(channel, args);
  } catch {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: PROVIDER_ERROR_MESSAGE } };
  }
  const parsed = z
    .union([
      z.strictObject({ ok: z.literal(true), value: schema }),
      z.strictObject({
        ok: z.literal(false),
        error: z.strictObject({
          code: z.enum([
            'AUTH_REQUIRED',
            'VALIDATION_ERROR',
            'CONFIGURATION_ERROR',
            'POLICY_REJECTED',
            'CONFLICT',
            'PROVIDER_ERROR',
            'INTERNAL_ERROR',
          ]),
          message: z.enum([
            PROVIDER_ERROR_MESSAGE,
            'Internal error',
            'Request not accepted from this sender',
          ]),
        }),
      }),
    ])
    .safeParse(result);
  const safe = parsed.success ? (parsed.data as BridgeResult<z.output<S>>) : undefined;
  if (safe?.ok && argsSchema === SubscriptionArgsSchema) {
    const requested = SubscriptionArgsSchema.parse(args);
    const row = SubscriptionRowSchema.safeParse(safe.value);
    if (!row.success || row.data.runtime !== requested.runtime) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: PROVIDER_ERROR_MESSAGE } };
    }
  }
  if (safe?.ok && argsSchema === InventoryArgsSchema) {
    const requested = InventoryArgsSchema.parse(args);
    const row = InventoryRowSchema.safeParse(safe.value);
    if (!row.success || row.data.sourceId !== requested.sourceId) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: PROVIDER_ERROR_MESSAGE } };
    }
  }
  return safe ?? { ok: false, error: { code: 'INTERNAL_ERROR', message: PROVIDER_ERROR_MESSAGE } };
}

const api: NexarApi = {
  listLocalEndpoints: () =>
    invokeProvider(CHANNELS.endpointsList, {}, EndpointListSchema, z.strictObject({})),
  saveLocalEndpoint: (input) =>
    invokeProvider(CHANNELS.endpointsSave, input, EndpointListSchema, EndpointSaveSchema),
  removeLocalEndpoint: (id) =>
    invokeProvider(CHANNELS.endpointsRemove, { id }, EndpointListSchema, EndpointRemoveSchema),
  refreshLocalEndpoints: () =>
    invokeProvider(CHANNELS.endpointsRefresh, {}, EndpointListSchema, z.strictObject({})),
  appInfo: () => invoke(CHANNELS.appInfo, {}),
  getSettings: () => invoke(CHANNELS.settingsGet, {}),
  setSettings: (args) => invoke(CHANNELS.settingsSet, args),
  getBehavior: () => invoke(CHANNELS.behaviorGet, {}),
  setBehavior: (args) => invoke(CHANNELS.behaviorSet, args),
  listProviders: () =>
    invokeProvider(CHANNELS.providersList, {}, ProviderListSchema, z.strictObject({})),
  chatgptPlanStatus: () =>
    invokeProvider(CHANNELS.chatgptPlanStatus, {}, ChatGptPlanStatusSchema, z.strictObject({})),
  connectChatgptPlan: () =>
    invokeProvider(CHANNELS.chatgptPlanConnect, {}, ChatGptPlanStatusSchema, z.strictObject({})),
  cancelChatgptPlan: () =>
    invokeProvider(CHANNELS.chatgptPlanCancel, {}, ChatGptPlanStatusSchema, z.strictObject({})),
  disconnectChatgptPlan: () =>
    invokeProvider(CHANNELS.chatgptPlanDisconnect, {}, ChatGptPlanStatusSchema, z.strictObject({})),
  listModelInventories: () =>
    invokeProvider(CHANNELS.inventoryList, {}, InventoryListSchema, z.strictObject({})),
  refreshModelInventory: (sourceId) =>
    invokeProvider(
      CHANNELS.inventoryRefresh,
      { sourceId },
      InventoryRowSchema,
      InventoryArgsSchema,
    ),
  listSubscriptions: () =>
    invokeProvider(CHANNELS.subscriptionsList, {}, SubscriptionListSchema, z.strictObject({})),
  refreshSubscription: (runtime) =>
    invokeProvider(
      CHANNELS.subscriptionsRefresh,
      { runtime },
      SubscriptionRowSchema,
      SubscriptionArgsSchema,
    ),
  startSubscriptionLogin: (runtime) =>
    invokeProvider(
      CHANNELS.subscriptionsLogin,
      { runtime },
      SubscriptionRowSchema,
      SubscriptionArgsSchema,
    ),
  cancelSubscriptionLogin: (runtime) =>
    invokeProvider(
      CHANNELS.subscriptionsCancel,
      { runtime },
      SubscriptionRowSchema,
      SubscriptionArgsSchema,
    ),
  saveProviderKeyFromClipboard: (provider) =>
    invokeProvider(CHANNELS.providersSaveKeyFromClipboard, { provider }, ProviderRowSchema),
  removeProviderKey: (provider) =>
    invokeProvider(CHANNELS.providersRemoveKey, { provider }, ProviderRowSchema),
  checkProviderKey: (provider) =>
    invokeProvider(CHANNELS.providersCheckKey, { provider }, ProviderRowSchema),
  listConnections: () =>
    invokeProvider(CHANNELS.connectionList, {}, ConnectionListSchema, z.strictObject({})),
  addConnection: (input) =>
    invokeProvider(CHANNELS.connectionAdd, input, ConnectionDtoSchema, ConnectionAddArgsSchema),
  disableConnection: (input) =>
    invokeProvider(CHANNELS.connectionDisable, input, ConnectionDtoSchema, ConnectionIdArgsSchema),
  enableConnection: (input) =>
    invokeProvider(CHANNELS.connectionEnable, input, ConnectionDtoSchema, ConnectionIdArgsSchema),
  removeConnection: (input) =>
    invokeProvider(CHANNELS.connectionRemove, input, ConnectionDtoSchema, ConnectionIdArgsSchema),
  restoreConnection: (input) =>
    invokeProvider(CHANNELS.connectionRestore, input, ConnectionDtoSchema, ConnectionIdArgsSchema),
  forgetConnectionCredentials: (input) =>
    invokeProvider(
      CHANNELS.connectionForgetCredentials,
      input,
      ConnectionDtoSchema,
      ConnectionIdArgsSchema,
    ),
  rotateConnectionKey: (input) =>
    invokeProvider(
      CHANNELS.connectionRotateKey,
      input,
      ConnectionDtoSchema,
      ConnectionRotateArgsSchema,
    ),
  replaceChatGptPlanAccount: () =>
    invokeProvider(
      CHANNELS.chatgptPlanReplaceAccount,
      {},
      ChatGptPlanStatusSchema,
      z.strictObject({}),
    ),
  listProjects: () => invoke(CHANNELS.projectsList, {}),
  addProject: () => invoke(CHANNELS.projectsAdd, {}),
  removeProject: (id) => invoke(CHANNELS.projectsRemove, { id }),
  listFiles: (args) => invoke(CHANNELS.projectsFiles, args),
  readFile: (args) => invoke(CHANNELS.projectsReadFile, args),
  listResources: (args) => invoke(CHANNELS.resourcesList, args),
  explainRoute: (args) => invoke(CHANNELS.routeExplain, args),
  runTask: (args) => invoke(CHANNELS.tasksRun, args),
  cancelTask: (requestId) => invoke(CHANNELS.tasksCancel, { requestId }),
  listArtifacts: (projectId) => invoke(CHANNELS.artifactsList, { projectId }),
  openArtifact: (args) => invoke(CHANNELS.artifactsOpen, args),
  revealArtifact: (args) => invoke(CHANNELS.artifactsReveal, args),
  listApprovals: (args) => invoke(CHANNELS.approvalsList, args),
  approve: (args) => invoke(CHANNELS.approvalsApprove, args),
  deny: (args) => invoke(CHANNELS.approvalsDeny, args),
  listWorkflows: (args) => invoke(CHANNELS.workflowsList, args),
  runWorkflow: (args) => invoke(CHANNELS.workflowsRun, args),
  listSessions: (projectId) => invoke(CHANNELS.sessionsList, { projectId }),
  createSession: (args) => invoke(CHANNELS.sessionsCreate, args),
  getSession: (sessionId) => invoke(CHANNELS.sessionsGet, { sessionId }),
  submitTurn: (args) => invoke(CHANNELS.sessionsSubmitTurn, args),
  confirmLane: (args) => invoke(CHANNELS.sessionsConfirmLane, args),
  cancelTurn: (args) => invoke(CHANNELS.sessionsCancel, args),
  setSessionMode: (args) => invoke(CHANNELS.sessionsSetMode, args),
  renameSession: (args) => invoke(CHANNELS.sessionsRename, args),
  listProjectMemory: (projectId) => invoke(CHANNELS.projectMemoryList, { projectId }),
  addProjectMemory: (args) => invoke(CHANNELS.projectMemoryAdd, args),
  removeProjectMemory: (args) => invoke(CHANNELS.projectMemoryRemove, args),
  codeStatus: (args) => invoke(CHANNELS.codeStatus, args),
  refreshCode: (args) => invoke(CHANNELS.codeRefresh, args),
  setPlaneProject: (args) => invoke(CHANNELS.codeSetPlaneProject, args),
  getCodeDiff: (args) => invoke(CHANNELS.codeDiff, args),
  coworkStatus: () => invoke(CHANNELS.coworkStatus, {}),
  refreshCowork: () => invoke(CHANNELS.coworkRefresh, {}),
  onTaskEvent(callback) {
    // The IPC event object (and its sender) is never handed to the page.
    const listener = (_event: unknown, payload: TaskEvent): void => callback(payload);
    ipcRenderer.on(TASK_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TASK_EVENT_CHANNEL, listener);
    };
  },
  onSessionEvent(callback) {
    const listener = (_event: unknown, payload: SessionEvent): void => callback(payload);
    ipcRenderer.on(SESSION_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(SESSION_EVENT_CHANNEL, listener);
    };
  },
};

contextBridge.exposeInMainWorld('nexar', api);
