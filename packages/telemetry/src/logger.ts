import type { LogFields, Logger, LogLevel } from '@nexar/contracts';
import { redact } from './redact.js';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  /** Minimum level to emit; default 'info'. */
  readonly level?: LogLevel;
  /** Line sink; default writes to stderr (stdout is reserved for command output). */
  readonly write?: (line: string) => void;
  readonly bindings?: LogFields;
  readonly clock?: () => Date;
}

/** Logger writing one redacted JSON object per line. */
export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => void process.stderr.write(line + '\n'));
  const clock = options.clock ?? (() => new Date());

  const build = (bindings: LogFields): Logger => {
    const log = (at: LogLevel, msg: string, fields?: LogFields): void => {
      if (RANK[at] < RANK[level]) return;
      const entry = redact({ time: clock().toISOString(), level: at, msg, ...bindings, ...fields });
      write(JSON.stringify(entry));
    };
    return {
      debug: (msg, fields) => log('debug', msg, fields),
      info: (msg, fields) => log('info', msg, fields),
      warn: (msg, fields) => log('warn', msg, fields),
      error: (msg, fields) => log('error', msg, fields),
      child: (extra) => build({ ...bindings, ...extra }),
    };
  };

  return build(options.bindings ?? {});
}

const noop = (): void => undefined;

/** Logger that discards everything. */
export const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => noopLogger,
};
