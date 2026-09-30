import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError, isNexarError } from '@nexar/contracts';
import { resolveContainedPath, type ProjectRegistry } from '@nexar/projects';
import {
  WorkflowDefinitionSchema,
  inputLimits,
  type WorkflowDefinition,
  type WorkflowSummary,
} from './definition.js';
import { TemplateError, parseTemplate, type Template } from './template.js';

/** A validated workflow with its templates parsed; immutable. */
export interface LoadedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly source: 'builtin' | 'project';
  /** Trusted; never contains input values. */
  readonly system?: Template;
  readonly prompt: Template;
  /** Filename template per output id. */
  readonly filenames: Readonly<Record<string, Template>>;
  readonly summary: WorkflowSummary;
}

export const WORKFLOW_FILE = 'workflow.json';
const MAX_TEMPLATE_BYTES = 256 * 1024;

function configError(message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', message);
}

/** `resolveContainedPath` with any refusal reported as a configuration problem about `what`. */
async function contained(
  candidate: string,
  roots: readonly string[],
  what: string,
): Promise<string> {
  try {
    return await resolveContainedPath(candidate, roots);
  } catch (error) {
    if (!isNexarError(error)) throw error;
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    throw new NexarError(
      'CONFIGURATION_ERROR',
      reason === 'OUTSIDE_BOUNDARY'
        ? `${what} is outside its allowed directory`
        : `${what} does not exist or is not accessible`,
      { details: { reason: typeof reason === 'string' ? reason : 'UNKNOWN' } },
    );
  }
}

async function readContained(file: string, root: string, what: string): Promise<string> {
  const real = await contained(join(root, file), [root], what);
  const text = await readFile(real, 'utf8');
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) throw configError(`${what} is too large`);
  return text;
}

function summarize(
  definition: WorkflowDefinition,
  source: LoadedWorkflow['source'],
): WorkflowSummary {
  return {
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    taskKind: definition.taskKind,
    source,
    inputs: definition.inputs.map((input) => {
      const limits = inputLimits(input);
      return {
        name: input.name,
        label: input.label ?? input.name,
        type: input.type,
        required: input.required === true,
        ...(limits.maxLength === undefined ? {} : { maxLength: limits.maxLength }),
        ...(limits.maxItems === undefined ? {} : { maxItems: limits.maxItems }),
      };
    }),
    outputs: definition.outputs.map((o) => ({
      id: o.id,
      mediaType: o.mediaType,
      draft: o.draft === true,
    })),
  };
}

/**
 * Loads one workflow directory. `expectedId` is the directory's own name, which must equal the
 * definition's id. Every file the definition names must resolve (through symlinks) inside
 * `realDir`.
 */
async function loadWorkflow(
  realDir: string,
  expectedId: string,
  source: LoadedWorkflow['source'],
): Promise<LoadedWorkflow> {
  const label = `Workflow "${expectedId}"`;
  let json: unknown;
  try {
    json = JSON.parse(await readContained(WORKFLOW_FILE, realDir, `${label} ${WORKFLOW_FILE}`));
  } catch (error) {
    if (isNexarError(error)) throw error;
    throw new NexarError('CONFIGURATION_ERROR', `${label}: ${WORKFLOW_FILE} is not valid JSON`, {
      cause: error,
    });
  }
  const parsed = WorkflowDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`,
    );
    throw configError(`${label} is invalid: ${lines.join('; ')}`);
  }
  const definition = parsed.data as WorkflowDefinition;
  if (definition.id !== expectedId) {
    throw configError(`${label}: id "${definition.id}" must equal its directory name`);
  }
  const names = new Set<string>();
  for (const input of definition.inputs) {
    if (names.has(input.name)) throw configError(`${label}: duplicate input "${input.name}"`);
    names.add(input.name);
  }
  const outputIds = new Set<string>();
  for (const output of definition.outputs) {
    if (outputIds.has(output.id)) throw configError(`${label}: duplicate output "${output.id}"`);
    outputIds.add(output.id);
  }

  const parse = async (
    file: string,
    context: 'system' | 'prompt',
    field: string,
  ): Promise<Template> => {
    const text = await readContained(file, realDir, `${label} ${field} "${file}"`);
    try {
      return parseTemplate(text, context, definition.inputs, `${label} ${field} "${file}"`);
    } catch (error) {
      if (error instanceof TemplateError) throw configError(error.message);
      throw error;
    }
  };
  const system =
    definition.systemTemplate === undefined
      ? undefined
      : await parse(definition.systemTemplate, 'system', 'systemTemplate');
  const prompt = await parse(definition.template, 'prompt', 'template');

  const filenames: Record<string, Template> = {};
  for (const output of definition.outputs) {
    try {
      filenames[output.id] = parseTemplate(
        output.filename,
        'filename',
        definition.inputs,
        `${label} output "${output.id}" filename`,
      );
    } catch (error) {
      if (error instanceof TemplateError) throw configError(error.message);
      throw error;
    }
  }
  if (definition.outputs.length > 1) {
    // Several outputs only work if the prompt tells the model how to separate them.
    const mentionsMarkers = prompt.nodes
      .concat(system?.nodes ?? [])
      .some((n) => n.kind === 'var' && n.path === 'outputs.markers');
    if (!mentionsMarkers) {
      throw configError(
        `${label} has several outputs, so a template must include {{outputs.markers}}`,
      );
    }
  }
  return {
    definition,
    source,
    ...(system === undefined ? {} : { system }),
    prompt,
    filenames,
    summary: summarize(definition, source),
  };
}

/** Loads every workflow directory directly inside `directory`. */
async function loadDirectory(
  directory: string,
  source: LoadedWorkflow['source'],
  allowedRoots: readonly string[] | undefined,
): Promise<LoadedWorkflow[]> {
  const real =
    allowedRoots === undefined
      ? await realpathOrConfigError(directory)
      : await contained(directory, allowedRoots, 'Workflow directory');
  const loaded: LoadedWorkflow[] = [];
  const entries = (await readdir(real, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const realDir = await contained(
      join(real, entry.name),
      allowedRoots ?? [real],
      `Workflow "${entry.name}" directory`,
    );
    loaded.push(await loadWorkflow(realDir, entry.name, source));
  }
  return loaded;
}

async function realpathOrConfigError(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    throw new NexarError('CONFIGURATION_ERROR', 'Workflow directory does not exist', { cause });
  }
}

export interface WorkflowCatalogOptions {
  /** The directory of shipped workflows (one sub-directory per workflow). */
  readonly builtinDir: string;
  /**
   * Projects whose `workflows.directories` add to, and override by id, the built-ins for that
   * project only. Each directory must lie inside the project's roots.
   */
  readonly projects?: ProjectRegistry;
}

/** The workflows available, built-in and per project. Adding a workflow is adding a directory. */
export class WorkflowCatalog {
  private constructor(
    private readonly builtin: ReadonlyMap<string, LoadedWorkflow>,
    private readonly perProject: ReadonlyMap<string, ReadonlyMap<string, LoadedWorkflow>>,
  ) {}

  /** Fails closed with `CONFIGURATION_ERROR` on the first broken definition. */
  static async load(options: WorkflowCatalogOptions): Promise<WorkflowCatalog> {
    const builtin = new Map<string, LoadedWorkflow>();
    for (const workflow of await loadDirectory(options.builtinDir, 'builtin', undefined)) {
      builtin.set(workflow.definition.id, workflow);
    }
    const perProject = new Map<string, ReadonlyMap<string, LoadedWorkflow>>();
    for (const project of options.projects?.list() ?? []) {
      const extra = new Map<string, LoadedWorkflow>();
      for (const directory of project.workflows?.directories ?? []) {
        for (const workflow of await loadDirectory(directory, 'project', project.realRoots)) {
          extra.set(workflow.definition.id, workflow);
        }
      }
      if (extra.size > 0) perProject.set(project.id, extra);
    }
    return new WorkflowCatalog(builtin, perProject);
  }

  /** The workflows visible in a project (its own override same-id built-ins), sorted by id. */
  list(projectId?: string): readonly LoadedWorkflow[] {
    const merged = new Map(this.builtin);
    for (const [id, workflow] of (projectId === undefined
      ? undefined
      : this.perProject.get(projectId)) ?? []) {
      merged.set(id, workflow);
    }
    return [...merged.values()].sort((a, b) => (a.definition.id < b.definition.id ? -1 : 1));
  }

  get(id: string, projectId?: string): LoadedWorkflow | undefined {
    const own = projectId === undefined ? undefined : this.perProject.get(projectId)?.get(id);
    return own ?? this.builtin.get(id);
  }
}
