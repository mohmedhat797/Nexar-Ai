/** Severity levels for Nexar logs. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured context attached to a log line; must never contain secrets. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Minimal logging port so packages stay independent of any logging library. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}
