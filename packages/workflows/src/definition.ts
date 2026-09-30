import { z } from 'zod';
import type { TaskKind, TaskRequirements } from '@nexar/contracts';

export const WORKFLOW_SCHEMA_VERSION = 1;
export const MAX_OUTPUTS = 4;

/** Hard ceilings that no definition may raise; a definition's own limits can only be lower. */
export const INPUT_LIMITS = {
  stringMax: 1_000,
  textMax: 100_000,
  listItemsMax: 200,
  listItemMax: 2_000,
} as const;

export const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FILE_REF = z.string().min(1).max(256);

const InputSchema = z.strictObject({
  name: z.string().regex(INPUT_NAME, 'input names are letters and digits, starting with a letter'),
  label: z.string().min(1).max(200).optional(),
  type: z.enum(['string', 'text', 'list', 'document-set']),
  required: z.boolean().optional(),
  /** `string`/`text`: the value; `list`: each item. */
  maxLength: z.number().int().positive().optional(),
  /** `list` only. */
  maxItems: z.number().int().positive().max(INPUT_LIMITS.listItemsMax).optional(),
});

const OutputSchema = z.strictObject({
  id: z.string().regex(SLUG),
  filename: z.string().min(1).max(256),
  mediaType: z.enum(['text/markdown', 'text/plain']),
  draft: z.boolean().optional(),
});

/** Zod schema of `workflow.json`. Strict: unknown keys are errors. */
export const WorkflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: z.string().regex(SLUG),
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  taskKind: z.string().regex(SLUG),
  requirements: z
    .strictObject({
      capabilities: z.array(z.string().regex(SLUG)).max(16).optional(),
      privacy: z.enum(['standard', 'local-only']).optional(),
    })
    .optional(),
  inputs: z.array(InputSchema).max(32),
  systemTemplate: FILE_REF.optional(),
  template: FILE_REF,
  outputs: z.array(OutputSchema).min(1).max(MAX_OUTPUTS),
});

export type WorkflowInputType = 'string' | 'text' | 'list' | 'document-set';

export interface WorkflowInput {
  readonly name: string;
  readonly label?: string;
  readonly type: WorkflowInputType;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly maxItems?: number;
}

export interface WorkflowOutput {
  readonly id: string;
  /** A template; the rendered name is sanitized by the artifact store. */
  readonly filename: string;
  readonly mediaType: 'text/markdown' | 'text/plain';
  readonly draft?: boolean;
}

/** A validated `workflow.json`. */
export interface WorkflowDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly taskKind: TaskKind;
  readonly requirements?: Pick<Partial<TaskRequirements>, 'capabilities' | 'privacy'>;
  readonly inputs: readonly WorkflowInput[];
  readonly systemTemplate?: string;
  readonly template: string;
  readonly outputs: readonly WorkflowOutput[];
}

/** The owner-facing facts of a workflow; what `nexar workflows list` and MCP show. */
export interface WorkflowSummary {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly taskKind: string;
  readonly source: 'builtin' | 'project';
  readonly inputs: readonly {
    readonly name: string;
    readonly label: string;
    readonly type: WorkflowInputType;
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

/** Effective limits for one input: the definition's own, bounded by the hard ceilings. */
export function inputLimits(input: WorkflowInput): { maxLength?: number; maxItems?: number } {
  switch (input.type) {
    case 'string':
      return { maxLength: Math.min(input.maxLength ?? 500, INPUT_LIMITS.stringMax) };
    case 'text':
      return { maxLength: Math.min(input.maxLength ?? 20_000, INPUT_LIMITS.textMax) };
    case 'list':
      return {
        maxLength: Math.min(input.maxLength ?? 500, INPUT_LIMITS.listItemMax),
        maxItems: Math.min(input.maxItems ?? 50, INPUT_LIMITS.listItemsMax),
      };
    case 'document-set':
      return { maxLength: 128 };
  }
}
