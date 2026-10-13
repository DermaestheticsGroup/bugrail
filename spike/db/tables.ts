export type SyncedTable = 'files' | 'file_shares' | 'bugs' | 'bug_events';
export type TableKind = 'lww' | 'lww+status' | 'insert-only';

export interface TableDef {
  name: SyncedTable;
  kind: TableKind;
  columns: string[];
  statusCols: string[];
}

export const TABLES: Record<SyncedTable, TableDef> = {
  files: {
    name: 'files', kind: 'lww', statusCols: [],
    columns: ['id', 'name', 'workspace_id', 'created_by', 'created_at', 'hlc', 'deleted_at', 'updated_by', 'server_seq'],
  },
  file_shares: {
    name: 'file_shares', kind: 'lww', statusCols: [],
    columns: ['id', 'file_id', 'workspace_id', 'hlc', 'deleted_at', 'updated_by', 'server_seq'],
  },
  bugs: {
    name: 'bugs', kind: 'lww+status', statusCols: ['status_code'],
    columns: [
      'id', 'code', 'file_id', 'test_case_id', 'title', 'module', 'severity', 'priority',
      'status_code', 'status_hlc', 'description', 'steps', 'expected_result', 'actual_result',
      'platform', 'environment', 'browser', 'device', 'build_version', 'attachments', 'tester',
      'assignee', 'report_date', 'extra', 'hlc', 'deleted_at', 'updated_by', 'server_seq',
    ],
  },
  bug_events: {
    name: 'bug_events', kind: 'insert-only', statusCols: [],
    columns: ['id', 'bug_id', 'kind', 'at', 'email', 'from_status', 'to_status', 'note', 'attachment', 'text', 'assignee', 'server_seq'],
  },
};

export const SYNCED_TABLES = Object.keys(TABLES) as SyncedTable[];

export function isSyncedTable(x: unknown): x is SyncedTable {
  return typeof x === 'string' && Object.hasOwn(TABLES, x);
}
