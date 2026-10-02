import type { QuotaAssessment, RouteDecision } from '@nexar/contracts';

/** What every bridge call resolves to; errors carry a stable code and a safe message only. */
export type BridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export const THEMES = ['light', 'dark', 'sand', 'midnight', 'forest', 'contrast'] as const;
export type ThemeId = (typeof THEMES)[number];
export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];
export const MODES = ['cowork', 'code'] as const;
export type Mode = (typeof MODES)[number];

export interface DesktopSettings {
  readonly theme: ThemeId;
  readonly density: Density;
  readonly mode: Mode;
}

export interface AppInfo {
  readonly version: string;
  readonly platform: string;
}

export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface FileEntryDto {
  readonly name: string;
  readonly kind: 'dir' | 'file';
  readonly size: number;
}

export interface FileListing {
  /** The listed directory, relative to the project root (`''` for the root). */
  readonly dir: string;
  readonly entries: readonly FileEntryDto[];
  /** True when the directory had more than the 500 entries returned. */
  readonly truncated: boolean;
}

export interface FilePreview {
  readonly text: string;
  readonly truncated: boolean;
}

export interface ResourceRow {
  readonly id: string;
  readonly displayName: string;
  readonly kind: string;
  readonly adapter: string;
  readonly provenance: string;
  readonly availability: string;
  readonly auth: string;
  readonly quota: QuotaAssessment;
  /** The descriptor's pricing model: `free`, `subscription`, `per-token`, `local-compute`, `unknown`. */
  readonly costModel: string;
  readonly capabilities: readonly string[];
  readonly detail?: string;
}

export type MeasuredNumber =
  | { readonly status: 'measured' | 'estimated'; readonly value: number }
  | { readonly status: 'unavailable' };

export interface ArtifactDto {
  readonly taskId: string;
  /** Project-relative path with `/` separators; the handle for open/reveal. */
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly draft: boolean;
}

export type SelectedDecision = Extract<RouteDecision, { outcome: 'selected' }>;

export interface TaskResult {
  readonly taskId: string;
  readonly decision: SelectedDecision;
  readonly text: string;
  /** The first stored artifact; null when storing failed (the text is still returned). */
  readonly artifact: ArtifactDto | null;
  readonly artifacts: readonly ArtifactDto[];
  readonly record: {
    readonly resourceId: string;
    readonly model: string | null;
    readonly outcome: string;
    readonly latencyMs: number;
    readonly costUsd: MeasuredNumber;
  };
}

export interface TaskEvent {
  readonly requestId: string;
  readonly type: 'status' | 'progress';
  readonly message: string;
}

export interface RouteArgs {
  readonly projectId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly preferredResourceIds?: readonly string[];
}

export interface RunTaskArgs extends RouteArgs {
  readonly requestId: string;
  readonly maxCostUsd?: number;
}

export interface ApprovalDto {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly risk: string;
  readonly actionType: string;
  readonly summary: string;
  /** First 12 hex characters of the action fingerprint. */
  readonly fingerprint: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

export interface WorkflowDto {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly taskKind: string;
  readonly source: 'builtin' | 'project';
  readonly inputs: readonly {
    readonly name: string;
    readonly label: string;
    readonly type: string;
    readonly required: boolean;
    readonly maxLength?: number;
    readonly maxItems?: number;
  }[];
  readonly outputs: readonly {
    readonly id: string;
    readonly mediaType: string;
    readonly draft: boolean;
  }[];
}

export interface RunWorkflowArgs {
  readonly requestId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly inputs: Readonly<Record<string, string | readonly string[]>>;
}

export const TURN_STATES = [
  'pending-confirmation',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'declined',
] as const;
export type TurnStateDto = (typeof TURN_STATES)[number];

export interface SessionSummaryDto {
  readonly id: string;
  readonly projectId: string;
  readonly mode: Mode;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly turnCount: number;
  /** True while a turn is running or waiting for confirmation. */
  readonly active: boolean;
  readonly lastTurnState?: TurnStateDto;
}

export type LaneDto = 'cowork' | 'code' | 'direct';

/** Which rules classified the turn; constant identifiers only, never text. */
export interface TurnIntentDto {
  readonly kind: string;
  readonly source: 'explicit' | 'rules';
  readonly ruleIds: readonly string[];
}

/** The lane decision (ADR-024 section 9); constant identifiers only. */
export interface TurnLaneDto {
  readonly requestedLane: LaneDto;
  readonly effectiveLane: LaneDto;
  readonly mismatch?: { readonly from: LaneDto; readonly to: LaneDto };
  readonly confirmed?: boolean;
  /** For example `orchestrator-unavailable`. */
  readonly fallbackReason?: string;
}

export interface TurnDto {
  readonly id: string;
  readonly index: number;
  /** The owner's message. */
  readonly text: string;
  readonly state: TurnStateDto;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly kind?: string;
  readonly intent?: TurnIntentDto;
  readonly lane?: TurnLaneDto;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly state: string;
    readonly resourceId?: string;
  }[];
  readonly artifacts: readonly ArtifactDto[];
  readonly outcome?: {
    readonly text?: string;
    readonly textTruncated?: boolean;
    readonly error?: { readonly code: string; readonly message: string };
  };
}

export interface SessionDto extends SessionSummaryDto {
  readonly turns: readonly TurnDto[];
}

export interface SubmitTurnArgs {
  readonly sessionId: string;
  /** Client-generated idempotency key, `^[A-Za-z0-9_-]{16,64}$`; reuse it when retrying. */
  readonly submissionKey: string;
  readonly text: string;
  /** An explicit task kind; omit (or `general`) to let Nexar decide from the message. */
  readonly kind?: string;
  readonly preferredResourceIds?: readonly string[];
  readonly maxCostUsd?: number;
}

export interface SubmitTurnResult {
  readonly turn: TurnDto;
  /** False when the submission key already existed and nothing was started. */
  readonly created: boolean;
  /** `confirm`: the turn waits for the owner (mode mismatch). `refuse`: it failed up front. */
  readonly action: 'run' | 'confirm' | 'refuse';
}

/** A change notification: `turn` means "re-fetch the session"; it carries no content. */
export interface SessionEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly type: 'status' | 'progress' | 'turn';
  readonly message?: string;
}

/** `window.nexar`: the only thing the preload exposes. */
export interface NexarApi {
  appInfo(): Promise<BridgeResult<AppInfo>>;
  getSettings(): Promise<BridgeResult<DesktopSettings>>;
  setSettings(patch: Partial<DesktopSettings>): Promise<BridgeResult<DesktopSettings>>;
  listProjects(): Promise<BridgeResult<readonly ProjectDto[]>>;
  /** Opens the native folder dialog in the main process; null when cancelled. */
  addProject(): Promise<BridgeResult<ProjectDto | null>>;
  removeProject(id: string): Promise<BridgeResult<{ readonly removed: boolean }>>;
  listFiles(args: { projectId: string; dir?: string }): Promise<BridgeResult<FileListing>>;
  readFile(args: { projectId: string; path: string }): Promise<BridgeResult<FilePreview>>;
  listResources(args?: { refresh?: boolean }): Promise<BridgeResult<readonly ResourceRow[]>>;
  explainRoute(args: RouteArgs): Promise<BridgeResult<RouteDecision>>;
  runTask(args: RunTaskArgs): Promise<BridgeResult<TaskResult>>;
  cancelTask(requestId: string): Promise<BridgeResult<{ readonly cancelled: boolean }>>;
  listArtifacts(projectId: string): Promise<BridgeResult<readonly ArtifactDto[]>>;
  openArtifact(args: { projectId: string; path: string }): Promise<BridgeResult<null>>;
  revealArtifact(args: { projectId: string; path: string }): Promise<BridgeResult<null>>;
  listApprovals(args?: { all?: boolean }): Promise<BridgeResult<readonly ApprovalDto[]>>;
  approve(args: { id: string; reason?: string }): Promise<BridgeResult<ApprovalDto>>;
  deny(args: { id: string; reason?: string }): Promise<BridgeResult<ApprovalDto>>;
  listWorkflows(args?: { projectId?: string }): Promise<BridgeResult<readonly WorkflowDto[]>>;
  runWorkflow(args: RunWorkflowArgs): Promise<BridgeResult<TaskResult>>;
  listSessions(projectId: string): Promise<BridgeResult<readonly SessionSummaryDto[]>>;
  createSession(args: {
    projectId: string;
    mode: Mode;
    title?: string;
  }): Promise<BridgeResult<SessionDto>>;
  getSession(sessionId: string): Promise<BridgeResult<SessionDto>>;
  submitTurn(args: SubmitTurnArgs): Promise<BridgeResult<SubmitTurnResult>>;
  cancelTurn(args: {
    sessionId: string;
    turnId: string;
  }): Promise<BridgeResult<{ readonly cancelled: boolean }>>;
  confirmLane(args: {
    sessionId: string;
    turnId: string;
    decision: 'confirm' | 'decline';
  }): Promise<BridgeResult<TurnDto>>;
  setSessionMode(args: {
    sessionId: string;
    mode: Mode;
    expectedRevision?: number;
  }): Promise<BridgeResult<SessionDto>>;
  renameSession(args: {
    sessionId: string;
    title: string;
    expectedRevision?: number;
  }): Promise<BridgeResult<SessionDto>>;
  /** Subscribes to task progress; returns the unsubscribe function. */
  onTaskEvent(callback: (event: TaskEvent) => void): () => void;
  /** Subscribes to Operating Session changes; returns the unsubscribe function. */
  onSessionEvent(callback: (event: SessionEvent) => void): () => void;
}
