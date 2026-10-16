import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoworkStatusDto } from '../shared/api.js';
import { call, errorText, nexar } from './bridge.js';

export interface CoworkStatus {
  /** The last status main reported; null until the first answer. */
  readonly status: CoworkStatusDto | null;
  /** A status call or a refresh is in flight. */
  readonly loading: boolean;
  readonly error: string | null;
  /** Re-probes DeepSeek Harness now. */
  readonly refresh: () => void;
}

/**
 * The Cowork lane's state as main reports it. Main caches the probe for a minute, so asking again is
 * cheap; this only asks when `enabled` turns on and on demand.
 */
export function useCoworkStatus(enabled: boolean): CoworkStatus {
  const [status, setStatus] = useState<CoworkStatusDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback(
    async (request: () => ReturnType<typeof nexar.coworkStatus>): Promise<void> => {
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
    void run(() => nexar.coworkStatus());
    return () => {
      latest.current += 1;
      setLoading(false);
    };
  }, [enabled, run]);

  const refresh = useCallback((): void => {
    void run(() => nexar.refreshCowork());
  }, [run]);

  return { status, loading, error, refresh };
}
