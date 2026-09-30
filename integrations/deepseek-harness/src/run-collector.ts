import { NexarError, emptyUsage, measured, unavailable } from '@nexar/contracts';
import type { ExecutionEvent, UsageReport } from '@nexar/contracts';
import type { JsonRpcNotification } from './json-rpc-client.js';

const RECEIPT_EVENT = 'agent/inbox/spliced';
const ERROR_SUMMARY_MAX = 300;

/** Mirrors upstream `HarnessSession.run`: ignore events until our prompt's receipt, then collect until idle. */
export class RunCollector {
  private readonly events: Record<string, unknown>[] = [];
  private readonly buffered: JsonRpcNotification[] = [];
  private messageId: string | undefined;
  private receipted = false;
  private finished = false;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ExecutionEvent) => void = () => undefined,
  ) {}

  get done(): boolean {
    return this.finished;
  }

  /** Resolves once the session went idle after our receipt. */
  whenDone(): Promise<void> {
    if (this.finished) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Receipt may arrive before the `session/prompt` response; hold notifications until the id is known. */
  push(notification: JsonRpcNotification): void {
    if (this.finished) return;
    if (this.messageId === undefined) {
      this.buffered.push(notification);
      return;
    }
    this.handle(notification);
  }

  setMessageId(messageId: string): void {
    this.messageId = messageId;
    for (const notification of this.buffered.splice(0)) {
      this.handle(notification);
    }
  }

  snapshot(): CollectedRun {
    return { events: [...this.events] };
  }

  private handle(notification: JsonRpcNotification): void {
    if (this.finished) return;
    const params = asRecord(notification.params);
    if (params === undefined || params.sessionId !== this.sessionId) return;

    if (notification.method === 'session.status') {
      if (this.receipted && params.status === 'idle') {
        this.finished = true;
        for (const wake of this.waiters.splice(0)) wake();
      }
      return;
    }
    if (notification.method !== 'session.event') return;

    const event = asRecord(params.event);
    if (event === undefined || typeof event.type !== 'string') return;

    if (!this.receipted) {
      if (event.type === RECEIPT_EVENT && this.insertsMessage(event)) this.receipted = true;
      return;
    }
    this.events.push(event);
    this.emitToolCall(event);
  }

  private insertsMessage(event: Record<string, unknown>): boolean {
    const inserted = asRecord(event.data)?.inserted;
    return (
      Array.isArray(inserted) && inserted.some((item) => asRecord(item)?.id === this.messageId)
    );
  }

  private emitToolCall(event: Record<string, unknown>): void {
    const type = event.type as string;
    const name = asRecord(event.data)?.name;
    if (type.includes('tool') && typeof name === 'string') {
      try {
        this.emit({ type: 'tool-call', name });
      } catch {
        // A faulty progress listener must not break the run.
      }
    }
  }
}

export interface CollectedRun {
  readonly events: readonly Record<string, unknown>[];
}

export interface InterpretedRun {
  readonly text: string;
  readonly usage: UsageReport;
  /** Set when output was cut off by the token limit but text was still produced. */
  readonly truncated: boolean;
}

/** Turns collected events into text + usage, or throws the `NexarError` the turn outcome demands. */
export function interpretRun(run: CollectedRun): InterpretedRun {
  const text = finalText(run.events);
  const usage = sumUsage(run.events);
  const turnEnd = lastTurnEnd(run.events);

  if (turnEnd === undefined) {
    if (text.length > 0) return { text, usage, truncated: false };
    throw new NexarError('PROVIDER_ERROR', 'dsh went idle without producing a response');
  }

  switch (turnEnd.kind) {
    case 'completed':
      return { text, usage, truncated: false };
    case 'max-tokens':
      if (text.length > 0) return { text, usage, truncated: true };
      throw new NexarError('PROVIDER_ERROR', 'dsh hit the token limit before producing text', {
        details: { turnEnd: 'max-tokens' },
      });
    case 'error': {
      const summary = turnEnd.error === undefined ? 'unknown error' : turnEnd.error;
      throw new NexarError(
        isAuthFailureText(summary) ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
        `dsh turn failed: ${summary}`,
        { details: { turnEnd: 'error' } },
      );
    }
    default:
      throw new NexarError('PROVIDER_ERROR', `dsh turn ended with '${turnEnd.kind}'`, {
        details: { turnEnd: turnEnd.kind },
      });
  }
}

/** Whether runtime output indicates a missing or rejected credential. */
export function isAuthFailureText(text: string): boolean {
  return /api key|apikeyenv|\b401\b|unauthorized/i.test(text);
}

function finalText(events: readonly Record<string, unknown>[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'assistant/message') continue;
    const content = asRecord(asRecord(event.data)?.message)?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => {
        const b = asRecord(block);
        return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
      })
      .join('');
  }
  return '';
}

function sumUsage(events: readonly Record<string, unknown>[]): UsageReport {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const seen = {
    inputTokens: false,
    outputTokens: false,
    cacheReadTokens: false,
    cacheWriteTokens: false,
  };
  let any = false;

  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = asRecord(asRecord(event.data)?.usage);
    if (usage === undefined) continue;
    any = true;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] += value;
        seen[key] = true;
      }
    }
  }
  if (!any) return emptyUsage('not reported by dsh');

  const reason = 'not reported by dsh';
  return {
    inputTokens: seen.inputTokens ? measured(totals.inputTokens) : unavailable(reason),
    outputTokens: seen.outputTokens ? measured(totals.outputTokens) : unavailable(reason),
    ...(seen.cacheReadTokens ? { cacheReadTokens: measured(totals.cacheReadTokens) } : {}),
    ...(seen.cacheWriteTokens ? { cacheWriteTokens: measured(totals.cacheWriteTokens) } : {}),
    costUsd: unavailable('dsh does not report cost'),
  };
}

function lastTurnEnd(
  events: readonly Record<string, unknown>[],
): { kind: string; error?: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'turn/end') continue;
    const reason = asRecord(asRecord(event.data)?.reason);
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown';
    const error = reason?.error === undefined ? undefined : summarize(reason.error);
    return error === undefined ? { kind } : { kind, error };
  }
  return undefined;
}

function summarize(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof asRecord(value)?.message === 'string') {
    text = asRecord(value)?.message as string;
  } else {
    text = JSON.stringify(value) ?? String(value);
  }
  return text.length > ERROR_SUMMARY_MAX ? `${text.slice(0, ERROR_SUMMARY_MAX)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
