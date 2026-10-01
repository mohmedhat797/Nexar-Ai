/** What the agent told us about one tool call, accumulated from `tool_call` / `tool_call_update`. */
export interface ToolCallInfo {
  /** DSH puts the tool name in `title`. */
  readonly title?: string;
  readonly kind?: string;
  /** Parsed arguments (or the raw string if DSH could not parse them). Never log this. */
  readonly rawInput?: unknown;
}

/** Latest known `title`, `kind` and `rawInput` per `toolCallId` (the permission request carries only the id). */
export class ToolCallCache {
  private readonly calls = new Map<string, ToolCallInfo>();

  /** Applies a `tool_call` or `tool_call_update`; absent fields keep their previous value. */
  apply(update: Record<string, unknown>): ToolCallInfo | undefined {
    const id = update.toolCallId;
    if (typeof id !== 'string' || id.length === 0) return undefined;
    const previous = this.calls.get(id);
    const title = typeof update.title === 'string' ? update.title : previous?.title;
    const kind = typeof update.kind === 'string' ? update.kind : previous?.kind;
    const rawInput = 'rawInput' in update ? update.rawInput : previous?.rawInput;
    const next: ToolCallInfo = {
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(rawInput === undefined ? {} : { rawInput }),
    };
    this.calls.set(id, next);
    return next;
  }

  get(toolCallId: string): ToolCallInfo | undefined {
    return this.calls.get(toolCallId);
  }
}
