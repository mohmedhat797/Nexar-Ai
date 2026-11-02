import type { QuotaAssessment, RouteDecision } from '@nexar/contracts';
import type { ApiProviderId, ProviderRow } from './providers.js';
export type { ApiProviderId, ProviderRow } from './providers.js';
import type { SubscriptionRuntimeId } from '@nexar/contracts';
import type { BehaviorPatch, BehaviorView } from './behavior.js';
export type {
  BehaviorPatch,
  BehaviorSettings,
  BehaviorView,
  CodePermissionId,
  CoworkPermissionId,
  UnsupportedOption,
} from './behavior.js';
import type { SubscriptionRow } from './subscriptions.js';
export type { SubscriptionRow } from './subscriptions.js';
import type { ChatGptPlanStatus } from './chatgpt-plan.js';
import type { InventoryRow, InventorySourceId } from './provider-inventory.js';
export type { InventoryRow, InventorySourceId } from './provider-inventory.js';
export type { ChatGptPlanStatus } from './chatgpt-plan.js';
import type { LocalEndpointInput, LocalEndpointRow } from './local-endpoints.js';
export type { LocalEndpointInput, LocalEndpointRow } from './local-endpoints.js';
import type {
  CodexLoginArgs,
  CodexLoginStatus,
  ConnectionCodexAddArgs,
  ConnectionAddArgs,
  ConnectionPrepareArgs,
  ConnectionConfirmation,
  ConnectionConfirmedArgs,
  ConnectionDto,
  ConnectionIdArgs,
  ConnectionRotateArgs,
} from './connections.js';
export type {
  CodexLoginArgs,
  CodexLoginStatus,
  ConnectionCodexAddArgs,
  ConnectionAddArgs,
  ConnectionPrepareArgs,
  ConnectionConfirmation,
  ConnectionConfirmedArgs,
  ConnectionDto,
  ConnectionIdArgs,
  ConnectionRotateArgs,
} from './connections.js';

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
  /** How the resource's provider is reached (ADR-027 section 3); absent when not inferable. */
  readonly connection?: {
    readonly provider?: string;
    readonly method: 'subscription' | 'api' | 'local' | 'custom';
    readonly support: 'official' | 'experimental';
  };
  /** Whether the resource can drive that engine's control loop (`model-turn`). */
  readonly control: { readonly dsh: boolean };
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
  /** `plane`: a pending `engineering.commit` approval of the WSL2 engineering plane (ADR-025). */
  readonly source?: 'plane';
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly plane?: {
    readonly branch: string;
    readonly files: number;
    readonly gatesPassed: number;
    readonly reviewVerdict: string;
  };
}

/** Why the Code lane can or cannot run (ADR-025 section 4). */
export const PLANE_STATES = [
  'ready',
  'wsl-unavailable',
  'plane-missing',
  'plane-unreachable',
  'protocol-mismatch',
  'sandbox-unavailable',
  'hardening-drift',
  'engineering-unavailable',
] as const;
export type PlaneStateDto = (typeof PLANE_STATES)[number];
export type ProjectPlaneStateDto = PlaneStateDto | 'project-unmapped' | 'project-unknown-to-plane';

/** Availability of the Code lane for one Desktop project. */
export interface ProjectPlaneDto {
  readonly projectId: string;
  readonly state: ProjectPlaneStateDto;
  /** A fixed, non-sensitive text. */
  readonly reason: string;
  /** The mapped plane project id, when one is set. */
  readonly planeProject?: string;
}

/** One resource of the engineering plane, read-only. Ids and enums only (ADR-027 section 11). */
export interface PlaneResourceDto {
  readonly id: string;
  readonly provider?: string;
  readonly method?: 'subscription' | 'api' | 'local' | 'custom';
  readonly support?: 'official' | 'experimental';
  readonly machine?: 'plane';
  readonly auth: 'authenticated' | 'unauthenticated' | 'not-required' | 'unknown';
  readonly availability: 'available' | 'degraded' | 'unavailable' | 'unknown';
  readonly control: { readonly dsh: boolean };
}

/** The engineering plane's state. Ids and fixed texts only; never a path, distro or command. */
export interface PlaneStatusDto {
  readonly state: PlaneStateDto;
  readonly reason: string;
  readonly planeVersion?: string;
  readonly kernel?: string;
  /** Plane project ids the owner can map Desktop projects to. */
  readonly projects: readonly string[];
  /** The plane's resources; absent when the plane (older) does not report them. */
  readonly planeResources?: readonly PlaneResourceDto[];
  /** The plane's Code control-resource policy; absent when an older plane does not report it. */
  readonly codeControl?: {
    readonly mode: 'auto' | 'pinned';
    readonly resourceId?: string;
    readonly fallback: 'auto' | 'none';
  };
  readonly checkedAt: string;
  /** Present when the call named a Desktop project. */
  readonly project?: ProjectPlaneDto;
}

/** A turn's diff as retrieved from the plane (bounded; repository-relative file names). */
export interface CodeDiffDto {
  readonly text: string;
  readonly truncated: boolean;
  readonly files: readonly string[];
}

/** The Cowork lane (DeepSeek Harness Cowork profile, ADR-030). Fixed texts and a version only. */
export const COWORK_STATES = [
  'ready',
  'dsh-missing',
  'unsupported-version',
  'startup-failed',
  'configuration-missing',
  'checking',
] as const;
export interface CoworkStatusDto {
  readonly state: (typeof COWORK_STATES)[number];
  readonly reason: string;
  readonly version?: string;
  readonly placement?: 'WSL2_BUBBLEWRAP';
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
    /** Cowork: how the control loop ran. Ids, an enum and a count only. */
    readonly control?: {
      readonly path: 'gateway' | 'direct-key';
      readonly resourceId?: string;
      readonly restarts?: number;
    };
  }[];
  readonly artifacts: readonly ArtifactDto[];
  readonly outcome?: {
    readonly text?: string;
    readonly textTruncated?: boolean;
    readonly error?: { readonly code: string; readonly message: string };
    /** What the engineering plane reported for a Code-lane turn: ids and scalars only. */
    readonly engineering?: TurnEngineeringDto;
  };
}

export interface TurnEngineeringDto {
  readonly planeTaskId: string;
  readonly status: 'committed' | 'reported' | 'not-accepted' | 'failed' | 'cancelled';
  /** Lane role to the resource id that served it (change and report runs). */
  readonly lanes?: readonly {
    readonly role: string;
    readonly resourceId: string;
    readonly executor?: 'engine' | 'native';
    // legacy (ADR-030): read-only; the retired engine id only on turns recorded by older builds.
    readonly engine?: 'openworker' | 'dsh';
    readonly executorReason?: string;
    readonly controlResourceId?: string;
  }[];
  readonly branch?: string;
  readonly commit?: string;
  readonly files?: number;
  readonly gatesPassed?: number;
  readonly reviewVerdict?: string;
  readonly approvalId?: string;
}

export interface SessionDto extends SessionSummaryDto {
  readonly turns: readonly TurnDto[];
}

export type ProjectMemoryKindDto =
  'constraint' | 'decision' | 'requirement' | 'review-obligation' | 'pending-work';

/** One owner-confirmed project memory entry: ids, kind, text, time; never a path. */
export interface ProjectMemoryDto {
  readonly id: string;
  readonly kind: ProjectMemoryKindDto;
  readonly text: string;
  readonly createdAt: string;
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
  /** Trusted owner restriction, integer 1–16; omission preserves the Cowork default. */
  readonly maxDelegatedUnits?: number;
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
  listProviders(): Promise<BridgeResult<readonly ProviderRow[]>>;
  listLocalEndpoints(): Promise<BridgeResult<readonly LocalEndpointRow[]>>;
  saveLocalEndpoint(input: LocalEndpointInput): Promise<BridgeResult<readonly LocalEndpointRow[]>>;
  removeLocalEndpoint(id: string): Promise<BridgeResult<readonly LocalEndpointRow[]>>;
  refreshLocalEndpoints(): Promise<BridgeResult<readonly LocalEndpointRow[]>>;
  listSubscriptions(): Promise<BridgeResult<readonly SubscriptionRow[]>>;
  refreshSubscription(runtime: SubscriptionRuntimeId): Promise<BridgeResult<SubscriptionRow>>;
  startSubscriptionLogin(runtime: SubscriptionRuntimeId): Promise<BridgeResult<SubscriptionRow>>;
  cancelSubscriptionLogin(runtime: SubscriptionRuntimeId): Promise<BridgeResult<SubscriptionRow>>;
  /** The ChatGPT plan connection (NXR-067): status only; no token, code or URL crosses the bridge. */
  chatgptPlanStatus(): Promise<BridgeResult<ChatGptPlanStatus>>;
  /** Owner-initiated; resolves when the browser sign-in finishes or is cancelled. */
  connectChatgptPlan(): Promise<BridgeResult<ChatGptPlanStatus>>;
  cancelChatgptPlan(): Promise<BridgeResult<ChatGptPlanStatus>>;
  disconnectChatgptPlan(): Promise<BridgeResult<ChatGptPlanStatus>>;
  listModelInventories(): Promise<BridgeResult<readonly InventoryRow[]>>;
  refreshModelInventory(sourceId: InventorySourceId): Promise<BridgeResult<InventoryRow>>;
  saveProviderKeyFromClipboard(provider: ApiProviderId): Promise<BridgeResult<ProviderRow>>;
  removeProviderKey(provider: ApiProviderId): Promise<BridgeResult<ProviderRow>>;
  checkProviderKey(provider: ApiProviderId): Promise<BridgeResult<ProviderRow>>;
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
  /** Owner-confirmed project memory (ADR-030 §7): included completely in every turn. */
  listProjectMemory(projectId: string): Promise<BridgeResult<readonly ProjectMemoryDto[]>>;
  addProjectMemory(args: {
    projectId: string;
    kind: ProjectMemoryKindDto;
    text: string;
    sessionId?: string;
    turnId?: string;
  }): Promise<BridgeResult<ProjectMemoryDto>>;
  removeProjectMemory(args: {
    projectId: string;
    entryId: string;
  }): Promise<BridgeResult<{ readonly removed: boolean }>>;
  codeStatus(args?: { projectId?: string }): Promise<BridgeResult<PlaneStatusDto>>;
  /** Re-probes the engineering plane now (otherwise the status is cached for a minute). */
  refreshCode(args?: { projectId?: string }): Promise<BridgeResult<PlaneStatusDto>>;
  /** Maps a Desktop project to a plane project id (`null` removes the mapping). */
  setPlaneProject(args: {
    projectId: string;
    planeProject: string | null;
  }): Promise<BridgeResult<PlaneStatusDto>>;
  getCodeDiff(args: { sessionId: string; turnId: string }): Promise<BridgeResult<CodeDiffDto>>;
  getBehavior(): Promise<BridgeResult<BehaviorView>>;
  setBehavior(patch: BehaviorPatch): Promise<BridgeResult<BehaviorView>>;
  coworkStatus(): Promise<BridgeResult<CoworkStatusDto>>;
  /** Re-probes DeepSeek Harness now (otherwise the status is cached for a minute). */
  refreshCowork(): Promise<BridgeResult<CoworkStatusDto>>;
  listConnections(): Promise<BridgeResult<readonly ConnectionDto[]>>;
  prepareConnectionAction(
    args: ConnectionPrepareArgs,
  ): Promise<BridgeResult<ConnectionConfirmation>>;
  addConnection(args: ConnectionAddArgs): Promise<BridgeResult<ConnectionDto>>;
  disableConnection(args: ConnectionIdArgs): Promise<BridgeResult<ConnectionDto>>;
  enableConnection(args: ConnectionIdArgs): Promise<BridgeResult<ConnectionDto>>;
  removeConnection(args: ConnectionConfirmedArgs): Promise<BridgeResult<ConnectionDto>>;
  restoreConnection(args: ConnectionIdArgs): Promise<BridgeResult<ConnectionDto>>;
  forgetConnectionCredentials(args: ConnectionConfirmedArgs): Promise<BridgeResult<ConnectionDto>>;
  rotateConnectionKey(args: ConnectionRotateArgs): Promise<BridgeResult<ConnectionDto>>;
  addCodexConnection(args: ConnectionCodexAddArgs): Promise<BridgeResult<ConnectionDto>>;
  startCodexLogin(args: CodexLoginArgs): Promise<BridgeResult<CodexLoginStatus>>;
  cancelCodexLogin(args: ConnectionIdArgs): Promise<BridgeResult<CodexLoginStatus>>;
  codexLoginStatus(args: ConnectionIdArgs): Promise<BridgeResult<CodexLoginStatus>>;
  deleteCodexHome(args: ConnectionConfirmedArgs): Promise<BridgeResult<ConnectionDto>>;
  replaceChatGptPlanAccount(
    args: ConnectionConfirmedArgs,
  ): Promise<BridgeResult<ChatGptPlanStatus>>;
  /** Subscribes to task progress; returns the unsubscribe function. */
  onTaskEvent(callback: (event: TaskEvent) => void): () => void;
  /** Subscribes to Operating Session changes; returns the unsubscribe function. */
  onSessionEvent(callback: (event: SessionEvent) => void): () => void;
}
