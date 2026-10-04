import type { ControlEngine } from './connection.js';
import { NexarError } from './errors.js';
import type { Measured } from './measured.js';
import type { ResourceDescriptor } from './resource.js';

/** A tool call requested by the model; the engine executes it, never Nexar. */
export interface ModelTurnToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A provider-neutral, engine-canonical message (ADR-027 §7A). */
export interface ModelTurnMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string;
  readonly toolCalls?: readonly ModelTurnToolCall[];
  readonly toolCallId?: string;
  /** Opaque provider-private fields returned by a turn; only valid on the same decision. */
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** A tool the model may call; `parameters` is a JSON schema. */
export interface ModelTurnTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Request lineage (ADR-024); ids only. */
export interface ControlLineage {
  readonly rootSessionId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly depth: number;
}

export interface ControlTurnSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface ControlTurnRequest {
  readonly lineage: ControlLineage;
  readonly engine: ControlEngine;
  readonly controlDecisionId: string;
  readonly messages: readonly ModelTurnMessage[];
  readonly tools?: readonly ModelTurnTool[];
  readonly settings?: ControlTurnSettings;
}

export interface ControlTurnResult {
  readonly text?: string;
  readonly toolCalls: readonly ModelTurnToolCall[];
  readonly finishReason: 'stop' | 'tool-calls' | 'length' | 'error';
  readonly usage: {
    readonly inputTokens: Measured<number>;
    readonly outputTokens: Measured<number>;
  };
  readonly extras?: Readonly<Record<string, unknown>>;
  readonly resourceId: string;
}

/** What a model-turn port is asked to do; credentials are resolved inside the port. */
export interface ModelTurnPortRequest {
  readonly descriptor: ResourceDescriptor;
  readonly messages: readonly ModelTurnMessage[];
  readonly tools?: readonly ModelTurnTool[];
  readonly settings?: ControlTurnSettings;
  readonly signal: AbortSignal;
  readonly onDelta?: (text: string) => void;
}

/** One model turn on one resource. Tool calls are returned, never executed. */
export interface ModelTurnPort {
  turn(request: ModelTurnPortRequest): Promise<Omit<ControlTurnResult, 'resourceId'>>;
}

/** Which control resource drives an engine turn. */
export interface ControlResourcePolicy {
  readonly mode: 'auto' | 'pinned';
  readonly resourceId?: string;
  readonly fallback: 'auto' | 'none';
}

export const DEFAULT_CONTROL_RESOURCE_POLICY: ControlResourcePolicy = {
  mode: 'auto',
  fallback: 'auto',
};

/** The control resource chosen (and pinned) for one engine turn. */
export interface ControlDecision {
  readonly controlDecisionId: string;
  readonly engine: ControlEngine;
  readonly resourceId: string;
  readonly alternatives: readonly string[];
  readonly decidedAt: string;
  readonly reasonCodes: readonly string[];
}

export const CONTROL_TURN_LIMITS = {
  maxMessages: 512,
  maxTools: 128,
  maxContentBytes: 512 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  maxExtrasBytes: 64 * 1024,
} as const;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const ROLES: readonly string[] = ['system', 'user', 'assistant', 'tool'];

function invalid(message: string): NexarError {
  return new NexarError('VALIDATION_ERROR', message);
}

/** Plain boolean check (no type narrowing) for values that may arrive untyped over a transport. */
function isList(value: unknown): boolean {
  return Array.isArray(value);
}

/** UTF-8 byte length without a runtime dependency (this package has none). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function sizeOf(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw invalid('Request contains a value that cannot be serialized');
  }
  return json === undefined ? 0 : utf8Length(json);
}

/** Size of serialized provider-private extras; rejects values over the extras bound. */
export function assertExtrasWithinBounds(extras: unknown, what = 'extras'): void {
  if (extras === undefined) return;
  if (typeof extras !== 'object' || extras === null || Array.isArray(extras)) {
    throw invalid(`${what} must be an object`);
  }
  if (sizeOf(extras) > CONTROL_TURN_LIMITS.maxExtrasBytes) {
    throw invalid(`${what} exceed ${String(CONTROL_TURN_LIMITS.maxExtrasBytes)} bytes`);
  }
}

/** Validates the bounds of a turn request. Messages are never echoed in the error. */
export function validateControlTurnRequest(request: ControlTurnRequest): void {
  const { messages, tools } = request;
  if (!isList(messages) || messages.length === 0) {
    throw invalid('A turn needs at least one message');
  }
  if (messages.length > CONTROL_TURN_LIMITS.maxMessages) {
    throw invalid(`A turn allows at most ${String(CONTROL_TURN_LIMITS.maxMessages)} messages`);
  }
  if (tools !== undefined) {
    if (!isList(tools) || tools.length > CONTROL_TURN_LIMITS.maxTools) {
      throw invalid(`A turn allows at most ${String(CONTROL_TURN_LIMITS.maxTools)} tools`);
    }
    const seen = new Set<string>();
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
        throw invalid('Tool names must match ^[A-Za-z0-9_.-]{1,64}$');
      }
      if (seen.has(tool.name)) throw invalid('Tool names must be unique');
      seen.add(tool.name);
      if (typeof tool.parameters !== 'object' || tool.parameters === null) {
        throw invalid('Tool parameters must be a JSON schema object');
      }
    }
  }
  for (const message of messages) {
    if (!ROLES.includes(message.role)) throw invalid('Unknown message role');
    if (message.content !== undefined) {
      if (typeof message.content !== 'string') throw invalid('Message content must be a string');
      if (utf8Length(message.content) > CONTROL_TURN_LIMITS.maxContentBytes) {
        throw invalid(
          `Message content exceeds ${String(CONTROL_TURN_LIMITS.maxContentBytes)} bytes`,
        );
      }
    }
    for (const call of message.toolCalls ?? []) {
      if (typeof call.name !== 'string' || !TOOL_NAME.test(call.name)) {
        throw invalid('Tool call names must match ^[A-Za-z0-9_.-]{1,64}$');
      }
    }
    assertExtrasWithinBounds(message.extras, 'Message extras');
  }
  if (sizeOf({ messages, tools }) > CONTROL_TURN_LIMITS.maxRequestBytes) {
    throw invalid(`A turn request exceeds ${String(CONTROL_TURN_LIMITS.maxRequestBytes)} bytes`);
  }
}
