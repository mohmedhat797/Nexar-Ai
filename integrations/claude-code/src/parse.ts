/** The fields of a `claude -p --output-format json` result that Nexar uses. */
export interface ParsedClaudeResult {
  readonly text: string;
  readonly isError: boolean;
  readonly subtype?: string;
  readonly apiErrorStatus?: string | number;
  readonly numTurns?: number;
  readonly totalCostUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** First key of `modelUsage`, i.e. the model the CLI actually used. */
  readonly model?: string;
  /** Number of `permission_denials` entries (the entries themselves are never kept). */
  readonly permissionDenials?: number;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function asResult(v: unknown): Json | undefined {
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const hit = asResult(v[i]);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  return isRecord(v) && v['type'] === 'result' ? v : undefined;
}

function findResult(stdout: string): Json | undefined {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = asResult(tryParse(lines[i] as string));
    if (hit !== undefined) return hit;
  }
  // Pretty-printed output spans several lines.
  return asResult(tryParse(stdout.trim()));
}

/** Tolerantly extracts the `type: "result"` object from claude's stdout; undefined if absent. */
export function parseClaudeResult(stdout: string): ParsedClaudeResult | undefined {
  const r = findResult(stdout);
  if (r === undefined) return undefined;

  const usage = isRecord(r['usage']) ? r['usage'] : {};
  const modelUsage = isRecord(r['modelUsage']) ? r['modelUsage'] : {};
  const status = r['api_error_status'];

  const out: { -readonly [K in keyof ParsedClaudeResult]: ParsedClaudeResult[K] } = {
    text: typeof r['result'] === 'string' ? r['result'] : '',
    isError: r['is_error'] === true,
  };
  if (typeof r['subtype'] === 'string') out.subtype = r['subtype'];
  if (typeof status === 'string' || typeof status === 'number') out.apiErrorStatus = status;
  const numTurns = num(r['num_turns']);
  if (numTurns !== undefined) out.numTurns = numTurns;
  const cost = num(r['total_cost_usd']);
  if (cost !== undefined) out.totalCostUsd = cost;
  const input = num(usage['input_tokens']);
  if (input !== undefined) out.inputTokens = input;
  const output = num(usage['output_tokens']);
  if (output !== undefined) out.outputTokens = output;
  const cacheRead = num(usage['cache_read_input_tokens']);
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  const cacheWrite = num(usage['cache_creation_input_tokens']);
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  const model = Object.keys(modelUsage)[0];
  if (model !== undefined) out.model = model;
  if (Array.isArray(r['permission_denials']))
    out.permissionDenials = r['permission_denials'].length;
  return out;
}

/**
 * Tool names from one stream-json line, if it is an `assistant` message with `tool_use` blocks.
 * Tool inputs are deliberately never read.
 */
export function parseToolCallNames(line: string): string[] {
  const v = tryParse(line);
  if (!isRecord(v) || v['type'] !== 'assistant' || !isRecord(v['message'])) return [];
  const content = v['message']['content'];
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      names.push(block['name']);
    }
  }
  return names;
}
