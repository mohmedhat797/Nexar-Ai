import { measured, unavailable } from '@nexar/contracts';
import type { ExecutionEvent, Measured, NexarErrorCode, UsageReport } from '@nexar/contracts';

/** Raw counters from the last `turn.completed.usage`; absent fields are undefined. */
export interface CodexUsageCounters {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface ParsedCodexRun {
  readonly threadId?: string;
  /** Text of the last completed `agent_message` item. */
  readonly text?: string;
  readonly usage?: CodexUsageCounters;
  /** Number of `turn.completed` events. */
  readonly turns: number;
  /** Message of a `turn.failed`/`error` not followed by a successful `turn.completed`. */
  readonly failure?: string;
  /** True once at least one recognized Codex event was seen. */
  readonly sawEvents: boolean;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function counters(v: unknown): CodexUsageCounters | undefined {
  if (!isRecord(v)) return undefined;
  const out: { -readonly [K in keyof CodexUsageCounters]: CodexUsageCounters[K] } = {};
  const input = num(v['input_tokens']);
  if (input !== undefined) out.inputTokens = input;
  const cached = num(v['cached_input_tokens']);
  if (cached !== undefined) out.cachedInputTokens = cached;
  const write = num(v['cache_write_input_tokens']);
  if (write !== undefined) out.cacheWriteTokens = write;
  const output = num(v['output_tokens']);
  if (output !== undefined) out.outputTokens = output;
  const reasoning = num(v['reasoning_output_tokens']);
  if (reasoning !== undefined) out.reasoningOutputTokens = reasoning;
  return out;
}

/** Incrementally folds `codex exec --json` stdout lines into a result. Pure: no I/O. */
export class CodexStreamParser {
  private threadId: string | undefined;
  private text: string | undefined;
  private usage: CodexUsageCounters | undefined;
  private turns = 0;
  private failure: string | undefined;
  private sawEvents = false;

  /** Consumes one stdout line; non-JSON and unrecognized lines are ignored. Returns progress events. */
  push(line: string): ExecutionEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isRecord(event)) return [];

    switch (event['type']) {
      case 'thread.started':
        this.sawEvents = true;
        this.threadId = str(event['thread_id']);
        return [];
      case 'turn.started':
        this.sawEvents = true;
        return [];
      case 'turn.completed':
        this.sawEvents = true;
        this.turns += 1;
        this.usage = counters(event['usage']);
        // A completed turn supersedes earlier errors (e.g. `Reconnecting... 1/5`).
        this.failure = undefined;
        return [];
      case 'turn.failed': {
        this.sawEvents = true;
        const error = event['error'];
        this.failure = (isRecord(error) ? str(error['message']) : undefined) ?? 'turn failed';
        return [];
      }
      case 'error':
        this.sawEvents = true;
        this.failure = str(event['message']) ?? 'error';
        return [];
      case 'item.completed':
        this.sawEvents = true;
        return this.item(event['item']);
      case 'item.started':
      case 'item.updated':
        this.sawEvents = true;
        return [];
      default:
        return [];
    }
  }

  result(): ParsedCodexRun {
    return {
      turns: this.turns,
      sawEvents: this.sawEvents,
      ...(this.threadId !== undefined ? { threadId: this.threadId } : {}),
      ...(this.text !== undefined ? { text: this.text } : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
    };
  }

  private item(item: unknown): ExecutionEvent[] {
    if (!isRecord(item)) return [];
    switch (item['type']) {
      case 'agent_message': {
        const text = str(item['text']);
        if (text !== undefined) this.text = text;
        return [{ type: 'status', message: 'agent message' }];
      }
      case 'command_execution':
        // Deliberately no command text: it can carry user content.
        return [{ type: 'tool-call', name: 'shell' }];
      case 'file_change': {
        const changes = item['changes'];
        const n = Array.isArray(changes) ? changes.length : 0;
        return [{ type: 'tool-call', name: 'edit', detail: `${n} files` }];
      }
      default:
        return [];
    }
  }
}

/** Parses a whole stdout capture; convenience over {@link CodexStreamParser}. */
export function parseCodexStream(lines: Iterable<string>): ParsedCodexRun {
  const parser = new CodexStreamParser();
  for (const line of lines) parser.push(line);
  return parser.result();
}

const NOT_REPORTED = 'not reported by codex';
const SUBSCRIPTION = 'subscription; not reported by codex';

function reported(n: number | undefined): Measured<number> {
  return n === undefined ? unavailable(NOT_REPORTED) : measured(n);
}

/**
 * Maps the last `turn.completed.usage` to a {@link UsageReport}. Codex emits all-zero usage when
 * it does not know the real figures, so "no usage, or every field 0/missing" is `unavailable`,
 * never a measured 0. Reasoning tokens are added to output tokens (Codex reports them separately;
 * they are billed and counted as output).
 */
export function toUsage(run: ParsedCodexRun): UsageReport {
  const u = run.usage;
  const total =
    (u?.inputTokens ?? 0) +
    (u?.cachedInputTokens ?? 0) +
    (u?.cacheWriteTokens ?? 0) +
    (u?.outputTokens ?? 0) +
    (u?.reasoningOutputTokens ?? 0);
  const turns = run.turns > 0 ? measured(run.turns) : unavailable<number>(NOT_REPORTED);
  if (u === undefined || total === 0) {
    return {
      inputTokens: unavailable(NOT_REPORTED),
      outputTokens: unavailable(NOT_REPORTED),
      costUsd: unavailable(SUBSCRIPTION),
      turns,
    };
  }
  const output =
    u.outputTokens === undefined && u.reasoningOutputTokens === undefined
      ? undefined
      : (u.outputTokens ?? 0) + (u.reasoningOutputTokens ?? 0);
  return {
    inputTokens: reported(u.inputTokens),
    outputTokens: reported(output),
    cacheReadTokens: reported(u.cachedInputTokens),
    cacheWriteTokens: reported(u.cacheWriteTokens),
    costUsd: unavailable(SUBSCRIPTION),
    turns,
  };
}

const AUTH_FAILURE = /401|unauthori[sz]ed|not logged in|login|auth/i;
const QUOTA_FAILURE = /429|rate limit|usage limit|quota/i;

/** Classifies a failure message into a Nexar error code. Auth is checked first. */
export function classifyFailure(message: string): NexarErrorCode {
  if (AUTH_FAILURE.test(message)) return 'AUTH_REQUIRED';
  if (QUOTA_FAILURE.test(message)) return 'QUOTA_EXHAUSTED';
  return 'PROVIDER_ERROR';
}
