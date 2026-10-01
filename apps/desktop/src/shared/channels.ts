/** IPC channel names: the whole surface the renderer can reach (ADR-021 §7). */
export const CHANNELS = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsRemove: 'projects:remove',
  projectsFiles: 'projects:files',
  projectsReadFile: 'projects:readFile',
  resourcesList: 'resources:list',
  routeExplain: 'route:explain',
  tasksRun: 'tasks:run',
  tasksCancel: 'tasks:cancel',
  artifactsList: 'artifacts:list',
  artifactsOpen: 'artifacts:open',
  artifactsReveal: 'artifacts:reveal',
  approvalsList: 'approvals:list',
  approvalsApprove: 'approvals:approve',
  approvalsDeny: 'approvals:deny',
  workflowsList: 'workflows:list',
  workflowsRun: 'workflows:run',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Main → renderer push channel for task progress. */
export const TASK_EVENT_CHANNEL = 'task:event';
