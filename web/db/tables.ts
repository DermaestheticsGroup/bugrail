export type SyncedTable =
  | 'files' | 'file_shares' | 'testcases' | 'bugs' | 'bug_events'
  | 'bug_status_master' | 'custom_field_defs' | 'activity_log';
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
  testcases: {
    name: 'testcases', kind: 'lww+status', statusCols: ['status'],
    columns: [
      'id', 'code', 'file_id', 'module', 'role_user', 'scenario', 'test_case', 'preconditions', 'steps',
      'test_data', 'expected_result', 'type_test', 'status', 'status_hlc', 'actual_result', 'evidence',
      'execution_date', 'custom_fields', 'created_by', 'created_at', 'extra', 'hlc', 'deleted_at',
      'updated_by', 'server_seq',
    ],
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
  bug_status_master: {
    name: 'bug_status_master', kind: 'lww', statusCols: [],
    columns: ['id', 'name', 'color', 'sort_order', 'hlc', 'deleted_at', 'updated_by', 'server_seq'],
  },
  custom_field_defs: {
    name: 'custom_field_defs', kind: 'lww', statusCols: [],
    columns: ['id', 'label', 'hlc', 'deleted_at', 'updated_by', 'server_seq'],
  },
  activity_log: {
    name: 'activity_log', kind: 'insert-only', statusCols: [],
    columns: ['id', 'ts', 'actor_email', 'actor_role', 'workspace_id', 'action', 'label', 'server_seq'],
  },
};

export const SYNCED_TABLES = Object.keys(TABLES) as SyncedTable[];

export function isSyncedTable(x: unknown): x is SyncedTable {
  return typeof x === 'string' && Object.hasOwn(TABLES, x);
}
