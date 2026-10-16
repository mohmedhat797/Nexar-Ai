import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectMemoryDto, ProjectMemoryKindDto } from '../shared/api.js';
import { BridgeError, call, errorText, nexar } from './bridge.js';

const FULL_TEXT = 'Project memory is full; remove an entry first.';

/** The store refuses an add that would not fit every turn (count, file size or context budget). */
function memoryErrorText(error: unknown): string {
  if (error instanceof BridgeError && error.message.startsWith('Project memory is full')) {
    return FULL_TEXT;
  }
  return errorText(error);
}

export interface ProjectMemory {
  readonly entries: readonly ProjectMemoryDto[];
  readonly error: string | null;
  readonly add: (kind: ProjectMemoryKindDto, text: string) => Promise<boolean>;
  readonly remove: (entryId: string) => Promise<void>;
}

/** The project's owner-confirmed memory; main holds the authoritative copy (ADR-030 §7). */
export function useProjectMemory(projectId: string): ProjectMemory {
  const [entries, setEntries] = useState<readonly ProjectMemoryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const reload = useCallback(async (): Promise<void> => {
    const pid = projectRef.current;
    try {
      const rows = await call(nexar.listProjectMemory(pid));
      if (projectRef.current !== pid) return;
      setEntries(rows);
      setError(null);
    } catch (e) {
      if (projectRef.current === pid) setError(memoryErrorText(e));
    }
  }, []);

  useEffect(() => {
    setEntries([]);
    void reload();
  }, [projectId, reload]);

  const add = useCallback(
    async (kind: ProjectMemoryKindDto, text: string): Promise<boolean> => {
      try {
        await call(nexar.addProjectMemory({ projectId: projectRef.current, kind, text }));
        await reload();
        return true;
      } catch (e) {
        setError(memoryErrorText(e));
        return false;
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (entryId: string): Promise<void> => {
      try {
        await call(nexar.removeProjectMemory({ projectId: projectRef.current, entryId }));
        await reload();
      } catch (e) {
        setError(memoryErrorText(e));
      }
    },
    [reload],
  );

  return { entries, error, add, remove };
}
