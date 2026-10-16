import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A fake OpenAI-compatible model server on loopback for the Cowork scenarios (ADR-030): the control
 * resource Nexar's gateway pins for a DeepSeek Harness turn. A request that offers tools is a control
 * turn and follows a script (it sees the real tool names DSH offers, `write` and the bridge tools);
 * a request without tools is a delegated unit and is answered with text naming the model.
 */

export interface ModelRequestInfo {
  readonly tools: boolean;
  /** The role of the last message of the history. */
  readonly last: string;
}

export interface FakeModel {
  readonly port: number;
  readonly baseUrl: string;
  readonly completions: ModelRequestInfo[];
  readonly close: () => Promise<void>;
}

export type ControlScript =
  /** Writes one file with the DSH `write` tool, then answers. */
  | {
      readonly kind: 'write';
      readonly file: string;
      readonly content: string;
      readonly final: string;
      /** SEC02: read an explicitly staged input before drafting, retaining its contents. */
      readonly input?: string;
    }
  /** Delegates four units through the bridge (extract, synthesize, draft, review), then writes the draft. */
  | { readonly kind: 'sow' }
  /** Delegates one unit through the bridge, then writes its answer as `draft.md`. */
  | { readonly kind: 'delegate' };

export const DEFAULT_SCRIPT: ControlScript = {
  kind: 'write',
  file: 'proposal.md',
  content: '# Solution proposal\n\nScope, deliverables and dates.\n',
  final: 'Wrote proposal.md.',
};

export const SOW_UNITS = [
  {
    unitId: 'extract',
    kind: 'analysis',
    capabilities: ['knowledge-work'],
    access: 'read-only',
    reviewOf: 'none',
  },
  {
    unitId: 'synthesize',
    kind: 'analysis',
    capabilities: ['reasoning'],
    access: 'read-only',
    reviewOf: 'none',
  },
  {
    unitId: 'draft',
    kind: 'documentation',
    capabilities: ['text-generation'],
    access: 'draft',
    reviewOf: 'none',
  },
  {
    unitId: 'review',
    kind: 'analysis',
    capabilities: ['reasoning'],
    access: 'read-only',
    reviewOf: 'draft',
  },
] as const;

const DELEGATE_UNIT = {
  unitId: 'draft',
  kind: 'documentation',
  capabilities: ['text-generation'],
  access: 'draft',
  reviewOf: 'none',
} as const;

const POLL_DELAY_MS = 150;

interface Message {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly function: { readonly name: string };
  }[];
}

type Action =
  | { readonly call: string; readonly args: Record<string, unknown>; readonly delayMs?: number }
  | { readonly text: string };

const sse = (model: string, delta: object, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/** The first JSON object inside a tool result (the relay answers one text block holding JSON). */
function jsonOf(content: unknown): Record<string, unknown> | undefined {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part as { text?: string }).text ?? '').join('')
        : '';
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return undefined;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function nextAction(
  script: ControlScript,
  messages: readonly Message[],
  tools: readonly string[],
): Action {
  // An exact name first (`write`, not `todo_write`), else the one that contains it (bridge tools
  // carry a server prefix and a hash suffix).
  const named = (part: string): string =>
    tools.find((t) => t === part) ?? tools.find((t) => t.includes(part)) ?? part;
  const callNames = new Map<string, string>();
  for (const m of messages)
    for (const c of m.tool_calls ?? []) callNames.set(c.id, c.function.name);
  const last = messages.at(-1);
  const lastName = last?.role === 'tool' ? callNames.get(last.tool_call_id ?? '') : undefined;

  if (script.kind === 'write') {
    if (script.input !== undefined && lastName !== 'read' && lastName !== 'write')
      return { call: named('read'), args: { file_path: script.input } };
    return last?.role === 'tool' && (script.input === undefined || lastName === 'write')
      ? { text: script.final }
      : {
          call: named('write'),
          args: {
            file_path: script.file,
            content:
              script.content +
              (script.input === undefined
                ? ''
                : `\n\n${typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)}`),
            sandbox_permissions: 'workspace-write',
            justification: 'Write the requested draft in scratch.',
          },
        };
  }

  const units = script.kind === 'sow' ? SOW_UNITS : [DELEGATE_UNIT];
  // Completed units, in order: the text each answered with.
  const done: string[] = [];
  for (const m of messages) {
    if (
      m.role !== 'tool' ||
      !(callNames.get(m.tool_call_id ?? '') ?? '').includes('intelligence_status')
    ) {
      continue;
    }
    const status = jsonOf(m.content);
    const result = status?.['result'] as { text?: unknown } | undefined;
    if (status?.['state'] === 'done')
      done.push(typeof result?.text === 'string' ? result.text : '');
  }
  const submit = (index: number): Action => {
    const unit = units[index] as (typeof units)[number];
    return {
      call: named('intelligence_submit'),
      args: {
        ...unit,
        capabilities: [...unit.capabilities],
        input: `Unit ${unit.unitId}, working from: ${done.at(-1) ?? 'the project documents'}`,
      },
    };
  };

  if (lastName === 'write' || lastName?.endsWith('write') === true) {
    return { text: 'Drafted from the delegated units.' };
  }
  // The job being polled: the latest submit's answer (units run one after the other).
  let jobId: unknown;
  for (const m of messages) {
    if (
      m.role === 'tool' &&
      (callNames.get(m.tool_call_id ?? '') ?? '').includes('intelligence_submit')
    ) {
      jobId = jsonOf(m.content)?.['jobId'] ?? jobId;
    }
  }
  if (lastName?.includes('intelligence_submit') === true) {
    return { call: named('intelligence_status'), args: { jobId }, delayMs: POLL_DELAY_MS };
  }
  if (lastName?.includes('intelligence_status') === true) {
    const status = jsonOf(last?.content);
    if (status?.['state'] !== 'done') {
      return { call: named('intelligence_status'), args: { jobId }, delayMs: POLL_DELAY_MS };
    }
    if (done.length < units.length) return submit(done.length);
    const draftIndex = units.findIndex((u) => u.unitId === 'draft');
    return {
      call: named('write'),
      args: {
        file_path: 'draft.md',
        content: done[draftIndex] ?? done.at(-1) ?? '',
        sandbox_permissions: 'workspace-write',
        justification: 'Write the requested draft in scratch.',
      },
    };
  }
  return submit(0);
}

/** A model server listing one model, answering control turns by `script`. */
export async function startModel(
  model: string,
  script: ControlScript = DEFAULT_SCRIPT,
  registry?: FakeModel[],
): Promise<FakeModel> {
  const completions: ModelRequestInfo[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model }] }));
        return;
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Message[];
        tools?: { function?: { name?: string } }[];
      };
      const last = body.messages.at(-1)?.role ?? '';
      const offered = body.tools !== undefined;
      completions.push({ tools: offered, last });
      const respond = (action: Action | undefined): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (action !== undefined && 'call' in action) {
          res.write(
            sse(
              model,
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${String(completions.length)}`,
                    type: 'function',
                    function: { name: action.call, arguments: JSON.stringify(action.args) },
                  },
                ],
              },
              null,
            ),
          );
          res.write(sse(model, {}, 'tool_calls'));
        } else {
          const text = action?.text ?? `Answer from ${model}: scope, deliverables and dates.`;
          res.write(sse(model, { role: 'assistant', content: text }, null));
          res.write(sse(model, {}, 'stop'));
        }
        res.end('data: [DONE]\n\n');
      };
      if (!offered) return respond(undefined);
      const names = (body.tools ?? []).map((t) => t.function?.name ?? '');
      const action = nextAction(script, body.messages, names);
      if ('call' in action && action.delayMs !== undefined) {
        setTimeout(() => respond(action), action.delayMs);
      } else {
        respond(action);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fake: FakeModel = {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    completions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  registry?.push(fake);
  return fake;
}
