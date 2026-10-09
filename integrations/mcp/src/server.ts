import { randomUUID } from 'node:crypto';
import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  authorize,
  effectiveMaxCost,
  withAudit,
  type AuditHandle,
  type AuditLog,
  type ClientIdentity,
  type ClientRegistry,
} from '@nexar/access';
import { NexarError, isNexarError, type Logger, type NexarErrorCode } from '@nexar/contracts';
import { WorkRequestSchema, type WorkBridge, type WorkResponse } from '@nexar/work-bridge';
import type { RouteSummary, SafeResource } from './safe.js';

export const AUDIT_ORIGIN = 'mcp-stdio';

const SLUG = /^[a-z][a-z0-9-]*$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_WAIT_SECONDS = 100;

/** What `nexar.route` asks the router; the request text is optional and never used to choose. */
export interface RouteInput {
  readonly project: string;
  readonly taskKind: string;
  readonly capabilities: readonly string[];
  readonly request?: string;
  readonly maxCostUsd?: number;
}

/** What `nexar.workflows` shows of a workflow; the runner's `LoadedWorkflow` satisfies it. */
export interface WorkflowListing {
  readonly summary: {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly taskKind: string;
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
  };
}

export interface NexarMcpDeps {
  readonly bridge: Pick<WorkBridge, 'submit' | 'status'>;
  readonly router: { route(input: RouteInput): Promise<RouteSummary> };
  readonly resources: { list(): Promise<readonly SafeResource[]> };
  /** The workflow catalog; without it `nexar.workflows` lists nothing. */
  readonly workflows?: { list(projectId?: string): readonly WorkflowListing[] };
  readonly clients: Pick<ClientRegistry, 'reload' | 'authenticate'>;
  readonly audit: AuditLog;
  /** `NEXAR_CLIENT_TOKEN`, read once by the launcher. Undefined means every call fails authentication. */
  readonly token: string | undefined;
  readonly logger: Logger;
  readonly version: string;
  /** The `source` stamped on work submitted through this server. Default `'mcp'`. */
  readonly source?: string;
  /** Lifetime signal for background jobs (aborted when the server shuts down), not a per-call one. */
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

// --- input schemas (advertised in tools/list; the handlers validate for themselves) -------------

const SubmitWorkInput = WorkRequestSchema.partial({ version: true, source: true }).extend({
  waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
});
const WorkStatusInput = z.strictObject({ requestId: z.string().regex(REQUEST_ID) });
const RouteToolInput = z.strictObject({
  project: z.string().min(1).max(128),
  taskKind: z.string().min(1).max(64).regex(SLUG),
  capabilities: z.array(z.string().regex(SLUG)).max(16).optional(),
  request: z.string().min(1).max(100_000).optional(),
});
const ResourcesInput = z.strictObject({});
const WorkflowsInput = z.strictObject({ project: z.string().min(1).max(128).optional() });

/**
 * The schema the SDK advertises and the handler uses. The SDK would otherwise validate before our
 * handler runs, so a malformed call would bypass authentication and the audit log. This keeps the
 * JSON Schema of `schema` for `tools/list` but lets every call through to the handler, which
 * authenticates first, then validates, and writes exactly one audit record either way.
 */
export function advertised(schema: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
  const standard = schema['~standard'];
  return {
    '~standard': { ...standard, validate: (value: unknown) => ({ value }) },
  };
}

// --- results -------------------------------------------------------------------------------------

type Payload = Record<string, unknown>;

/** One text block holding the JSON (some MCP clients forward only text) plus the same object structured. */
function result(payload: Payload, isError: boolean): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

const PASS_THROUGH: ReadonlySet<NexarErrorCode> = new Set<NexarErrorCode>([
  'AUTH_REQUIRED',
  'VALIDATION_ERROR',
  'POLICY_REJECTED',
  'NO_ELIGIBLE_RESOURCE',
]);

/** Only Nexar-authored messages of well-understood codes reach the client; the rest are generic. */
function errorResult(thrown: unknown, logger: Logger): CallToolResult {
  const code: NexarErrorCode = isNexarError(thrown) ? thrown.code : 'INTERNAL_ERROR';
  if (isNexarError(thrown) && PASS_THROUGH.has(code)) {
    const issues = thrown.details?.['issues'];
    return result(
      {
        error: {
          code,
          message: thrown.message,
          ...(Array.isArray(issues) ? { issues } : {}),
        },
      },
      true,
    );
  }
  logger.warn('mcp tool call failed', {
    code,
    error: thrown instanceof Error ? thrown.message : String(thrown),
  });
  const message = code === 'CONFIGURATION_ERROR' ? 'Server configuration error' : 'Internal error';
  return result(
    { error: { code: code === 'CONFIGURATION_ERROR' ? code : 'INTERNAL_ERROR', message } },
    true,
  );
}

function validationError(error: z.ZodError): NexarError {
  return new NexarError('VALIDATION_ERROR', 'Invalid arguments', {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    },
  });
}

function parseArguments<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- the server ----------------------------------------------------------------------------------

interface CallContext {
  readonly identity: ClientIdentity;
  readonly audit: AuditHandle;
}

/**
 * The MCP face of Nexar: five tools over stdio, each call authenticated, authorized and audited.
 * Returns a server factory for `serveStdio` (or, in tests, call it and connect the server to any
 * transport).
 *
 * Every call: reload the client registry (so revocation is immediate), authenticate the connection's
 * token, check the tool scope, run the tool. Exactly one audit record is written per call, including
 * authentication and validation failures. Nothing is ever thrown out of a handler.
 */
export function createNexarMcpServer(deps: NexarMcpDeps): () => McpServer {
  const newId = deps.newId ?? randomUUID;
  const source = deps.source ?? 'mcp';

  async function call(
    tool: string,
    raw: unknown,
    body: (ctx: CallContext, args: unknown) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const claimed = isPlainObject(raw) ? raw['requestId'] : undefined;
    const requestId =
      typeof claimed === 'string' && REQUEST_ID.test(claimed) ? claimed : `mcp_${newId()}`;
    try {
      return await withAudit(
        deps.audit,
        {
          requestId,
          tool,
          origin: AUDIT_ORIGIN,
          ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        },
        async (handle) => {
          await deps.clients.reload();
          const identity = deps.clients.authenticate(deps.token);
          handle.setClient(identity.clientId);
          authorize(identity, { tool });
          handle.setPolicy('allowed');
          return body({ identity, audit: handle }, raw);
        },
      );
    } catch (thrown) {
      return errorResult(thrown, deps.logger);
    }
  }

  /** Records what a bridge response says, then renders it. */
  async function respond(handle: AuditHandle, response: WorkResponse): Promise<CallToolResult> {
    handle.setTask({
      ...(response.taskId === undefined ? {} : { taskId: response.taskId }),
      ...(response.route?.resourceId === undefined
        ? {}
        : { resourceId: response.route.resourceId }),
      ...(response.artifacts === undefined ? {} : { artifactCount: response.artifacts.length }),
    });
    if (response.error?.code === 'POLICY_REJECTED') handle.setPolicy('rejected');
    await handle.finish(response.status, response.error?.code);
    return result({ ...response }, response.status === 'rejected' || response.status === 'failed');
  }

  const submitWork = (raw: unknown): Promise<CallToolResult> =>
    call('nexar.submit_work', raw, async ({ identity, audit }, args) => {
      if (!isPlainObject(args)) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid arguments', {
          details: { issues: [{ path: '', message: 'expected an object' }] },
        });
      }
      const { waitSeconds, ...rest } = args;
      const wait = z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().safeParse(waitSeconds);
      if (!wait.success) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid arguments', {
          details: {
            issues: [{ path: 'waitSeconds', message: 'must be an integer from 0 to 100' }],
          },
        });
      }
      // The client's own ceiling always applies; a request can only lower it.
      let input: Record<string, unknown> = { version: 2, source, ...rest };
      const constraints = rest['constraints'];
      const requested = isPlainObject(constraints) ? constraints['maxCostUsd'] : undefined;
      if (
        (constraints === undefined || isPlainObject(constraints)) &&
        (requested === undefined ||
          (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0))
      ) {
        const cap = effectiveMaxCost(identity, requested);
        if (cap !== undefined) {
          input = { ...input, constraints: { ...(constraints ?? {}), maxCostUsd: cap } };
        }
      }
      const response = await deps.bridge.submit(input, {
        clientId: identity.clientId,
        ...(wait.data === undefined ? {} : { waitMs: wait.data * 1000 }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        authorize: (request) => {
          audit.setScope({
            projectId: request.project,
            taskKind: request.taskKind,
            ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
          });
          try {
            authorize(identity, {
              tool: 'nexar.submit_work',
              taskKind: request.taskKind,
              projectId: request.project,
              ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
              ...(request.maxCostUsd === undefined ? {} : { maxCostUsd: request.maxCostUsd }),
            });
          } catch (thrown) {
            audit.setPolicy('rejected');
            throw thrown;
          }
          audit.setPolicy('allowed');
        },
      });
      return respond(audit, response);
    });

  const workStatus = (raw: unknown): Promise<CallToolResult> =>
    call('nexar.work_status', raw, async ({ identity, audit }, args) => {
      const { requestId } = parseArguments(WorkStatusInput, args);
      return respond(audit, deps.bridge.status(requestId, { clientId: identity.clientId }));
    });

  const route = (raw: unknown): Promise<CallToolResult> =>
    call('nexar.route', raw, async ({ identity, audit }, args) => {
      const input = parseArguments(RouteToolInput, args);
      audit.setScope({ projectId: input.project, taskKind: input.taskKind });
      const cap = effectiveMaxCost(identity);
      try {
        authorize(identity, {
          tool: 'nexar.route',
          taskKind: input.taskKind,
          projectId: input.project,
        });
      } catch (thrown) {
        audit.setPolicy('rejected');
        throw thrown;
      }
      const summary = await deps.router.route({
        project: input.project,
        taskKind: input.taskKind,
        capabilities: input.capabilities ?? [],
        ...(input.request === undefined ? {} : { request: input.request }),
        ...(cap === undefined ? {} : { maxCostUsd: cap }),
      });
      audit.setTask({
        ...(summary.selected === undefined ? {} : { resourceId: summary.selected.resourceId }),
      });
      await audit.finish('completed');
      return result({ ...summary }, false);
    });

  const resources = (raw: unknown): Promise<CallToolResult> =>
    call('nexar.resources', raw, async (_ctx, args) => {
      parseArguments(ResourcesInput, args);
      return result({ resources: await deps.resources.list() }, false);
    });

  const workflows = (raw: unknown): Promise<CallToolResult> =>
    call('nexar.workflows', raw, async ({ identity, audit }, args) => {
      const input = parseArguments(WorkflowsInput, args);
      if (input.project !== undefined) {
        audit.setScope({ projectId: input.project });
        try {
          authorize(identity, { tool: 'nexar.workflows', projectId: input.project });
        } catch (thrown) {
          audit.setPolicy('rejected');
          throw thrown;
        }
      }
      // Only workflows this client could actually run: the same scopes `nexar.submit_work` applies.
      const runnable = (deps.workflows?.list(input.project) ?? []).filter(({ summary }) => {
        try {
          authorize(identity, {
            tool: 'nexar.workflows',
            taskKind: summary.taskKind,
            workflowId: summary.id,
            ...(input.project === undefined ? {} : { projectId: input.project }),
          });
          return true;
        } catch {
          return false;
        }
      });
      await audit.finish('completed');
      return result(
        {
          workflows: runnable.map(({ summary }) => ({
            id: summary.id,
            displayName: summary.displayName,
            description: summary.description,
            taskKind: summary.taskKind,
            inputs: summary.inputs,
            outputs: summary.outputs,
          })),
        },
        false,
      );
    });

  return () => {
    const server = new McpServer(
      { name: 'nexar', version: deps.version },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.registerTool(
      'nexar.submit_work',
      {
        title: 'Submit work to Nexar',
        description:
          'Run a task on the best AI resource Nexar can choose, inside a project. Either send ' +
          'request and taskKind, or workflow: { id, inputs } (see nexar.workflows). Returns the result, ' +
          'the routing explanation and any stored artifact. If the work is still running after ' +
          'waitSeconds (default 90), the status is "running": call nexar.work_status with the same ' +
          'requestId until it is completed or failed. Re-submitting the same requestId never starts a ' +
          'second task.',
        inputSchema: advertised(SubmitWorkInput),
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      submitWork,
    );
    server.registerTool(
      'nexar.work_status',
      {
        title: 'Status of submitted work',
        description:
          'Current state (running, completed, failed, rejected) of work submitted with nexar.submit_work, ' +
          'by requestId. Only the client that submitted it can read it.',
        inputSchema: advertised(WorkStatusInput),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      workStatus,
    );
    server.registerTool(
      'nexar.route',
      {
        title: 'Explain routing',
        description:
          'Show which AI resource Nexar would choose for a task kind in a project, with the reasons and ' +
          'the rejected alternatives, without running anything.',
        inputSchema: advertised(RouteToolInput),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      route,
    );
    server.registerTool(
      'nexar.resources',
      {
        title: 'List AI resources',
        description:
          'List the AI resources Nexar can route to, with capabilities, availability and whether they ' +
          'need authentication. Never includes credentials or configuration.',
        inputSchema: advertised(ResourcesInput),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      resources,
    );
    server.registerTool(
      'nexar.workflows',
      {
        title: 'List workflows',
        description:
          'List the workflows this client may run (id, name, task kind, inputs with their types and ' +
          'limits). Run one with nexar.submit_work by passing workflow: { id, inputs } instead of ' +
          'request and taskKind. Input values are treated as untrusted data, never as instructions.',
        inputSchema: advertised(WorkflowsInput),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      workflows,
    );
    return server;
  };
}
