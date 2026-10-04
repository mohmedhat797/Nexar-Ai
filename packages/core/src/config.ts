import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  CREDENTIAL_NAME_MAX_LENGTH,
  CREDENTIAL_NAME_PATTERN,
  KNOWN_CAPABILITIES,
  NexarError,
  adapterId,
  projectId,
  resourceId,
  type ControlResourcePolicy,
  type DiscoveryCredentialSource,
  type ResourceDescriptor,
  type ResourceId,
} from '@nexar/contracts';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  DEFAULT_TASK_KIND_RULES,
  type ResourceIntelligenceSettings,
  type TaskKindRule,
} from '@nexar/resource-controller';
import type { ProjectDefaults, ProjectDefinition } from '@nexar/projects';

/** Validated, branded configuration consumed by `createNexar`. */
export interface NexarConfig {
  readonly version: 1;
  readonly resources: readonly ResourceDescriptor[];
  readonly routing: {
    /** `deterministic` (v0.1 behaviour, default) or `resource-intelligence` (ADR-020). */
    readonly policy: 'deterministic' | 'resource-intelligence';
    readonly defaultResourceId?: ResourceId;
    /** Built-in rules with the file's overrides merged on top. */
    readonly taskKinds: Readonly<Record<string, TaskKindRule>>;
    /** Resolved settings (defaults applied); used by `resource-intelligence` and quota accounting. */
    readonly resourceIntelligence: ResourceIntelligenceSettings;
  };
  readonly telemetry: {
    /** Relative paths are resolved against the config file's directory. */
    readonly jsonlPath?: string;
  };
  /**
   * Project paths are absolute. `roots` resolve against the config directory; every other
   * project-internal path resolves against the project's first root.
   */
  readonly projects: readonly ProjectDefinition[];
  /** Engineering plane settings (ADR-019); absent when the file has no `engineering` section. */
  readonly engineering?: EngineeringConfig;
  /** Resource discovery (ADR-020 §9); defaults applied, disabled unless the file enables it. */
  readonly discovery: DiscoveryConfig;
  /** Owner policy for orchestrating engines (ADR-027); absent when the file has no orchestration section. */
  readonly orchestration?: {
    readonly code?: { readonly controlResource?: ControlResourcePolicy };
  };
}

/** Resolved discovery settings. Discovered ids are not referenceable from routing rules in v0.4. */
export interface DiscoveryConfig {
  /** Register discovered resources for routing; `nexar resources --discovered` works either way. */
  readonly enabled: boolean;
  /** Reference source for discovered API providers; defaults to `env`, with no fallback. */
  readonly credentialSource: DiscoveryCredentialSource;
  readonly refreshIntervalMs: number;
  /** Per source. */
  readonly timeoutMs: number;
  readonly excludeIds: readonly string[];
  readonly cli: { readonly enabled: boolean };
  readonly piCatalog: {
    readonly enabled: boolean;
    readonly providers: readonly string[];
    readonly maxModels: number;
  };
  readonly localEndpoints: {
    readonly enabled: boolean;
    readonly endpoints: readonly {
      readonly id: string;
      readonly kind: 'ollama' | 'openai-compatible';
      readonly baseUrl: string;
      /** The owner declares the server supports tool calling (grants `model-turn`); default false. */
      readonly toolCalling?: boolean;
    }[];
  };
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  enabled: false,
  credentialSource: 'env',
  refreshIntervalMs: 10 * 60 * 1000,
  timeoutMs: 3000,
  excludeIds: [],
  cli: { enabled: true },
  piCatalog: { enabled: false, providers: [], maxModels: 50 },
  localEndpoints: { enabled: true, endpoints: [] },
};

/** Global engineering settings. Paths are absolute (`~/` expanded, relative → config directory). */
export interface EngineeringConfig {
  readonly worktreesDir?: string;
  /** Host toolchain directories for the sandbox launcher; carried, not interpreted here. */
  readonly toolchainPaths: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  readonly approvalTtlMs: number;
}

function branded<T>(kind: string, make: (s: string) => T): z.ZodType<T, string> {
  return z.string().transform((value, ctx) => {
    try {
      return make(value);
    } catch {
      ctx.issues.push({ code: 'custom', message: `invalid ${kind} "${value}"`, input: value });
      return z.NEVER;
    }
  });
}

const ResourceIdSchema = branded('resource id', resourceId);
const ProjectIdSchema = branded('project id', projectId);
const AdapterIdSchema = branded('adapter id', adapterId);
const StringList = z.array(z.string());
const FreeForm = z.record(z.string(), z.unknown());

// Credentials are references only; there is deliberately no field that could hold a secret value.
const CredentialSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('env'), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.strictObject({
    source: z.literal('keystore'),
    name: z.string().max(CREDENTIAL_NAME_MAX_LENGTH).regex(CREDENTIAL_NAME_PATTERN),
  }),
  z.strictObject({ source: z.literal('runtime-managed'), description: z.string().min(1) }),
]);

const AuthSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('api-key'), credential: CredentialSchema }),
  z.strictObject({ mode: z.literal('oauth'), credential: CredentialSchema }),
  z.strictObject({ mode: z.literal('subscription'), credential: CredentialSchema }),
]);

const KindSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('model'),
    provider: z.string().min(1),
    model: z.string().min(1),
    access: z.enum(['api', 'subscription', 'local']),
  }),
  z.strictObject({
    type: z.literal('agent'),
    agent: z.string().min(1),
    interface: z.enum(['cli', 'sdk', 'rpc', 'acp', 'mcp']),
    underlying: z
      .strictObject({ provider: z.string().optional(), model: z.string().optional() })
      .optional(),
  }),
  z.strictObject({
    type: z.literal('tool-runtime'),
    tool: z.string().min(1),
    interface: z.enum(['cli', 'sdk', 'rpc', 'mcp', 'http']),
  }),
]);

const CostSchema = z.discriminatedUnion('model', [
  z.strictObject({
    model: z.literal('per-token'),
    currency: z.literal('USD'),
    inputPerMillionTokens: z.number().nonnegative(),
    outputPerMillionTokens: z.number().nonnegative(),
  }),
  z.strictObject({ model: z.literal('subscription'), plan: z.string().optional() }),
  z.strictObject({ model: z.literal('local-compute') }),
  z.strictObject({ model: z.literal('free') }),
  z.strictObject({ model: z.literal('unknown') }),
]);

const ResourceSchema = z.strictObject({
  id: ResourceIdSchema,
  displayName: z.string().min(1),
  kind: KindSchema,
  capabilities: StringList,
  runtime: z.strictObject({
    adapter: AdapterIdSchema,
    locality: z.enum(['local', 'remote']),
    options: FreeForm.optional(),
  }),
  auth: AuthSchema,
  cost: CostSchema,
  limits: z
    .strictObject({
      contextWindowTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
  dataLocality: z.enum(['local', 'third-party']),
  tags: StringList.optional(),
  metadata: FreeForm.optional(),
});

const TaskKindRuleSchema = z.strictObject({
  requiredCapabilities: StringList,
  preferredResourceIds: z.array(ResourceIdSchema).optional(),
});

const DOCUMENT_SET_NAME = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const PathSchema = z.string().min(1);
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LANE_ROLES = ['architecture', 'feature', 'tests', 'debugging', 'review', 'report'] as const;

const ArgvSchema = z.array(z.string().min(1)).min(1);
const EngineeringCommandSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  command: ArgvSchema,
  timeoutMs: z.number().int().positive().max(86_400_000).default(600_000),
});

const ProjectEngineeringSchema = z.strictObject({
  repository: PathSchema.default('.'),
  baseBranch: z.string().min(1).default('main'),
  setup: z.array(EngineeringCommandSchema).default([]),
  setupAllowHosts: z.array(z.string().min(1)).default([]),
  gates: z.array(EngineeringCommandSchema).default([]),
  laneTimeoutMs: z.number().int().positive().max(86_400_000).default(1_800_000),
  maxReworkRounds: z.number().int().min(0).max(3).default(1),
  reviewDiversity: z.enum(['preferred', 'required']).default('preferred'),
  ownerApproval: z.enum(['always', 'never']).default('always'),
  lanePreferences: z
    .strictObject(
      Object.fromEntries(LANE_ROLES.map((role) => [role, z.array(ResourceIdSchema).optional()])),
    )
    .default({}),
  patchPolicy: z
    .strictObject({
      denyGlobs: z.array(z.string().min(1)).default([]),
      allowSymlinks: z.boolean().default(false),
      allowModeChanges: z.boolean().default(false),
      maxBytes: z.number().int().positive().default(5_242_880),
    })
    .default({ denyGlobs: [], allowSymlinks: false, allowModeChanges: false, maxBytes: 5_242_880 }),
});

const EngineeringSchema = z.strictObject({
  worktreesDir: PathSchema.optional(),
  toolchainPaths: z.array(PathSchema).default([]),
  author: z
    .strictObject({ name: z.string().min(1), email: z.string().min(1) })
    .default({ name: 'Nexar', email: 'nexar@localhost' }),
  approvalTtlMs: z.number().int().positive().default(1_800_000),
});

const ProjectSchema = z.strictObject({
  id: ProjectIdSchema,
  displayName: z.string().min(1),
  roots: z.array(PathSchema).min(1),
  workingDirectories: z.array(PathSchema).min(1).optional(),
  artifactsDirectory: PathSchema.optional(),
  documentSets: z
    .record(z.string().regex(DOCUMENT_SET_NAME), z.array(PathSchema).min(1))
    .optional(),
  defaults: z
    .strictObject({
      capabilities: StringList.optional(),
      privacy: z.enum(['standard', 'local-only']).optional(),
      preferredResourceIds: z.array(ResourceIdSchema).optional(),
      excludedResourceIds: z.array(ResourceIdSchema).optional(),
      minContextTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  engineering: ProjectEngineeringSchema.optional(),
  workflows: z
    .strictObject({
      directories: z.array(PathSchema).min(1).optional(),
      instructions: z.record(z.string().regex(WORKFLOW_ID), PathSchema).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const Fraction = z.number().min(0).max(1);
const Weight = z.number().min(0).max(100);
const QuotaWindowSchema = z.union([
  z.enum(['daily', 'weekly', 'monthly']),
  z.strictObject({
    hours: z
      .number()
      .positive()
      .max(24 * 366),
  }),
]);
const ResourceIntelligenceSchema = z.strictObject({
  weights: z
    .strictObject({
      default: Weight.optional(),
      availability: Weight.optional(),
      auth: Weight.optional(),
      quota: Weight.optional(),
      cost: Weight.optional(),
      latency: Weight.optional(),
      success: Weight.optional(),
      lane: Weight.optional(),
    })
    .optional(),
  preferences: z.enum(['authoritative', 'weighted']).optional(),
  history: z
    .strictObject({
      windowDays: z.number().int().min(1).max(365).optional(),
      minSamples: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
  quota: z
    .strictObject({
      unknownScore: Fraction.optional(),
      staleAfterMs: z.number().int().positive().optional(),
      exhaustedHoldMs: z.number().int().positive().optional(),
    })
    .optional(),
  cost: z
    .strictObject({
      defaultOutputTokens: z.number().int().positive().max(10_000_000).optional(),
      unknownUnderLimit: z.enum(['reject', 'allow']).optional(),
      costScaleUsd: z.number().positive().optional(),
      subscriptionScore: Fraction.optional(),
    })
    .optional(),
  latencyScaleMs: z.number().positive().optional(),
  reservations: z
    .array(
      z.strictObject({
        resourceId: ResourceIdSchema,
        reserveFraction: z.number().gt(0).lt(1),
        reservedFor: z.strictObject({
          taskKinds: StringList.optional(),
          laneRoles: z.array(z.enum(LANE_ROLES)).optional(),
        }),
      }),
    )
    .optional(),
  allowances: z
    .array(
      z.strictObject({
        resourceId: ResourceIdSchema,
        unit: z.enum(['requests', 'tokens', 'usd']),
        limit: z.number().positive(),
        window: QuotaWindowSchema,
        label: z.string().min(1).max(64).optional(),
      }),
    )
    .optional(),
});

const DiscoverySchema = z.strictObject({
  enabled: z.boolean().optional(),
  credentialSource: z.enum(['env', 'keystore']).optional(),
  refreshIntervalMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  excludeIds: StringList.optional(),
  sources: z
    .strictObject({
      cli: z.strictObject({ enabled: z.boolean().optional() }).optional(),
      piCatalog: z
        .strictObject({
          enabled: z.boolean().optional(),
          providers: z.array(z.string().min(1)).optional(),
          maxModels: z.number().int().min(1).max(500).optional(),
        })
        .optional(),
      localEndpoints: z
        .strictObject({
          enabled: z.boolean().optional(),
          endpoints: z
            .array(
              z.strictObject({
                id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
                kind: z.enum(['ollama', 'openai-compatible']),
                baseUrl: z
                  .string()
                  .url()
                  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL'),
                toolCalling: z.boolean().optional(),
              }),
            )
            .max(32)
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const ControlResourceSchema = z
  .strictObject({
    mode: z.enum(['auto', 'pinned']),
    resourceId: z.string().min(1).max(128).optional(),
    fallback: z.enum(['auto', 'none']).default('auto'),
  })
  .refine((c) => (c.mode === 'pinned') === (c.resourceId !== undefined), {
    message: 'resourceId is required when mode is pinned and not allowed otherwise',
  });

/** Drops the undefined keys zod leaves on optional fields. */
function resolveOrchestration(
  data: NonNullable<z.infer<typeof NexarConfigSchema>['orchestration']>,
): NonNullable<NexarConfig['orchestration']> {
  const policy = data.code?.controlResource;
  if (policy === undefined) return {};
  const { mode, resourceId, fallback } = policy;
  return {
    code: {
      controlResource: { mode, fallback, ...(resourceId === undefined ? {} : { resourceId }) },
    },
  };
}

/** Zod schema of the JSON config file. Strict everywhere: unknown keys are errors. */
export const NexarConfigSchema = z.strictObject({
  version: z.literal(1),
  resources: z.array(ResourceSchema),
  routing: z
    .strictObject({
      policy: z.enum(['deterministic', 'resource-intelligence']),
      defaultResourceId: ResourceIdSchema.optional(),
      taskKinds: z.record(z.string(), TaskKindRuleSchema).optional(),
      resourceIntelligence: ResourceIntelligenceSchema.optional(),
    })
    .optional(),
  telemetry: z.strictObject({ jsonlPath: z.string().min(1).optional() }).optional(),
  projects: z.array(ProjectSchema).optional(),
  engineering: EngineeringSchema.optional(),
  discovery: DiscoverySchema.optional(),
  orchestration: z
    .strictObject({
      code: z.strictObject({ controlResource: ControlResourceSchema.optional() }).optional(),
    })
    .optional(),
});

function configError(message: string, origin: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', `Invalid Nexar config (${origin}): ${message}`, {
    details: { origin },
  });
}

/** Lexical check (no filesystem): relative, and still inside the first root after `..` is applied. */
function assertArtifactsDirectory(id: string, directory: string, origin: string): void {
  const escapes = isAbsolute(directory) || /^[A-Za-z]:/.test(directory);
  const rel = relative('/root', resolve('/root', directory));
  if (
    escapes ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    directory.includes('\0')
  ) {
    throw configError(
      `projects.${id}.artifactsDirectory must be a relative path inside the project root`,
      origin,
    );
  }
}

export interface ParseConfigOptions {
  /** Directory relative project paths resolve against. Default: `process.cwd()`. */
  readonly baseDir?: string;
}

/** Validates a config JSON value and converts it to branded contract types. */
export function parseConfig(
  json: unknown,
  origin: string,
  options: ParseConfigOptions = {},
): NexarConfig {
  const parsed = NexarConfigSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`,
    );
    throw configError(lines.join('; '), origin);
  }
  const data = parsed.data;

  // zod omits absent optional keys, so this matches the exact-optional contract types at runtime.
  const resources = data.resources as unknown as readonly ResourceDescriptor[];
  const known = new Set<ResourceId>();
  for (const r of resources) {
    if (known.has(r.id)) throw configError(`duplicate resource id "${r.id}"`, origin);
    known.add(r.id);
  }

  const routing = data.routing;
  const defaultResourceId = routing?.defaultResourceId;
  if (defaultResourceId !== undefined && !known.has(defaultResourceId)) {
    throw configError(
      `routing.defaultResourceId "${defaultResourceId}" is not a registered resource`,
      origin,
    );
  }
  const taskKinds: Record<string, TaskKindRule> = { ...DEFAULT_TASK_KIND_RULES };
  for (const [kind, rule] of Object.entries(routing?.taskKinds ?? {})) {
    for (const id of rule.preferredResourceIds ?? []) {
      if (!known.has(id)) {
        throw configError(
          `routing.taskKinds.${kind}.preferredResourceIds references unknown resource "${id}"`,
          origin,
        );
      }
    }
    taskKinds[kind] = rule as TaskKindRule;
  }

  const baseDir = options.baseDir ?? process.cwd();
  const projectIds = new Set<string>();
  const projects: ProjectDefinition[] = [];
  for (const project of data.projects ?? []) {
    if (projectIds.has(project.id)) {
      throw configError(`duplicate project id "${project.id}"`, origin);
    }
    projectIds.add(project.id);
    const defaults = project.defaults;
    for (const id of [
      ...(defaults?.preferredResourceIds ?? []),
      ...(defaults?.excludedResourceIds ?? []),
    ]) {
      if (!known.has(id)) {
        throw configError(
          `projects.${project.id}.defaults references unknown resource "${id}"`,
          origin,
        );
      }
    }
    for (const [role, ids] of Object.entries(project.engineering?.lanePreferences ?? {})) {
      for (const id of ids ?? []) {
        if (!known.has(id)) {
          throw configError(
            `projects.${project.id}.engineering.lanePreferences.${role} references unknown resource "${id}"`,
            origin,
          );
        }
      }
    }
    if (project.artifactsDirectory !== undefined) {
      assertArtifactsDirectory(project.id, project.artifactsDirectory, origin);
    }
    const roots = project.roots.map((p) => resolve(baseDir, p));
    const firstRoot = roots[0] as string;
    const abs = (paths: readonly string[]): string[] => paths.map((p) => resolve(firstRoot, p));
    projects.push({
      id: project.id,
      displayName: project.displayName,
      roots,
      ...(project.workingDirectories === undefined
        ? {}
        : { workingDirectories: abs(project.workingDirectories) }),
      ...(project.artifactsDirectory === undefined
        ? {}
        : { artifactsDirectory: project.artifactsDirectory }),
      ...(project.documentSets === undefined
        ? {}
        : {
            documentSets: Object.fromEntries(
              Object.entries(project.documentSets).map(([name, entries]) => [name, abs(entries)]),
            ),
          }),
      ...(defaults === undefined ? {} : { defaults: defaults as ProjectDefaults }),
      ...(project.workflows === undefined
        ? {}
        : {
            workflows: {
              ...(project.workflows.directories === undefined
                ? {}
                : { directories: abs(project.workflows.directories) }),
              ...(project.workflows.instructions === undefined
                ? {}
                : {
                    instructions: Object.fromEntries(
                      Object.entries(project.workflows.instructions).map(([id, path]) => [
                        id,
                        resolve(firstRoot, path),
                      ]),
                    ),
                  }),
            },
          }),
      ...(project.engineering === undefined
        ? {}
        : {
            engineering: {
              ...project.engineering,
              repository: resolve(firstRoot, project.engineering.repository),
            },
          }),
      ...(project.metadata === undefined ? {} : { metadata: project.metadata }),
    });
  }

  const engineering = data.engineering;
  const expand = (path: string): string =>
    path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : resolve(baseDir, path);
  const jsonlPath = data.telemetry?.jsonlPath;
  const discovery = resolveDiscovery(data.discovery, origin);
  return {
    version: 1,
    resources,
    routing: {
      policy: routing?.policy ?? 'deterministic',
      ...(defaultResourceId === undefined ? {} : { defaultResourceId }),
      taskKinds,
      resourceIntelligence: resolveResourceIntelligence(
        routing?.resourceIntelligence,
        known,
        origin,
      ),
    },
    telemetry: jsonlPath === undefined ? {} : { jsonlPath },
    projects,
    discovery,
    ...(data.orchestration === undefined
      ? {}
      : { orchestration: resolveOrchestration(data.orchestration) }),
    ...(engineering === undefined
      ? {}
      : {
          engineering: {
            ...(engineering.worktreesDir === undefined
              ? {}
              : { worktreesDir: expand(engineering.worktreesDir) }),
            toolchainPaths: engineering.toolchainPaths.map(expand),
            author: engineering.author,
            approvalTtlMs: engineering.approvalTtlMs,
          },
        }),
  };
}

/**
 * Zero-configuration setup: only the offline echo resource, which is also the default.
 * Written as plain JSON (not imported from the echo integration) so core stays adapter-agnostic.
 */
export function defaultConfig(): NexarConfig {
  return parseConfig(
    {
      version: 1,
      resources: [
        {
          id: 'local-echo',
          displayName: 'Local Echo',
          kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
          // Echo takes no caller tool schemas, so it is not a model-turn resource.
          capabilities: KNOWN_CAPABILITIES.filter((c) => c !== 'model-turn'),
          runtime: { adapter: 'echo', locality: 'local' },
          auth: { mode: 'none' },
          cost: { model: 'free' },
          dataLocality: 'local',
        },
      ],
      routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
    },
    'default',
  );
}

export interface LoadConfigOptions {
  readonly explicitPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export interface LoadedConfig {
  readonly config: NexarConfig;
  readonly source: 'explicit' | 'env' | 'cwd' | 'default';
  /** Absolute path of the file read; absent for the built-in default. */
  readonly path?: string;
}

async function readConfigFile(path: string, origin: string): Promise<NexarConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new NexarError('CONFIGURATION_ERROR', `Cannot read Nexar config ${path}`, { cause });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new NexarError('CONFIGURATION_ERROR', `Config ${path} is not valid JSON`, { cause });
  }
  return parseConfig(json, origin, { baseDir: dirname(path) });
}

/** Resolution order: explicit path > NEXAR_CONFIG_PATH > `<cwd>/nexar.config.json` > built-in default. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const explicit = options.explicitPath;
  if (explicit !== undefined && explicit !== '') {
    const path = resolve(cwd, explicit);
    return { config: await readConfigFile(path, path), source: 'explicit', path };
  }
  const fromEnv = env['NEXAR_CONFIG_PATH'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const path = resolve(cwd, fromEnv);
    return { config: await readConfigFile(path, path), source: 'env', path };
  }
  const cwdPath = join(cwd, 'nexar.config.json');
  try {
    return { config: await readConfigFile(cwdPath, cwdPath), source: 'cwd', path: cwdPath };
  } catch (error) {
    const missing = (error as { cause?: { code?: string } }).cause?.code === 'ENOENT';
    if (!missing) throw error;
  }
  return { config: defaultConfig(), source: 'default' };
}

type ResourceIntelligenceInput = z.infer<typeof ResourceIntelligenceSchema>;

/** Overlays the defined keys of `over` on `base` (absent keys keep their defaults). */
function withDefaults<T extends object>(
  base: T,
  over: { [K in keyof T]?: T[K] | undefined } | undefined,
): T {
  const result = { ...base };
  for (const key of Object.keys(over ?? {}) as (keyof T)[]) {
    const value = over?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Applies documented defaults and checks every referenced resource exists. */
function resolveDiscovery(
  input: z.infer<typeof DiscoverySchema> | undefined,
  origin: string,
): DiscoveryConfig {
  const d = DEFAULT_DISCOVERY_CONFIG;
  if (input === undefined) return d;
  const pi = input.sources?.piCatalog;
  const local = input.sources?.localEndpoints;
  const piCatalog = {
    enabled: pi?.enabled ?? d.piCatalog.enabled,
    providers: [...new Set(pi?.providers ?? [])],
    maxModels: pi?.maxModels ?? d.piCatalog.maxModels,
  };
  // The catalog is never enumerated without an explicit owner allowlist.
  if (piCatalog.enabled && piCatalog.providers.length === 0) {
    throw configError(
      'discovery.sources.piCatalog.enabled requires a non-empty providers list',
      origin,
    );
  }
  const endpoints = (local?.endpoints ?? []).map(({ toolCalling, ...rest }) =>
    toolCalling === undefined ? rest : { ...rest, toolCalling },
  );
  if (new Set(endpoints.map((e) => e.id)).size !== endpoints.length) {
    throw configError('discovery.sources.localEndpoints.endpoints ids must be unique', origin);
  }
  return {
    enabled: input.enabled ?? d.enabled,
    credentialSource: input.credentialSource ?? d.credentialSource,
    refreshIntervalMs: input.refreshIntervalMs ?? d.refreshIntervalMs,
    timeoutMs: input.timeoutMs ?? d.timeoutMs,
    excludeIds: input.excludeIds ?? d.excludeIds,
    cli: { enabled: input.sources?.cli?.enabled ?? d.cli.enabled },
    piCatalog,
    localEndpoints: { enabled: local?.enabled ?? d.localEndpoints.enabled, endpoints },
  };
}

function resolveResourceIntelligence(
  input: ResourceIntelligenceInput | undefined,
  resourceIds: ReadonlySet<string>,
  origin: string,
): ResourceIntelligenceSettings {
  const d = DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS;
  if (input === undefined) return d;
  const refs = [
    ...(input.reservations ?? []).map((r) => ['reservations', r.resourceId] as const),
    ...(input.allowances ?? []).map((a) => ['allowances', a.resourceId] as const),
  ];
  for (const [where, id] of refs) {
    if (!resourceIds.has(id)) {
      throw configError(
        `routing.resourceIntelligence.${where} references unknown resource "${id}"`,
        origin,
      );
    }
  }
  return {
    weights: withDefaults(d.weights, input.weights),
    preferences: input.preferences ?? d.preferences,
    history: withDefaults(d.history, input.history),
    quota: withDefaults(d.quota, input.quota),
    cost: withDefaults(d.cost, input.cost),
    latencyScaleMs: input.latencyScaleMs ?? d.latencyScaleMs,
    reservations: (input.reservations ?? []) as ResourceIntelligenceSettings['reservations'],
    allowances: (input.allowances ?? []) as ResourceIntelligenceSettings['allowances'],
  };
}
