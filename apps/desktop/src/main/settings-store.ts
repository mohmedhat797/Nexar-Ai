import { readFile } from 'node:fs/promises';
import { validConnections } from './connection-state.js';
import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_CONTROL_RESOURCE_POLICY,
  NexarError,
  type ConnectionsSettings,
  type ControlResourcePolicy,
} from '@nexar/contracts';
import { DENSITIES, MODES, THEMES, type DesktopSettings } from '../shared/api.js';
import { PLANE_PROJECT_PATTERN } from '../shared/plane.js';
import {
  BEHAVIOR_RESOURCE_PATTERN,
  CODE_PERMISSIONS,
  COWORK_PERMISSIONS,
  DEFAULT_CODE_PERMISSION,
  DEFAULT_COWORK_PERMISSION,
  type BehaviorPatch,
  type BehaviorSettings,
} from '../shared/behavior.js';
import { writeFileAtomic } from './atomic-write.js';
import { migratePlanResourceId } from './plan-inventory-identity.js';

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: 'light',
  density: 'comfortable',
  mode: 'cowork',
};

const AppearanceSchema = z.strictObject({
  theme: z.enum(THEMES),
  density: z.enum(DENSITIES),
  mode: z.enum(MODES),
});

/** The patch a `settings:set` call may carry: any subset, nothing else. */
export const SettingsPatchSchema = z.strictObject({
  theme: z.enum(THEMES).optional(),
  density: z.enum(DENSITIES).optional(),
  mode: z.enum(MODES).optional(),
});

// ---- Code plane (ADR-025) ---------------------------------------------------------------------

export const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An absolute POSIX path inside the distro; `..` is refused below. */
export const COMMAND_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;
export const DESKTOP_PROJECT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export { PLANE_PROJECT_PATTERN };
export const MAX_PLANE_PROJECTS = 200;
export const DEFAULT_PLANE_DISTRO = 'nexar-plane';
export const DEFAULT_PLANE_COMMAND = '/usr/local/bin/nexar';

const CodePlaneSchema = z.strictObject({
  distro: z.string().regex(DISTRO_PATTERN).default(DEFAULT_PLANE_DISTRO),
  command: z
    .string()
    .regex(COMMAND_PATTERN)
    .refine((value) => !value.includes('..'), 'must not contain ..')
    .default(DEFAULT_PLANE_COMMAND),
  projects: z
    .record(z.string().regex(DESKTOP_PROJECT_PATTERN), z.string().regex(PLANE_PROJECT_PATTERN))
    .refine((map) => Object.keys(map).length <= MAX_PLANE_PROJECTS, 'too many projects')
    .default({}),
});

/** Owner configuration of the Code lane. Only `projects` is ever written by the app. */
export interface CodePlaneConfig {
  readonly distro: string;
  readonly command: string;
  readonly projects: Readonly<Record<string, string>>;
}

/** A damaged `codePlane` section fails closed: the Code lane reports it instead of guessing. */
export type CodePlaneConfigResult =
  { readonly valid: true; readonly value: CodePlaneConfig } | { readonly valid: false };

export const DEFAULT_CODE_PLANE: CodePlaneConfig = {
  distro: DEFAULT_PLANE_DISTRO,
  command: DEFAULT_PLANE_COMMAND,
  projects: {},
};

// ---- Cowork lane (ADR-026) --------------------------------------------------------------------

/** An absolute (either platform) path of a `.js` file: the DeepSeek Harness entry (ADR-030). */
export function validDshEntry(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.includes('\0')) return false;
  return (isAbsolute(value) || win32.isAbsolute(value)) && value.toLowerCase().endsWith('.js');
}

// Not strict: sections written by older builds may carry retired keys (ADR-030); they are ignored on
// read and kept on disk, because the app writes this section back exactly as found.
const CoworkSchema = z.object({
  /** The DeepSeek Harness entry script (development and tests); packaged builds ship their own. */
  dshEntry: z.string().refine(validDshEntry, 'invalid DeepSeek Harness entry').optional(),
});

/** Owner configuration of the Cowork lane; the app only reads it. */
export interface CoworkConfig {
  readonly dshEntry?: string | undefined;
}

/** A damaged `cowork` section fails closed (lane unavailable) and is preserved verbatim. */
export type CoworkConfigResult =
  { readonly valid: true; readonly value: CoworkConfig } | { readonly valid: false };

const DEFAULT_COWORK: CoworkConfig = {};

function parseCowork(raw: unknown): CoworkConfigResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_COWORK };
  const parsed = CoworkSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}
// ---- Orchestration (NXR-063) ------------------------------------------------------------------

const ControlResourceSchema = z
  .strictObject({
    mode: z.enum(['auto', 'pinned']),
    resourceId: z.string().min(1).max(200).optional(),
    fallback: z.enum(['auto', 'none']),
  })
  .refine((value) => (value.mode === 'pinned') === (value.resourceId !== undefined), {
    message: 'resourceId is required exactly when pinned',
  })
  .transform((value): ControlResourcePolicy => ({
    mode: value.mode,
    ...(value.resourceId === undefined
      ? {}
      : { resourceId: migratePlanResourceId(value.resourceId) }),
    fallback: value.fallback,
  }));

const OrchestrationSchema = z
  .strictObject({
    cowork: z.strictObject({ controlResource: ControlResourceSchema.optional() }).optional(),
  })
  .transform((value): OrchestrationSettings => ({
    cowork: { controlResource: value.cowork?.controlResource ?? DEFAULT_CONTROL_RESOURCE_POLICY },
  }));

/** Which resource drives a Cowork turn's control loop (the owner's policy; no IPC or UI yet). */
export interface OrchestrationSettings {
  readonly cowork: { readonly controlResource: ControlResourcePolicy };
}

export const DEFAULT_ORCHESTRATION: OrchestrationSettings = {
  cowork: { controlResource: DEFAULT_CONTROL_RESOURCE_POLICY },
};

/** A damaged `orchestration` section fails closed (no gateway path) and is preserved verbatim. */
export type OrchestrationResult =
  { readonly valid: true; readonly value: OrchestrationSettings } | { readonly valid: false };

function parseOrchestration(raw: unknown): OrchestrationResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_ORCHESTRATION };
  const parsed = OrchestrationSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

// ---- Legacy ChatGPT model preferences (never an availability source, NXR-068) -----------------

/** Model ids the owner lists for the ChatGPT plan; the same slug alphabet resource ids use. */
const PlanModelSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const ChatGptPlanSchema = z
  .strictObject({ models: z.array(PlanModelSchema).min(1).max(16) })
  .transform((value): ChatGptPlanSettings => ({ models: [...new Set(value.models)] }));

/** Legacy owner hints; fresh account/route discovery alone establishes availability. */
export interface ChatGptPlanSettings {
  readonly models: readonly string[];
}

export const DEFAULT_CHATGPT_PLAN: ChatGptPlanSettings = { models: [] };

/** Legacy metadata is preserved verbatim, including damaged sections. */
export type ChatGptPlanResult =
  { readonly valid: true; readonly value: ChatGptPlanSettings } | { readonly valid: false };

function parseChatGptPlan(raw: unknown): ChatGptPlanResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_CHATGPT_PLAN };
  const parsed = ChatGptPlanSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

// ---- Connections (ADR-029) --------------------------------------------------------------------

const CredentialScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('keystore'),
    name: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal('account'),
    name: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal('native-home'),
    runtimeId: z.enum(['claude-code', 'codex', 'antigravity']),
    home: z.enum(['default', 'private']),
  }),
  z.strictObject({
    kind: z.literal('none'),
  }),
]);

const PersistentConnectionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  provider: z.string().min(1).max(64),
  method: z.enum(['subscription', 'api', 'local', 'custom']),
  authClass: z.enum([
    'vendor-native',
    'official-api',
    'official-account',
    'experimental-client-compat',
    'none',
  ]),
  support: z.enum(['official', 'experimental']),
  machine: z.enum(['desktop', 'plane']),
  label: z.string().min(1).max(128),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  credentialScope: CredentialScopeSchema,
  credentialGeneration: z.number().int().nonnegative(),
  identityAssurance: z.enum([
    'VERIFIED_SAME_ACCOUNT',
    'OWNER_ASSERTED_SAME_ACCOUNT',
    'VERIFIED_DIFFERENT_ACCOUNT',
    'IDENTITY_UNKNOWN',
  ]),
  lifecycleState: z.enum(['ACTIVE', 'DISABLED', 'TOMBSTONED']),
  createdAt: z.string(),
  updatedAt: z.string(),
  assertion: z
    .strictObject({ type: z.literal('same-account'), at: z.string(), source: z.literal('owner') })
    .optional(),
  retirement: z.literal('replaced').optional(),
});

const ConnectionsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    connections: z.record(z.string(), PersistentConnectionSchema),
    tombstones: z.array(z.string()),
  })
  .refine(validConnections);

export const DEFAULT_CONNECTIONS: ConnectionsSettings = {
  schemaVersion: 1,
  connections: {},
  tombstones: [],
};

/** A damaged `connections` section fails closed and is preserved verbatim. */
export type ConnectionsConfigResult =
  { readonly valid: true; readonly value: ConnectionsSettings } | { readonly valid: false };

function parseConnections(raw: unknown): ConnectionsConfigResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_CONNECTIONS };
  const parsed = ConnectionsSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

// ---- AI behavior (NXR-053) --------------------------------------------------------------------

const ResourceIdSchema = z
  .string()
  .regex(BEHAVIOR_RESOURCE_PATTERN)
  .transform(migratePlanResourceId);
const BehaviorSchema = z
  .strictObject({
    cowork: z
      .strictObject({
        permission: z.enum(COWORK_PERMISSIONS).default(DEFAULT_COWORK_PERMISSION),
        preferredResourceId: ResourceIdSchema.optional(),
      })
      .optional(),
    code: z
      .strictObject({
        permission: z.enum(CODE_PERMISSIONS).default(DEFAULT_CODE_PERMISSION),
        preferredResourceId: ResourceIdSchema.optional(),
      })
      .optional(),
  })
  .transform((value): BehaviorSettings => ({
    cowork: value.cowork ?? { permission: DEFAULT_COWORK_PERMISSION },
    code: value.code ?? { permission: DEFAULT_CODE_PERMISSION },
  }));

/** A control-resource patch: `pinned` names a resource, `auto` never does (any id is dropped). */
const ControlPatchSchema = z
  .strictObject({
    mode: z.enum(['auto', 'pinned']),
    resourceId: ResourceIdSchema.optional(),
    fallback: z.enum(['auto', 'none']),
  })
  .refine((value) => value.mode === 'auto' || value.resourceId !== undefined, {
    message: 'resourceId is required when pinned',
  })
  .transform((value): ControlResourcePolicy => ({
    mode: value.mode,
    fallback: value.fallback,
    ...(value.mode === 'pinned' && value.resourceId !== undefined
      ? { resourceId: value.resourceId }
      : {}),
  }));

/** What a `behavior:set` call may carry: any subset of known values, nothing else. */
export const BehaviorPatchSchema = z.strictObject({
  cowork: z
    .strictObject({
      permission: z.enum(COWORK_PERMISSIONS).optional(),
      preferredResourceId: ResourceIdSchema.nullable().optional(),
      controlResource: ControlPatchSchema.optional(),
    })
    .optional(),
  code: z
    .strictObject({
      permission: z.enum(CODE_PERMISSIONS).optional(),
      preferredResourceId: ResourceIdSchema.nullable().optional(),
      // Accepted only so the handler can refuse it with a clear code: the plane owns this policy.
      controlResource: ControlPatchSchema.optional(),
    })
    .optional(),
});

export const DEFAULT_BEHAVIOR: BehaviorSettings = {
  cowork: { permission: DEFAULT_COWORK_PERMISSION },
  code: { permission: DEFAULT_CODE_PERMISSION },
};

/** A damaged `behavior` section fails closed (no turn starts on it) and is preserved verbatim. */
export type BehaviorResult =
  { readonly valid: true; readonly value: BehaviorSettings } | { readonly valid: false };

function parseBehavior(raw: unknown): BehaviorResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_BEHAVIOR };
  const parsed = BehaviorSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

function mergeBehavior(current: BehaviorSettings, patch: BehaviorPatch): BehaviorSettings {
  const preferred = (
    now: string | undefined,
    next: string | null | undefined,
  ): { preferredResourceId?: string } => {
    const value = next === undefined ? now : (next ?? undefined);
    return value === undefined ? {} : { preferredResourceId: value };
  };
  return {
    cowork: {
      permission: patch.cowork?.permission ?? current.cowork.permission,
      ...preferred(current.cowork.preferredResourceId, patch.cowork?.preferredResourceId),
    },
    code: {
      permission: patch.code?.permission ?? current.code.permission,
      ...preferred(current.code.preferredResourceId, patch.code?.preferredResourceId),
    },
  };
}

interface Loaded {
  readonly appearance: DesktopSettings;
  readonly behaviorRaw: unknown;
  readonly behavior: BehaviorResult;
  /** The raw `codePlane` value of the file (kept verbatim when invalid), or `undefined`. */
  readonly codePlaneRaw: unknown;
  readonly codePlane: CodePlaneConfigResult;
  readonly coworkRaw: unknown;
  readonly cowork: CoworkConfigResult;
  readonly orchestrationRaw: unknown;
  readonly orchestration: OrchestrationResult;
  /** Owner-edited; never written by Nexar, kept verbatim. */
  readonly chatgptPlanRaw: unknown;
  readonly chatgptPlan: ChatGptPlanResult;
  readonly connectionsRaw: unknown;
  readonly connections: ConnectionsConfigResult;
}

function parseCodePlane(raw: unknown): CodePlaneConfigResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_CODE_PLANE };
  const parsed = CodePlaneSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

/**
 * `desktop-settings.json`: appearance and mode for the renderer, plus the owner-edited `codePlane`
 * section (distro, command, project mapping) that the renderer can never read or write except for
 * the project mapping through its own channel. A missing or damaged file means the defaults.
 */
export class SettingsStore {
  private current: Loaded | undefined;
  /** Serializes read-modify-write cycles. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<Loaded> {
    if (this.current !== undefined) return this.current;
    let appearance: DesktopSettings = DEFAULT_SETTINGS;
    let codePlaneRaw: unknown;
    let coworkRaw: unknown;
    let behaviorRaw: unknown;
    let orchestrationRaw: unknown;
    let chatgptPlanRaw: unknown;
    let connectionsRaw: unknown;
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof file === 'object' && file !== null && !Array.isArray(file)) {
        const { codePlane, cowork, behavior, orchestration, chatgptPlan, connections, ...rest } =
          file as Record<string, unknown>;
        const parsed = AppearanceSchema.safeParse(rest);
        if (parsed.success) appearance = parsed.data;
        codePlaneRaw = Object.hasOwn(file, 'codePlane') ? codePlane : undefined;
        coworkRaw = Object.hasOwn(file, 'cowork') ? cowork : undefined;
        behaviorRaw = Object.hasOwn(file, 'behavior') ? behavior : undefined;
        orchestrationRaw = Object.hasOwn(file, 'orchestration') ? orchestration : undefined;
        chatgptPlanRaw = Object.hasOwn(file, 'chatgptPlan') ? chatgptPlan : undefined;
        connectionsRaw = Object.hasOwn(file, 'connections') ? connections : undefined;
      } else connectionsRaw = null;
    } catch (error) {
      // Appearance may default, but existing unreadable authority must never resurrect identities.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') connectionsRaw = null;
    }
    this.current = {
      appearance,
      codePlaneRaw,
      codePlane: parseCodePlane(codePlaneRaw),
      coworkRaw,
      cowork: parseCowork(coworkRaw),
      behaviorRaw,
      behavior: parseBehavior(behaviorRaw),
      orchestrationRaw,
      orchestration: parseOrchestration(orchestrationRaw),
      chatgptPlanRaw,
      chatgptPlan: parseChatGptPlan(chatgptPlanRaw),
      connectionsRaw,
      connections: parseConnections(connectionsRaw),
    };
    return this.current;
  }

  private async write(next: Loaded): Promise<void> {
    let existing: string | undefined;
    try {
      existing = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new NexarError('CONFIGURATION_ERROR', 'Settings backup is unavailable');
    }
    if (existing !== undefined) {
      let previous: unknown;
      try {
        previous = JSON.parse(existing);
      } catch {
        throw new NexarError(
          'CONFIGURATION_ERROR',
          'Damaged settings require recovery before writing',
        );
      }
      if (
        typeof previous !== 'object' ||
        previous === null ||
        Array.isArray(previous) ||
        !parseConnections((previous as Record<string, unknown>)['connections']).valid
      ) {
        throw new NexarError(
          'CONFIGURATION_ERROR',
          'Damaged settings require recovery before writing',
        );
      }
      // A failed required backup is an operation failure, never first-run success.
      await writeFileAtomic(`${this.path}.bak`, existing);
    }
    const section =
      next.codePlane.valid && next.codePlaneRaw === undefined
        ? {}
        : { codePlane: next.codePlane.valid ? next.codePlane.value : next.codePlaneRaw };
    const coworkSection = next.coworkRaw === undefined ? {} : { cowork: next.coworkRaw };
    const behaviorSection =
      next.behavior.valid && next.behaviorRaw === undefined
        ? {}
        : { behavior: next.behavior.valid ? next.behavior.value : next.behaviorRaw };
    const orchestrationSection =
      next.orchestration.valid && next.orchestrationRaw === undefined
        ? {}
        : {
            orchestration: next.orchestration.valid
              ? next.orchestration.value
              : next.orchestrationRaw,
          };
    const connectionsSection =
      next.connections.valid && next.connectionsRaw === undefined
        ? {}
        : {
            connections: next.connections.valid ? next.connections.value : next.connectionsRaw,
          };
    try {
      await writeFileAtomic(
        this.path,
        JSON.stringify(
          {
            ...next.appearance,
            ...section,
            ...coworkSection,
            ...behaviorSection,
            ...orchestrationSection,
            ...(next.chatgptPlanRaw === undefined ? {} : { chatgptPlan: next.chatgptPlanRaw }),
            ...connectionsSection,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (error) {
      this.current = undefined;
      throw error;
    }
    this.current = next;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The renderer-visible settings (never the Code plane section). */
  async get(): Promise<DesktopSettings> {
    return (await this.load()).appearance;
  }

  set(patch: z.infer<typeof SettingsPatchSchema>): Promise<DesktopSettings> {
    return this.serialized(async () => {
      const loaded = await this.load();
      const current = loaded.appearance;
      const appearance = AppearanceSchema.parse({
        theme: patch.theme ?? current.theme,
        density: patch.density ?? current.density,
        mode: patch.mode ?? current.mode,
      });
      await this.write({ ...loaded, appearance });
      return appearance;
    });
  }

  /** Main-process only: the validated Code plane configuration. */
  async getCodePlane(): Promise<CodePlaneConfigResult> {
    return (await this.load()).codePlane;
  }

  /**
   * Maps (or, with `null`, unmaps) a Desktop project to a plane project id. The distro and command
   * stay exactly as the owner wrote them. Refused while the section is damaged: guessing would
   * overwrite the owner's edit.
   */
  setPlaneProject(desktopProjectId: string, planeProject: string | null): Promise<CodePlaneConfig> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.codePlane.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The Code plane settings are not valid');
      }
      if (
        !DESKTOP_PROJECT_PATTERN.test(desktopProjectId) ||
        (planeProject !== null && !PLANE_PROJECT_PATTERN.test(planeProject))
      ) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid project id');
      }
      const projects: Record<string, string> = { ...loaded.codePlane.value.projects };
      if (planeProject === null) delete projects[desktopProjectId];
      else projects[desktopProjectId] = planeProject;
      if (Object.keys(projects).length > MAX_PLANE_PROJECTS) {
        throw new NexarError('POLICY_REJECTED', 'Too many project mappings');
      }
      const value: CodePlaneConfig = { ...loaded.codePlane.value, projects };
      await this.write({
        ...loaded,
        codePlaneRaw: value,
        codePlane: { valid: true, value },
      });
      return value;
    });
  }

  /** Main-process only: the validated AI behavior settings. */
  async getBehavior(): Promise<BehaviorResult> {
    return (await this.load()).behavior;
  }

  /** Applies a validated patch. Refused while the section is damaged: guessing would overwrite it. */
  setBehavior(patch: BehaviorPatch): Promise<BehaviorSettings> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.behavior.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The AI behavior settings are not valid');
      }
      const value = BehaviorSchema.parse(mergeBehavior(loaded.behavior.value, patch));
      await this.write({ ...loaded, behaviorRaw: value, behavior: { valid: true, value } });
      return value;
    });
  }

  /** Main-process only: the validated ChatGPT plan model list (owner-edited). */
  async getChatGptPlan(): Promise<ChatGptPlanResult> {
    return (await this.load()).chatgptPlan;
  }

  /** Main-process only: the validated orchestration settings. */
  async getOrchestration(): Promise<OrchestrationResult> {
    return (await this.load()).orchestration;
  }

  /** Sets the Cowork control-resource policy. Refused while the section is damaged. */
  setCoworkControlResource(policy: ControlResourcePolicy): Promise<ControlResourcePolicy> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.orchestration.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The orchestration settings are not valid');
      }
      const parsed = ControlResourceSchema.safeParse(policy);
      if (!parsed.success) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid control resource policy');
      }
      const controlResource = parsed.data;
      const value: OrchestrationSettings = { cowork: { controlResource } };
      await this.write({
        ...loaded,
        orchestrationRaw: value,
        orchestration: { valid: true, value },
      });
      return controlResource;
    });
  }

  /** Main-process only: the validated Cowork configuration. */
  async getCowork(): Promise<CoworkConfigResult> {
    return (await this.load()).cowork;
  }

  /** Main-process only: the validated connections configuration. */
  async getConnections(): Promise<ConnectionsConfigResult> {
    return (await this.load()).connections;
  }

  /** Saves connections settings. Refused while the section is damaged: guessing would overwrite it. */
  saveConnections(config: ConnectionsSettings): Promise<ConnectionsSettings> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.connections.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The connections settings are not valid');
      }
      const parsed = ConnectionsSchema.safeParse(config);
      if (!parsed.success) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid connections settings');
      }
      const value = parsed.data;
      await this.write({
        ...loaded,
        connectionsRaw: value,
        connections: { valid: true, value },
      });
      return value;
    });
  }
}
