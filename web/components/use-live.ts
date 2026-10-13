'use client';
import { useEffect, useState } from 'react';
import type { Row } from '@/lib/db-types';
import { useApp } from './app-provider';

// Re-queries when the app's `version` changes (a pull or push settled rows) or when `dep` changes (a local write).
export function useLive(sql: string, params: unknown[] = [], dep = 0): Row[] | null {
  const { db, version } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!db) return;
    let alive = true;
    db.all(sql, ...(JSON.parse(key) as unknown[])).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [db, sql, key, version, dep]);
  return rows;
}
