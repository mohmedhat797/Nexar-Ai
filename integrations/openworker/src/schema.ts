import { z } from 'zod';
import { resourceId, type ArtifactRef, type Measured, type NexarErrorCode } from '@nexar/contracts';

/** Schema version of the Work Bridge request/response contract. */
export const WORK_BRIDGE_VERSION = 2;

export const DEFAULT_MAX_REQUEST_CHARS = 100_000;

const SLUG = /^[a-z][a-z0-9-]*$/;
const WORKFLOW_INPUT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

const ResourceIdField = z.string().refine(
  (value) => {
    try {
      resourceId(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid resource id' },
);

/** Builds the request schema; `maxRequestChars` bounds `request` (default 100_000). */
export function createWorkRequestSchema(maxRequestChars: number = DEFAULT_MAX_REQUEST_CHARS) {
  return z.strictObject({
    version: z.literal(WORK_BRIDGE_VERSION),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    source: z.string().min(1).max(64),
    project: z.string().min(1).max(128),
    // `taskKind` and `request` are required unless `workflow` is given (checked by the bridge, which
    // also refuses to mix the two shapes; no refinement here so the schema stays extendable).
    taskKind: z.string().min(1).max(64).regex(SLUG).optional(),
    request: z.string().min(1).max(maxRequestChars).optional(),
    /**
     * Run a named workflow instead of a free-form request. Values are untrusted data for the
     * workflow's prompt template; they never choose the project, directory or permissions.
     */
    workflow: z
      .strictObject({
        id: z.string().min(1).max(64).regex(SLUG),
        inputs: z.record(
          z.string().regex(WORKFLOW_INPUT_NAME),
          z.union([z.string().max(maxRequestChars), z.array(z.string().max(10_000)).max(200)]),
        ),
      })
      .optional(),
    systemPrompt: z.string().max(20_000).optional(),
    constraints: z
      .strictObject({
        capabilities: z.array(z.string().regex(SLUG)).max(16).optional(),
        privacy: z.enum(['standard', 'local-only']).optional(),
        preferredResourceIds: z.array(ResourceIdField).optional(),
        excludedResourceIds: z.array(ResourceIdField).optional(),
        maxCostUsd: z.number().min(0).optional(),
      })
      .optional(),
    // Relative to the project's first working directory, or absolute. Never checked here: the
    // engine canonicalizes it against the project and rejects anything outside.
    workingDirectory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0'), { message: 'must not contain NUL' })
      .optional(),
    documentSets: z.array(z.string().min(1).max(128)).max(8).optional(),
    output: z
      .strictObject({
        filename: z.string().min(1).max(100),
        mediaType: z.enum(['text/markdown', 'text/plain']).optional(),
      })
      .optional(),
    requestedBy: z.string().max(128).optional(),
  });
}

/** Request schema with default limits. */
export const WorkRequestSchema = createWorkRequestSchema();

/** A validated Work Bridge request. */
export type WorkRequest = z.infer<typeof WorkRequestSchema>;

/** JSON Schema of {@link WorkRequestSchema}, e.g. for an MCP tool definition. */
export function workRequestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(WorkRequestSchema);
}

export interface WorkResponseError {
  readonly code: NexarErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

export interface WorkResponseRoute {
  /** Absent when nothing was eligible. */
  readonly resourceId?: string;
  readonly policy?: string;
  /** Selected: the reasons behind the choice. No eligible resource: why each candidate was rejected. */
  readonly reasonCodes: readonly string[];
  /** Human-readable routing explanation. */
  readonly explanation: string;
}

/** What the bridge returns for every submission; `submit` and `status` never throw. */
export interface WorkResponse {
  readonly version: typeof WORK_BRIDGE_VERSION;
  /** Null only when the request was too malformed to read one. */
  readonly requestId: string | null;
  /**
   * `completed`: finished. `running`: still executing, poll `status`. `rejected`: invalid or
   * unauthorized input, nothing ran. `failed`: routed or ran, and failed.
   */
  readonly status: 'completed' | 'running' | 'failed' | 'rejected';
  readonly taskId?: string;
  readonly output?: { readonly text: string };
  readonly route?: WorkResponseRoute;
  readonly usage?: {
    readonly inputTokens: Measured<number>;
    readonly outputTokens: Measured<number>;
    readonly costUsd: Measured<number>;
  };
  readonly artifacts?: readonly ArtifactRef[];
  /** Present for workflow requests. `outputsSplit: false`: the markers were missing, see `artifacts`. */
  readonly workflow?: { readonly id: string; readonly outputsSplit: boolean };
  readonly error?: WorkResponseError;
}
