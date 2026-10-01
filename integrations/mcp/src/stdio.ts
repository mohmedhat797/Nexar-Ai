/* eslint-disable no-console -- this module exists to keep console output off the protocol channel */
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNexarMcpServer, type NexarMcpDeps } from './server.js';

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn';
const REDIRECTED: readonly ConsoleMethod[] = ['log', 'info', 'debug', 'warn'];

/**
 * Stdout carries only protocol frames; one stray `console.log` would corrupt the channel. This sends
 * the console methods that would reach stdout (and `warn`, for symmetry) to stderr. Defense in depth:
 * Nexar's own code never logs to stdout. Returns a function that restores the originals.
 */
export function redirectConsoleToStderr(): () => void {
  // The originals are put back as they were, never called unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originals = REDIRECTED.map((method) => [method, console[method]] as const);
  const toStderr = (...args: unknown[]): void => console.error(...args);
  for (const method of REDIRECTED) console[method] = toStderr;
  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}

export interface NexarStdioOptions {
  /** Default `process.stdin`. */
  readonly input?: Readable;
  /** Default `process.stdout`. */
  readonly output?: Writable;
}

export interface NexarStdioHandle {
  /** Resolves when the client closes its end (stdin EOF) or `close()` is called. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Serves Nexar over stdio until stdin ends. stdio is the only transport: there is deliberately no
 * HTTP or socket option here (authentication is one token per launching process).
 */
export function serveNexarStdio(
  deps: NexarMcpDeps,
  options: NexarStdioOptions = {},
): NexarStdioHandle {
  const restoreConsole = redirectConsoleToStderr();
  const input = options.input ?? process.stdin;
  const transport = new StdioServerTransport(input, options.output ?? process.stdout);

  const handle = serveStdio(createNexarMcpServer(deps), {
    transport,
    onerror: (error) => deps.logger.error('mcp transport error', { error: error.message }),
  });

  const closed = new Promise<void>((resolve) => {
    const done = (): void => {
      input.off('end', done);
      input.off('close', done);
      resolve();
    };
    input.once('end', done);
    input.once('close', done);
  });
  return {
    closed,
    async close() {
      try {
        await handle.close();
      } finally {
        restoreConsole();
      }
    },
  };
}
