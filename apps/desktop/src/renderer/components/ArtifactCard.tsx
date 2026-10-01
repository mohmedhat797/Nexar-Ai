import { useState, type ReactElement } from 'react';
import type { ArtifactDto, BridgeResult } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';
import { Icon } from './Icon.js';

/** The stored draft: where it lives, plus Open and Show in folder (both resolved in main). */
export function ArtifactCard({
  projectId,
  artifact,
}: {
  projectId: string;
  artifact: ArtifactDto;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const act = (request: Promise<BridgeResult<null>>): void => {
    setError(null);
    call(request).catch((e: unknown) => setError(errorText(e)));
  };
  return (
    <div className="artifact-card" data-testid="artifact-card">
      <span className="artifact-icon">
        <Icon name="file" />
      </span>
      <div className="artifact-meta">
        <div className="artifact-name">{artifact.name}</div>
        <div className="muted small">
          {artifact.draft ? 'Draft' : 'Artifact'} · {artifact.mediaType} · {artifact.sizeBytes}{' '}
          bytes
        </div>
        {error !== null && <div className="bad-text small">{error}</div>}
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => act(nexar.openArtifact({ projectId, path: artifact.path }))}
      >
        Open
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => act(nexar.revealArtifact({ projectId, path: artifact.path }))}
      >
        Show in folder
      </button>
    </div>
  );
}
