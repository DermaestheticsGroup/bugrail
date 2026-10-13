import type { TableDef } from '../db/tables';
import type { Row } from './db-types';

const NOT_PLAIN = new Set(['id', 'hlc', 'status_hlc', 'code', 'server_seq']);

// One guarded upsert per table. SQLite evaluates every SET against the pre-update row,
// so each CASE compares the stored value with the incoming one.
export function mergeSql(t: TableDef): string {
  const n = t.name;
  const cols = t.columns;
  const insert = `INSERT INTO ${n} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  if (t.kind === 'insert-only') return `${insert} ON CONFLICT(id) DO NOTHING`;

  const status = new Set(t.statusCols);
  const sets: string[] = [];
  for (const c of cols) {
    if (NOT_PLAIN.has(c)) continue;
    const clock = status.has(c) ? 'status_hlc' : 'hlc';
    sets.push(`${c} = CASE WHEN excluded.${clock} > ${n}.${clock} THEN excluded.${c} ELSE ${n}.${c} END`);
  }
  const where = [`excluded.hlc > ${n}.hlc`];
  if (t.kind === 'lww+status') {
    sets.push(`status_hlc = MAX(${n}.status_hlc, excluded.status_hlc)`);
    where.push(`excluded.status_hlc > ${n}.status_hlc`);
  }
  if (cols.includes('code')) {
    sets.push(`code = COALESCE(${n}.code, excluded.code)`);
    where.push(`(${n}.code IS NULL AND excluded.code IS NOT NULL)`);
  }
  sets.push(`hlc = MAX(${n}.hlc, excluded.hlc)`);
  sets.push(`server_seq = excluded.server_seq`);
  return `${insert} ON CONFLICT(id) DO UPDATE SET ${sets.join(', ')} WHERE ${where.join(' OR ')}`;
}

export function mergeArgs(t: TableDef, row: Row): unknown[] {
  return t.columns.map((c) => row[c] ?? null);
}
