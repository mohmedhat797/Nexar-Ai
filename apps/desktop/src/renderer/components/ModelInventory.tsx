import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { InventoryRow, InventorySourceId } from '../../shared/api.js';
import { call, errorText, nexar } from '../bridge.js';

/** Metadata reads never refresh a vendor runtime; only the explicit button does. */
export function ModelInventory({
  sourceId,
  revision,
  native = false,
  disabled = false,
}: {
  sourceId: InventorySourceId;
  revision?: string | undefined;
  native?: boolean;
  disabled?: boolean;
}): ReactElement {
  const [row, setRow] = useState<InventoryRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const rows = await call(nexar.listModelInventories());
        const next = rows.find((value) => value.sourceId === sourceId) ?? null;
        if (!active) return;
        setRow(next);
        timer = setTimeout(() => void read(), next?.refreshing ? 1000 : 15_000);
      } catch (failure) {
        if (active) setError(errorText(failure));
      }
    };
    void read();
    return () => {
      active = false;
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [sourceId, revision]);

  async function refresh(): Promise<void> {
    const owner = generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await call(nexar.refreshModelInventory(sourceId));
      if (owner === generation.current) setRow(next);
    } catch (failure) {
      if (owner === generation.current) setError(errorText(failure));
    } finally {
      if (owner === generation.current) setBusy(false);
    }
  }
  const inventory = row?.inventory;
  return (
    <div className="stack" data-testid={`inventory-${sourceId}`}>
      <div className="row">
        <span className="strong">Available models</span>
        <span className="chip" data-testid={`inventory-${sourceId}-status`}>
          {busy || row?.refreshing ? 'Refreshing' : (inventory?.status ?? 'Unavailable')}
        </span>
        <button
          type="button"
          className="btn"
          disabled={disabled || busy || row?.refreshing}
          aria-label={`Refresh ${sourceId} models`}
          onClick={() => void refresh()}
        >
          Refresh models
        </button>
      </div>
      {native && (
        <p className="muted small">Refresh uses the native runtime and may require its sign-in.</p>
      )}
      {inventory?.observedAt && (
        <p className="muted small">
          Last observed: {new Date(inventory.observedAt).toLocaleString()}
        </p>
      )}
      {inventory?.reason && <p className="muted small">{inventory.reason}</p>}
      {inventory?.status === 'stale' && (
        <p role="status">Previous models are shown for reference; refresh before selecting them.</p>
      )}
      {inventory?.entries.length ? (
        <ul>
          {inventory.entries.map((entry) => (
            <li key={entry.selection.kind === 'model' ? entry.selection.id : 'provider-default'}>
              {entry.displayName}
              {entry.selection.kind === 'model' ? ` (${entry.selection.id})` : ' — runtime default'}
              {entry.compatibility === 'native-agent' ? ' · native agent' : ' · model turn'}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No explicit models verified for this connection.</p>
      )}
      <p className="muted small">
        Use Auto or select a compatible resource in AI behavior. Model access may change.
      </p>
      {error && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
