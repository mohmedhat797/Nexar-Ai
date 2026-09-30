import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  KNOWN_CAPABILITIES,
  NexarError,
  adapterId,
  projectId,
  resourceId,
  type ResourceDescriptor,
  type ResourceId,
} from '@nexar/contracts';
import { DEFAULT_TASK_KIND_RULES, type TaskKindRule } from '@nexar/resource-controller';
import type { ProjectDefaults, ProjectDefinition } from '@nexar/projects';

/** Validated, branded configuration consumed by `createNexar`. */
export interface NexarConfig {
  readonly version: 1;
  readonly resources: readonly ResourceDescriptor[];
  readonly routing: {
    readonly policy: 'deterministic';
    readonly defaultResourceId?: ResourceId;
    /** Built-in rules with the file's overrides merged on top. */
    readonly taskKinds: Readonly<Record<string, TaskKindRule>>;
  };
  readonly telemetry: {
    /** Relative paths are resolved against the config file's directory. */
    readonly jsonlPath?: string;
  };
  /** Project paths are absolute: relative config paths are resolved against the config directory. */
  readonly projects: readonly ProjectDefinition[];
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
  workflows: z
    .strictObject({
      directories: z.array(PathSchema).min(1).optional(),
      instructions: z.record(z.string().regex(WORKFLOW_ID), PathSchema).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** Zod schema of the JSON config file. Strict everywhere: unknown keys are errors. */
export const NexarConfigSchema = z.strictObject({
  version: z.literal(1),
  resources: z.array(ResourceSchema),
  routing: z
    .strictObject({
      policy: z.literal('deterministic'),
      defaultResourceId: ResourceIdSchema.optional(),
      taskKinds: z.record(z.string(), TaskKindRuleSchema).optional(),
    })
    .optional(),
  telemetry: z.strictObject({ jsonlPath: z.string().min(1).optional() }).optional(),
  projects: z.array(ProjectSchema).optional(),
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
  if (escapes || rel === '' || rel === '..' || rel.startsWith('../') || directory.includes('\0')) {
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
  const abs = (paths: readonly string[]): string[] => paths.map((p) => resolve(baseDir, p));
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
    if (project.artifactsDirectory !== undefined) {
      assertArtifactsDirectory(project.id, project.artifactsDirectory, origin);
    }
    projects.push({
      id: project.id,
      displayName: project.displayName,
      roots: abs(project.roots),
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
                        resolve(baseDir, path),
                      ]),
                    ),
                  }),
            },
          }),
      ...(project.metadata === undefined ? {} : { metadata: project.metadata }),
    });
  }

  const jsonlPath = data.telemetry?.jsonlPath;
  return {
    version: 1,
    resources,
    routing: {
      policy: 'deterministic',
      ...(defaultResourceId === undefined ? {} : { defaultResourceId }),
      taskKinds,
    },
    telemetry: jsonlPath === undefined ? {} : { jsonlPath },
    projects,
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
          capabilities: [...KNOWN_CAPABILITIES],
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
