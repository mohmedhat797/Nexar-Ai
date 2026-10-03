import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalDto, SessionDto } from '../shared/api.js';
import { call, nexar } from './bridge.js';

const POLL_MS = 1500;

export interface PlaneApprovals {
  /** Pending engineering-plane approvals of the open conversation. */
  readonly approvals: readonly ApprovalDto[];
  readonly reload: () => void;
}

/**
 * The open conversation's pending plane approvals, read from `approvals:list` (main holds them in
 * memory and the plane decides them). Polled only while a turn runs; the session's own change
 * events trigger an immediate read, so an approval shows up as soon as the turn records it.
 */
export function usePlaneApprovals(session: SessionDto | null): PlaneApprovals {
  const [approvals, setApprovals] = useState<readonly ApprovalDto[]>([]);
  const sessionId = session?.id ?? null;
  const running = session?.turns.some((t) => t.state === 'running') === true;
  const idRef = useRef(sessionId);
  idRef.current = sessionId;

  const reload = useCallback((): void => {
    const id = idRef.current;
    if (id === null) {
      setApprovals([]);
      return;
    }
    call(nexar.listApprovals({})).then(
      (all) => {
        if (idRef.current === id) {
          setApprovals(all.filter((a) => a.source === 'plane' && a.sessionId === id));
        }
      },
      () => undefined,
    );
  }, []);

  // Every refreshed copy of a running conversation may carry a new approval link.
  useEffect(() => {
    if (running) reload();
    else setApprovals((current) => (current.length === 0 ? current : []));
  }, [session, running, reload]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  return { approvals, reload };
}
