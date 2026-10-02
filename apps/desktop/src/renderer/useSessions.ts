import { useCallback, useEffect, useRef, useState } from 'react';
import type { Mode, SessionDto, SessionEvent, SessionSummaryDto } from '../shared/api.js';
import { call, errorText, nexar } from './bridge.js';

const POLL_WHILE_BUSY_MS = 3000;
const MAX_PROGRESS_LINES = 50;
const MAX_TITLE_CHARS = 60;
const DEFAULT_TITLE = 'New conversation';

export interface SendArgs {
  readonly kind: string;
  readonly prompt: string;
  readonly preferredResourceIds?: readonly string[];
  readonly maxCostUsd?: number;
}

export interface Sessions {
  /** The selected project's conversations, newest first. */
  readonly list: readonly SessionSummaryDto[];
  readonly selectedId: string | null;
  /** A cache of `sessions:get` for the selected conversation; main holds the authoritative copy. */
  readonly session: SessionDto | null;
  /** Progress lines of running turns, by turn id (live only; never persisted). */
  readonly progress: Readonly<Record<string, readonly string[]>>;
  /** A turn is running, or a submit is in flight. */
  readonly busy: boolean;
  readonly error: string | null;
  readonly select: (id: string) => void;
  /** Starts an empty conversation (an already-empty selected one is reused). */
  readonly create: () => Promise<void>;
  /** Resolves once the turn is stored; rejects (and keeps the idempotency key) on failure. */
  readonly send: (args: SendArgs) => Promise<void>;
  readonly cancel: (turnId: string) => void;
}

function titleFrom(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

function isActive(session: SessionDto | null): boolean {
  return (
    session?.turns.some((t) => t.state === 'running' || t.state === 'pending-confirmation') === true
  );
}

/** The selected project's conversations: every state here is a cache of the main process. */
export function useSessions(projectId: string | null, mode: Mode): Sessions {
  const [list, setList] = useState<readonly SessionSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [progress, setProgress] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectRef = useRef(projectId);
  const selectedRef = useRef<string | null>(null);
  const keyRef = useRef<{ sessionId: string; text: string; key: string } | null>(null);

  const refreshList = useCallback(async (): Promise<void> => {
    const pid = projectRef.current;
    if (pid === null) return;
    try {
      const rows = await call(nexar.listSessions(pid));
      if (projectRef.current === pid) setList(rows);
    } catch (e) {
      if (projectRef.current === pid) setError(errorText(e));
    }
  }, []);

  const loadSession = useCallback(async (id: string): Promise<void> => {
    try {
      const loaded = await call(nexar.getSession(id));
      if (selectedRef.current === id) {
        setSession(loaded);
        setError(null);
      }
    } catch (e) {
      if (selectedRef.current === id) setError(errorText(e));
    }
  }, []);

  const choose = useCallback(
    (id: string | null): void => {
      selectedRef.current = id;
      setSelectedId(id);
      setSession(null);
      setProgress({});
      if (id !== null) void loadSession(id);
    },
    [loadSession],
  );

  // Opening a project selects its newest conversation, or none.
  useEffect(() => {
    projectRef.current = projectId;
    keyRef.current = null;
    setList([]);
    setError(null);
    choose(null);
    if (projectId === null) return;
    let stale = false;
    void (async () => {
      try {
        const rows = await call(nexar.listSessions(projectId));
        if (stale) return;
        setList(rows);
        const newest = rows[0];
        if (newest !== undefined) choose(newest.id);
      } catch (e) {
        if (!stale) setError(errorText(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [projectId, choose]);

  useEffect(
    () =>
      nexar.onSessionEvent((event: SessionEvent) => {
        if (event.type === 'turn') {
          void refreshList();
          if (event.sessionId === selectedRef.current) void loadSession(event.sessionId);
        } else if (event.sessionId === selectedRef.current && event.message !== undefined) {
          const line = event.message;
          setProgress((all) => ({
            ...all,
            [event.turnId]: [...(all[event.turnId] ?? []), line].slice(-MAX_PROGRESS_LINES),
          }));
        }
      }),
    [refreshList, loadSession],
  );

  const active = isActive(session);
  // Events are pushed; this only covers a missed one while a turn is running.
  useEffect(() => {
    if (!active || selectedId === null) return;
    const timer = setInterval(() => void loadSession(selectedId), POLL_WHILE_BUSY_MS);
    return () => clearInterval(timer);
  }, [active, selectedId, loadSession]);

  const create = useCallback(async (): Promise<void> => {
    const pid = projectRef.current;
    if (pid === null) return;
    if (session !== null && session.turnCount === 0) return;
    try {
      const created = await call(nexar.createSession({ projectId: pid, mode }));
      if (projectRef.current !== pid) return;
      selectedRef.current = created.id;
      setSelectedId(created.id);
      setSession(created);
      setProgress({});
      setError(null);
      await refreshList();
    } catch (e) {
      setError(errorText(e));
    }
  }, [mode, session, refreshList]);

  const send = useCallback(
    async (args: SendArgs): Promise<void> => {
      const pid = projectRef.current;
      if (pid === null) return;
      setSubmitting(true);
      try {
        let current = session;
        if (current === null) {
          current = await call(nexar.createSession({ projectId: pid, mode }));
          selectedRef.current = current.id;
          setSelectedId(current.id);
          setSession(current);
        }
        const sessionId = current.id;
        // One key per user action: a retry of the same text in the same conversation reuses it.
        const pending = keyRef.current;
        const key =
          pending?.sessionId === sessionId && pending.text === args.prompt
            ? pending.key
            : crypto.randomUUID().replaceAll('-', '');
        keyRef.current = { sessionId, text: args.prompt, key };
        await call(
          nexar.submitTurn({
            sessionId,
            submissionKey: key,
            text: args.prompt,
            kind: args.kind,
            ...(args.preferredResourceIds === undefined
              ? {}
              : { preferredResourceIds: args.preferredResourceIds }),
            ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
          }),
        );
        keyRef.current = null;
        setError(null);
        const title = titleFrom(args.prompt);
        if (current.title === DEFAULT_TITLE && current.turnCount === 0 && title !== '') {
          await call(nexar.renameSession({ sessionId, title })).catch(() => undefined);
        }
        await Promise.all([loadSession(sessionId), refreshList()]);
      } catch (e) {
        setError(errorText(e));
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [session, mode, loadSession, refreshList],
  );

  const cancel = useCallback((turnId: string): void => {
    const sessionId = selectedRef.current;
    if (sessionId === null) return;
    call(nexar.cancelTurn({ sessionId, turnId })).catch((e: unknown) => setError(errorText(e)));
  }, []);

  return {
    list,
    selectedId,
    session,
    progress,
    busy: submitting || active,
    error,
    select: choose,
    create,
    send,
    cancel,
  };
}
