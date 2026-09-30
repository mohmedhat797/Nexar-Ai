import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactStore } from '@nexar/artifacts';
import {
  NexarError,
  isNexarError,
  projectId as toProjectId,
  type ArtifactRef,
  type ExecutionEvent,
  type ExecutionRecord,
  type ExecutionResult,
  type NexarTask,
  type ProjectId,
  type RouteDecision,
  type TaskOrigin,
  type TaskRequirements,
} from '@nexar/contracts';
import type { NewTaskInput, RunOptions, RunOutcome } from '@nexar/core';
import {
  mergeRequirements,
  resolveContainedPath,
  type Project,
  type ProjectRegistry,
} from '@nexar/projects';
import type { LoadedWorkflow, WorkflowCatalog } from './catalog.js';
import { inputLimits, type WorkflowInput, type WorkflowSummary } from './definition.js';
import { markerInstructions, splitOutputs } from './outputs.js';
import { renderTemplate, type RenderValues } from './template.js';

/** The slice of the Nexar engine a workflow needs; the real `Nexar` class satisfies it. */
export interface WorkflowEngine {
  createTask(input: NewTaskInput): NexarTask;
  run(task: NexarTask, options?: RunOptions): Promise<RunOutcome>;
  recordArtifacts(
    forTask: NexarTask['id'],
    forProject: NexarTask['projectId'],
    artifacts: readonly ArtifactRef[],
  ): Promise<void>;
}

export interface WorkflowRunnerOptions {
  readonly nexar: WorkflowEngine;
  readonly projects: ProjectRegistry;
  readonly artifacts: ArtifactStore;
  readonly catalog: WorkflowCatalog;
  readonly clock?: () => Date;
}

export type WorkflowInputValues = Readonly<Record<string, string | readonly string[]>>;

export interface PrepareWorkflowInput {
  readonly workflowId: string;
  readonly projectId: string;
  readonly inputs: WorkflowInputValues;
  readonly origin: TaskOrigin;
  /** Merged with the workflow's own: capabilities union, `local-only` wins, caps take the minimum. */
  readonly requirements?: Partial<TaskRequirements>;
}

/** What a prepared run will store: file names are already rendered. */
export interface PreparedOutput {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: 'text/markdown' | 'text/plain';
  readonly draft: boolean;
}

/** Validated and rendered; running it is the first time any model is involved. */
export interface PreparedWorkflow {
  readonly workflowId: string;
  readonly projectId: ProjectId;
  readonly task: NexarTask;
  readonly outputs: readonly PreparedOutput[];
}

export interface WorkflowRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onEvent?: (event: ExecutionEvent) => void;
}

export interface WorkflowRunResult {
  readonly outcome: RunOutcome;
  readonly decision: RouteDecision;
  readonly result: ExecutionResult;
  readonly record: ExecutionRecord;
  readonly artifacts: readonly ArtifactRef[];
  /** False when a multi-output workflow's markers were missing: everything is in the first output. */
  readonly outputsSplit: boolean;
}

export interface InputIssue {
  readonly input: string;
  readonly problem: string;
}

const MAX_INSTRUCTIONS_BYTES = 50 * 1024;
const MAX_LISTED_DOCUMENTS = 200;
const DRAFT_BANNER =
  '> **DRAFT — not sent.** A local draft for you to review; nothing has been sent or scheduled.';

function validationError(issues: readonly InputIssue[]): NexarError {
  const lines = issues.map((i) => `${i.input}: ${i.problem}`);
  return new NexarError('VALIDATION_ERROR', `Invalid workflow inputs — ${lines.join('; ')}`, {
    details: { issues },
  });
}

/** Checks one input; returns its cleaned value (undefined = not provided) or the problem. */
function checkInput(
  input: WorkflowInput,
  value: string | readonly string[] | undefined,
): { readonly value?: string | readonly string[]; readonly problem?: string } {
  const { maxLength = 0, maxItems = 0 } = inputLimits(input);
  const noControls = (s: string): boolean => !s.includes('\0');
  if (input.type === 'list') {
    if (value === undefined) return {};
    if (!Array.isArray(value)) return { problem: 'expected a list of strings' };
    const items = (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : undefined));
    if (items.some((v) => v === undefined || !noControls(v))) {
      return { problem: 'every list item must be a string' };
    }
    const kept = (items as string[]).filter((v) => v !== '');
    if (kept.length > maxItems) return { problem: `too many items (maximum ${String(maxItems)})` };
    if (kept.some((v) => v.length > maxLength)) {
      return { problem: `an item is longer than ${String(maxLength)} characters` };
    }
    return kept.length === 0 ? {} : { value: kept };
  }
  if (value === undefined) return {};
  if (typeof value !== 'string') return { problem: 'expected a string' };
  if (!noControls(value)) return { problem: 'contains a NUL character' };
  if (value.trim() === '') return {};
  if (value.length > maxLength) {
    return { problem: `too long (maximum ${String(maxLength)} characters)` };
  }
  if (input.type === 'string' && /[\r\n]/.test(value)) {
    return { problem: 'must be a single line' };
  }
  return { value: input.type === 'document-set' ? value.trim() : value };
}

function documentLine(ref: ArtifactRef, workingDirectory: string): string {
  let path = ref.label ?? ref.uri;
  try {
    path = relative(workingDirectory, fileURLToPath(ref.uri));
  } catch {
    // Not a file URI: fall back to the label.
  }
  const clean = (s: string): string => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  const label = clean(ref.label ?? path);
  return label === clean(path) ? `- ${label}` : `- ${label} (${clean(path)})`;
}

/**
 * Turns a workflow definition plus owner-supplied inputs into a task, runs it and stores the
 * result as artifacts. Everything outward-facing stays a draft file: this package has no mail,
 * calendar or network client and never performs an outward action.
 */
export class WorkflowRunner {
  private readonly clock: () => Date;

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** The workflows visible in a project (or the built-ins when no project is given). */
  list(projectId?: string): readonly LoadedWorkflow[] {
    return this.options.catalog.list(projectId);
  }

  /** Summary of one workflow, or undefined if there is none with that id. */
  describe(workflowId: string, projectId?: string): WorkflowSummary | undefined {
    return this.options.catalog.get(workflowId, projectId)?.summary;
  }

  private async instructionsFor(project: Project, workflowId: string): Promise<string> {
    const configured = project.workflows?.instructions;
    const path =
      configured !== undefined && Object.hasOwn(configured, workflowId)
        ? configured[workflowId]
        : undefined;
    if (path === undefined) return '';
    const what = `Project "${project.id}" instructions for workflow "${workflowId}"`;
    try {
      const real = await resolveContainedPath(path, project.realRoots);
      const info = await stat(real);
      if (!info.isFile() || info.size > MAX_INSTRUCTIONS_BYTES) {
        throw new NexarError('CONFIGURATION_ERROR', `${what} must be a file under 50 KB`);
      }
      return (await readFile(real, 'utf8')).trim();
    } catch (error) {
      if (isNexarError(error) && error.code === 'CONFIGURATION_ERROR') throw error;
      throw new NexarError('CONFIGURATION_ERROR', `${what} is missing or outside the project`, {
        cause: error,
      });
    }
  }

  /**
   * Validates every input and renders the prompt. Throws `VALIDATION_ERROR` (with
   * `details.issues`) before any model or resource is involved.
   */
  async prepare(input: PrepareWorkflowInput): Promise<PreparedWorkflow> {
    const { projects, nexar, catalog } = this.options;
    const project = (() => {
      try {
        return projects.require(toProjectId(input.projectId));
      } catch {
        throw new NexarError('POLICY_REJECTED', 'Unknown project');
      }
    })();
    const workflow = catalog.get(input.workflowId, project.id);
    if (workflow === undefined) {
      throw new NexarError('VALIDATION_ERROR', 'Unknown workflow', {
        details: { issues: [{ input: 'workflow', problem: 'unknown workflow' }] },
      });
    }
    const { definition } = workflow;

    const issues: InputIssue[] = [];
    const declared = new Set(definition.inputs.map((i) => i.name));
    for (const name of Object.keys(input.inputs)) {
      if (!declared.has(name)) issues.push({ input: name, problem: 'unknown input' });
    }
    const values: Record<string, string | readonly string[]> = {};
    for (const spec of definition.inputs) {
      const raw = Object.hasOwn(input.inputs, spec.name) ? input.inputs[spec.name] : undefined;
      const checked = checkInput(spec, raw);
      if (checked.problem !== undefined)
        issues.push({ input: spec.name, problem: checked.problem });
      else if (checked.value !== undefined) values[spec.name] = checked.value;
      else if (spec.required === true) issues.push({ input: spec.name, problem: 'required' });
    }

    const attachments = new Map<string, ArtifactRef>();
    const documentRefs: Record<string, readonly ArtifactRef[]> = {};
    for (const spec of definition.inputs) {
      const name = values[spec.name];
      if (spec.type !== 'document-set' || typeof name !== 'string') continue;
      try {
        const refs = await projects.resolveDocumentSet(project, name);
        documentRefs[spec.name] = refs;
        for (const ref of refs) attachments.set(ref.uri, ref);
      } catch (error) {
        if (!isNexarError(error) || error.code !== 'VALIDATION_ERROR') throw error;
        issues.push({ input: spec.name, problem: 'unknown document set' });
      }
    }
    if (issues.length > 0) throw validationError(issues);

    const workingDirectory = await projects.resolveWorkingDirectory(project);
    const documents: Record<string, readonly string[]> = {};
    for (const [name, refs] of Object.entries(documentRefs)) {
      const lines = refs
        .slice(0, MAX_LISTED_DOCUMENTS)
        .map((r) => documentLine(r, workingDirectory));
      if (refs.length > MAX_LISTED_DOCUMENTS) {
        lines.push(`- … and ${String(refs.length - MAX_LISTED_DOCUMENTS)} more files`);
      }
      documents[name] = lines;
    }

    const date = this.clock().toISOString().slice(0, 10);
    const render: RenderValues = {
      project: {
        id: project.id,
        displayName: project.displayName,
        instructions: await this.instructionsFor(project, definition.id),
      },
      workflow: { id: definition.id, displayName: definition.displayName },
      date,
      markers: markerInstructions(definition.outputs),
      inputs: values,
      documents,
    };
    const prompt = renderTemplate(workflow.prompt, render);
    const systemPrompt =
      workflow.system === undefined ? undefined : renderTemplate(workflow.system, render);
    const outputs: PreparedOutput[] = definition.outputs.map((o) => {
      const filename = workflow.filenames[o.id];
      if (filename === undefined) {
        throw new NexarError(
          'INTERNAL_ERROR',
          `Workflow "${definition.id}" lost a filename template`,
        );
      }
      return {
        id: o.id,
        filename: renderTemplate(filename, render).trim(),
        mediaType: o.mediaType,
        draft: o.draft === true,
      };
    });

    const task = nexar.createTask({
      kind: definition.taskKind,
      title: definition.displayName,
      prompt,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      requirements: mergeRequirements(definition.requirements, input.requirements ?? {}),
      origin: input.origin,
      projectId: project.id,
      workingDirectory,
      ...(attachments.size === 0 ? {} : { attachments: [...attachments.values()] }),
      metadata: { workflowId: definition.id },
    });
    return { workflowId: definition.id, projectId: project.id, task, outputs };
  }

  /** Runs the task, then stores each output. If execution fails nothing is stored. */
  async run(
    prepared: PreparedWorkflow,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const { nexar, artifacts } = this.options;
    const outcome = await nexar.run(prepared.task, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });

    const { sections, split } = splitOutputs(outcome.result.text, prepared.outputs);
    if (!split) {
      options.onEvent?.({
        type: 'status',
        message:
          'output markers were missing or incomplete; the whole result was saved as the first output',
      });
    }
    const stored: ArtifactRef[] = [];
    for (const output of prepared.outputs) {
      const content = sections.get(output.id);
      if (content === undefined) continue;
      stored.push(
        await artifacts.store(
          {
            projectId: prepared.projectId,
            taskId: outcome.task.id,
            filename: output.filename,
            content:
              output.draft && !/draft/i.test(content.trimStart().split('\n', 1)[0] ?? '')
                ? `${DRAFT_BANNER}\n\n${content}`
                : content,
            mediaType: output.mediaType,
            draft: output.draft,
          },
          options.signal,
        ),
      );
    }
    await nexar.recordArtifacts(outcome.task.id, prepared.projectId, stored);
    return {
      outcome,
      decision: outcome.decision,
      result: outcome.result,
      record: outcome.record,
      artifacts: stored,
      outputsSplit: split,
    };
  }
}
