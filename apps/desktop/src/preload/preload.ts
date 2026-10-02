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

/** One fixed channel per method; arguments are always an object (validated in the main process). */
const invoke = <R>(channel: string, args: unknown): Promise<R> =>
  ipcRenderer.invoke(channel, args ?? {}) as Promise<R>;

/** Validate the credential-free provider surface in both directions at the preload boundary. */
async function invokeProvider<S extends z.ZodType>(
  channel: string,
  args: unknown,
  schema: S,
): Promise<BridgeResult<z.output<S>>> {
  if (channel !== CHANNELS.providersList && !ProviderArgsSchema.safeParse(args).success) {
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
  return parsed.success
    ? (parsed.data as BridgeResult<z.output<S>>)
    : { ok: false, error: { code: 'INTERNAL_ERROR', message: PROVIDER_ERROR_MESSAGE } };
}

const api: NexarApi = {
  appInfo: () => invoke(CHANNELS.appInfo, {}),
  getSettings: () => invoke(CHANNELS.settingsGet, {}),
  setSettings: (args) => invoke(CHANNELS.settingsSet, args),
  listProviders: () => invokeProvider(CHANNELS.providersList, {}, ProviderListSchema),
  saveProviderKeyFromClipboard: (provider) =>
    invokeProvider(CHANNELS.providersSaveKeyFromClipboard, { provider }, ProviderRowSchema),
  removeProviderKey: (provider) =>
    invokeProvider(CHANNELS.providersRemoveKey, { provider }, ProviderRowSchema),
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
