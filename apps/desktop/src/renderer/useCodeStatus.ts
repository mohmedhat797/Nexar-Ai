import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaneStatusDto } from '../shared/api.js';
import { call, errorText, nexar } from './bridge.js';

export interface CodeStatus {
  /** The last status main reported (for `projectId` when one was given); null until the first answer. */
  readonly status: PlaneStatusDto | null;
  /** A status call, a refresh or a mapping change is in flight. */
  readonly loading: boolean;
  readonly error: string | null;
  /** Re-probes the plane now. */
  readonly refresh: () => void;
  /** Maps the project to a plane project id (`null` removes the mapping). */
  readonly setPlaneProject: (planeProject: string | null) => Promise<void>;
}

/**
 * The engineering plane's state as main reports it, optionally for one Desktop project. Main caches
 * the probe for a minute, so asking again is cheap; this only asks when `enabled` turns on, when the
 * project changes and on demand. Everything here is a cache of the main process.
 */
export function useCodeStatus(projectId: string | undefined, enabled: boolean): CodeStatus {
  const [status, setStatus] = useState<PlaneStatusDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback(
    async (request: () => ReturnType<typeof nexar.codeStatus>): Promise<void> => {
      const mine = ++latest.current;
      setLoading(true);
      try {
        const next = await call(request());
        if (latest.current !== mine) return;
        setStatus(next);
        setError(null);
      } catch (e) {
        if (latest.current !== mine) return;
        setError(errorText(e));
      } finally {
        if (latest.current === mine) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    setStatus(null);
    void run(() => nexar.codeStatus(projectId === undefined ? {} : { projectId }));
    return () => {
      latest.current += 1;
      setLoading(false);
    };
  }, [enabled, projectId, run]);

  const refresh = useCallback((): void => {
    void run(() => nexar.refreshCode(projectId === undefined ? {} : { projectId }));
  }, [projectId, run]);

  const setPlaneProject = useCallback(
    async (planeProject: string | null): Promise<void> => {
      if (projectId === undefined) return;
      await run(() => nexar.setPlaneProject({ projectId, planeProject }));
    },
    [projectId, run],
  );

  return { status, loading, error, refresh, setPlaneProject };
}
