import { contextBridge, ipcRenderer } from 'electron';
import type { NexarApi, TaskEvent } from '../shared/api.js';
import { CHANNELS, TASK_EVENT_CHANNEL } from '../shared/channels.js';

/** One fixed channel per method; arguments are always an object (validated in the main process). */
const invoke = <R>(channel: string, args: unknown): Promise<R> =>
  ipcRenderer.invoke(channel, args ?? {}) as Promise<R>;

const api: NexarApi = {
  appInfo: () => invoke(CHANNELS.appInfo, {}),
  getSettings: () => invoke(CHANNELS.settingsGet, {}),
  setSettings: (args) => invoke(CHANNELS.settingsSet, args),
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
  onTaskEvent(callback) {
    // The IPC event object (and its sender) is never handed to the page.
    const listener = (_event: unknown, payload: TaskEvent): void => callback(payload);
    ipcRenderer.on(TASK_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TASK_EVENT_CHANNEL, listener);
    };
  },
};

contextBridge.exposeInMainWorld('nexar', api);
