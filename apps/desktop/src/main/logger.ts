import type { LogFields, Logger } from '@nexar/contracts';

const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|authorization|cookie|credential|prompt)/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function redact(fields: LogFields | undefined): LogFields {
  if (fields === undefined) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) && !/tokens$/i.test(key) ? '[REDACTED]' : value,
    ]),
  );
}

/** JSON lines on stderr (never stdout), keys that could hold secrets or prompts masked. */
export function createStderrLogger(
  level: keyof typeof LEVELS = 'warn',
  bindings: LogFields = {},
  write: (line: string) => void = (line) => void process.stderr.write(line),
): Logger {
  const emit = (name: keyof typeof LEVELS, msg: string, fields?: LogFields): void => {
    if (LEVELS[name] < LEVELS[level]) return;
    write(
      JSON.stringify({
        level: name,
        time: new Date().toISOString(),
        msg,
        ...redact(bindings),
        ...redact(fields),
      }) + '\n',
    );
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (more) => createStderrLogger(level, { ...bindings, ...more }, write),
  };
}
