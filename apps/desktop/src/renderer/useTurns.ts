import { useCallback, useEffect, useState } from 'react';
import type { TaskEvent, TaskResult } from '../shared/api.js';
import { call, errorText, newRequestId, nexar } from './bridge.js';
import type { Turn } from './state.js';

export interface Turns {
  readonly turns: readonly Turn[];
  /** Starts a run; `run` receives the request id and resolves with the task result. */
  readonly start: (
    projectId: string,
    source: Turn['source'],
    label: string,
    run: (requestId: string) => Promise<TaskResult>,
  ) => void;
  readonly cancel: (requestId: string) => void;
}

/** All runs of this session (chat and workflows), with `task:event` progress folded in. */
export function useTurns(): Turns {
  const [turns, setTurns] = useState<readonly Turn[]>([]);

  useEffect(
    () =>
      nexar.onTaskEvent((event: TaskEvent) => {
        setTurns((all) =>
          all.map((t) =>
            t.requestId === event.requestId && t.status === 'running'
              ? { ...t, events: [...t.events, event.message].slice(-50) }
              : t,
          ),
        );
      }),
    [],
  );

  const start = useCallback<Turns['start']>((projectId, source, label, run) => {
    const requestId = newRequestId();
    setTurns((all) => [
      ...all,
      { requestId, projectId, source, label, status: 'running', events: [] },
    ]);
    run(requestId).then(
      (result) =>
        setTurns((all) =>
          all.map((t) => (t.requestId === requestId ? { ...t, status: 'done', result } : t)),
        ),
      (error: unknown) =>
        setTurns((all) =>
          all.map((t) =>
            t.requestId === requestId ? { ...t, status: 'error', error: errorText(error) } : t,
          ),
        ),
    );
  }, []);

  const cancel = useCallback((requestId: string) => {
    void call(nexar.cancelTask(requestId)).catch(() => undefined);
  }, []);

  return { turns, start, cancel };
}
