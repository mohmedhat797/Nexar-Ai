/** IPC channel names: the whole surface the renderer can reach (ADR-021 §7). */
export const CHANNELS = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  providersList: 'providers:list',
  endpointsList: 'providers:listLocalEndpoints',
  endpointsSave: 'providers:saveLocalEndpoint',
  endpointsRemove: 'providers:removeLocalEndpoint',
  endpointsRefresh: 'providers:refreshLocalEndpoints',
  subscriptionsList: 'providers:listSubscriptions',
  subscriptionsRefresh: 'providers:refreshSubscription',
  subscriptionsLogin: 'providers:startSubscriptionLogin',
  subscriptionsCancel: 'providers:cancelSubscriptionLogin',
  providersSaveKeyFromClipboard: 'providers:saveKeyFromClipboard',
  providersRemoveKey: 'providers:removeKey',
  providersCheckKey: 'providers:checkKey',
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
  sessionsList: 'sessions:list',
  sessionsCreate: 'sessions:create',
  sessionsGet: 'sessions:get',
  sessionsSubmitTurn: 'sessions:submitTurn',
  sessionsConfirmLane: 'sessions:confirmLane',
  sessionsCancel: 'sessions:cancel',
  sessionsSetMode: 'sessions:setMode',
  sessionsRename: 'sessions:rename',
  codeStatus: 'code:status',
  codeRefresh: 'code:refresh',
  codeSetPlaneProject: 'code:setPlaneProject',
  codeDiff: 'code:diff',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Main → renderer push channel for task progress. */
export const TASK_EVENT_CHANNEL = 'task:event';

/** Main -> renderer push channel for Operating Session changes (ids and short status lines only). */
export const SESSION_EVENT_CHANNEL = 'session:event';
