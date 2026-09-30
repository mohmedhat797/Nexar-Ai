import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExecutionRecord, TelemetryEvent, TelemetrySink } from '@nexar/contracts';

/** Keeps events in memory; intended for tests and short-lived processes. */
export class InMemoryTelemetrySink implements TelemetrySink {
  private readonly store: TelemetryEvent[] = [];

  get events(): readonly TelemetryEvent[] {
    return this.store;
  }

  emit(event: TelemetryEvent): void {
    this.store.push(event);
  }

  /** Execution records from every `execution.finished` event, in emission order. */
  records(): ExecutionRecord[] {
    return this.store.flatMap((e) => (e.type === 'execution.finished' ? [e.record] : []));
  }
}

/** Appends one JSON line per event; writes are serialized so lines never interleave. */
export class JsonlFileTelemetrySink implements TelemetrySink {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  emit(event: TelemetryEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    const result = this.tail.then(() => this.append(line));
    // Keep the chain alive after a failure; the caller still sees the rejection via `result`.
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async append(line: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, line, { mode: 0o600 });
    // `mode` applies only on creation and is subject to umask; enforce it.
    await chmod(this.filePath, 0o600);
  }
}

/** Fans events out to several sinks; one failing sink never blocks the others. */
export class CompositeTelemetrySink implements TelemetrySink {
  constructor(
    private readonly sinks: readonly TelemetrySink[],
    private readonly onError?: (error: unknown, sink: TelemetrySink) => void,
  ) {}

  async emit(event: TelemetryEvent): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.emit(event);
        } catch (error) {
          this.onError?.(error, sink);
        }
      }),
    );
  }
}
