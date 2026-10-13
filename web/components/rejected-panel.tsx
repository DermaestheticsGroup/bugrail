'use client';
import { useState } from 'react';
import { dismissRejected } from '@/lib/sync/client';
import { useApp } from './app-provider';
import { useLive } from './use-live';

// Writes the server refused. They are parked, not lost: the user sees why and dismisses each, which drops the refused local
// copy and re-pulls whatever the server still allows them to see.
export default function RejectedPanel() {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const rows = useLive('SELECT row_id, tbl, reason, at FROM rejected ORDER BY at, row_id', [], tick);
  if (!rows?.length) return null;
  async function dismiss(rowId: string, tbl: string) {
    await dismissRejected(app.db!, rowId, tbl);
    setTick((t) => t + 1);
    await app.refresh();
  }
  return (
    <section role="alert" data-testid="rejected-panel" aria-label="Changes the server refused">
      <p><strong>{rows.length} change(s) were refused by the server and are not saved there.</strong></p>
      <ul>
        {rows.map((r) => (
          <li key={`${r.tbl}:${r.row_id}`}>
            {String(r.tbl)} {String(r.row_id)}: {String(r.reason)}{' '}
            <button type="button" onClick={() => void dismiss(String(r.row_id), String(r.tbl))}>Discard my change</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
