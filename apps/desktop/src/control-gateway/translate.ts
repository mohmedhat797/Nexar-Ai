import { z } from 'zod';

/*
 * OpenAI Chat Completions <-> the bridge `control` op (ADR-027 section 7A). Pure functions; the only
 * shapes this module knows are those two. Extras stay server-side: they are neither sent nor returned.
 */

export const MODEL_ID = 'nexar-control';

/** A request the translator answers itself, with a fixed, content-free error body. */
export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
  ) {
    super(code);
  }
}

const invalid = (code: string): HttpFailure => new HttpFailure(400, 'invalid_request_error', code);

const Content = z
  .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))])
  .nullable()
  .optional();

const ChatRequest = z.object({
  model: z.string(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
        content: Content,
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional(),
        tool_call_id: z.string().optional(),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).nullable().optional(),
});

export interface ControlTurnBody {
  readonly messages: readonly Record<string, unknown>[];
  readonly tools?: readonly Record<string, unknown>[];
  readonly settings?: { readonly maxOutputTokens: number };
}

export interface ParsedChat {
  readonly turn: ControlTurnBody;
  readonly stream: boolean;
  readonly includeUsage: boolean;
}

function textOf(content: z.infer<typeof Content>): string | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type !== 'text' || part.text === undefined) throw invalid('unsupported_content');
    text += part.text;
  }
  return text;
}

function parseArguments(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw invalid('invalid_tool_arguments');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('invalid_tool_arguments');
  }
  return value as Record<string, unknown>;
}

/** The request body to a bridge turn; the model must be `nexar-control` (checked first, as a 404). */
export function parseChatRequest(raw: unknown): ParsedChat {
  const parsed = ChatRequest.safeParse(raw);
  if (!parsed.success) throw invalid('invalid_request');
  const body = parsed.data;
  if (body.model !== MODEL_ID)
    throw new HttpFailure(404, 'invalid_request_error', 'model_not_found');
  const messages = body.messages.map((m) => {
    const content = textOf(m.content);
    return {
      role: m.role === 'developer' ? 'system' : m.role,
      ...(content === undefined ? {} : { content }),
      ...(m.tool_calls === undefined || m.tool_calls.length === 0
        ? {}
        : {
            toolCalls: m.tool_calls.map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: parseArguments(c.function.arguments),
            })),
          }),
      ...(m.tool_call_id === undefined ? {} : { toolCallId: m.tool_call_id }),
    };
  });
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens ?? undefined;
  return {
    turn: {
      messages,
      ...(body.tools === undefined
        ? {}
        : {
            tools: body.tools.map((t) => ({
              name: t.function.name,
              ...(t.function.description === undefined
                ? {}
                : { description: t.function.description }),
              parameters: t.function.parameters ?? { type: 'object', properties: {} },
            })),
          }),
      ...(maxOutputTokens === undefined ? {} : { settings: { maxOutputTokens } }),
    },
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
  };
}

// --- response -------------------------------------------------------------------------------------

type Count = { status: string; value?: unknown };
const TurnResult = z.object({
  text: z.string().optional(),
  toolCalls: z.array(
    z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  ),
  finishReason: z.enum(['stop', 'tool-calls', 'length', 'error']),
  usage: z.object({
    inputTokens: z.object({ status: z.string(), value: z.number().optional() }),
    outputTokens: z.object({ status: z.string(), value: z.number().optional() }),
  }),
});

export interface Completion {
  readonly text: string | undefined;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length';
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

const known = (c: Count): c is { status: string; value: number } =>
  (c.status === 'measured' || c.status === 'estimated') && typeof c.value === 'number';

/** A bridge `ControlTurnResult` as a completion; usage only when both counts are known. */
export function toCompletion(value: unknown): Completion {
  const parsed = TurnResult.safeParse(value);
  if (!parsed.success || parsed.data.finishReason === 'error') {
    throw new HttpFailure(502, 'upstream_error', 'provider_error');
  }
  const { text, toolCalls, finishReason, usage } = parsed.data;
  const { inputTokens, outputTokens } = usage;
  return {
    text,
    toolCalls: toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    })),
    finishReason:
      toolCalls.length > 0 ? 'tool_calls' : finishReason === 'length' ? 'length' : 'stop',
    ...(known(inputTokens) && known(outputTokens)
      ? {
          usage: {
            prompt_tokens: inputTokens.value,
            completion_tokens: outputTokens.value,
            total_tokens: inputTokens.value + outputTokens.value,
          },
        }
      : {}),
  };
}

export function completionBody(id: string, created: number, c: Completion): unknown {
  return {
    id,
    object: 'chat.completion',
    created,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: c.text ?? null,
          ...(c.toolCalls.length === 0 ? {} : { tool_calls: c.toolCalls }),
        },
        finish_reason: c.finishReason,
      },
    ],
    ...(c.usage === undefined ? {} : { usage: c.usage }),
  };
}

/** The chunks of one streamed completion, in order, before `[DONE]`. */
export function completionChunks(
  id: string,
  created: number,
  c: Completion,
  includeUsage: boolean,
): readonly unknown[] {
  const chunk = (delta: unknown, finish: string | null, extra: object = {}): unknown => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const chunks: unknown[] = [chunk({ role: 'assistant', content: c.text ?? '' }, null)];
  if (c.toolCalls.length > 0) {
    chunks.push(chunk({ tool_calls: c.toolCalls.map((t, index) => ({ index, ...t })) }, null));
  }
  chunks.push(chunk({}, c.finishReason));
  if (includeUsage && c.usage !== undefined) {
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL_ID,
      choices: [],
      usage: c.usage,
    });
  }
  return chunks;
}

// --- errors ---------------------------------------------------------------------------------------

const MESSAGES: Record<string, string> = {
  authentication_error: 'Authentication failed.',
  permission_error: 'The request is not permitted.',
  invalid_request_error: 'The request is not valid.',
  upstream_error: 'The model could not be reached.',
  timeout_error: 'The model turn timed out.',
  rate_limit_error: 'Too many requests.',
};

/** Host code -> status and OpenAI error type; unknown codes are an upstream failure. */
export function failureForCode(code: string): HttpFailure {
  switch (code) {
    case 'AUTH_REQUIRED':
      return new HttpFailure(401, 'authentication_error', 'invalid_api_key');
    case 'POLICY_REJECTED':
      return new HttpFailure(403, 'permission_error', 'policy_rejected');
    case 'VALIDATION_ERROR':
      return new HttpFailure(400, 'invalid_request_error', 'invalid_request');
    case 'EXECUTION_TIMEOUT':
      return new HttpFailure(504, 'timeout_error', 'timeout');
    case 'NO_ELIGIBLE_RESOURCE':
    case 'PROVIDER_ERROR':
    case 'RESOURCE_UNAVAILABLE':
    case 'INTEGRATION_UNAVAILABLE':
      return new HttpFailure(502, 'upstream_error', code.toLowerCase());
    default:
      return new HttpFailure(502, 'upstream_error', 'upstream_failure');
  }
}

export function errorBody(failure: HttpFailure): unknown {
  return {
    error: {
      type: failure.type,
      code: failure.code,
      message: MESSAGES[failure.type] ?? 'The request failed.',
    },
  };
}
