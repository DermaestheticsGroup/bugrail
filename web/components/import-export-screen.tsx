'use client';
// Import & Export: test case import (.xlsx/.csv) and template, Excel/CSV export of test cases and bugs, JSON backup and restore of this device's data.
import { useState } from 'react';
import { FILE_SCOPE_SQL } from '@/lib/client/analytics';
import {
  BUG_COLUMNS, arrayToCSV, bugExportRows, bugWorkbook, importTestcases, makeBackup, parseBackup, parseImport, restoreBackup, tcExportColumns, tcExportRows, tcWorkbook, templateWorkbook, workbookBytes,
} from '@/lib/client/io';
import { statusMaster, statusName } from '@/lib/client/bug-model';
import { logActivity } from '@/lib/client/repo';
import { ALL_WS } from '@/lib/client/nav';
import { can } from '@/lib/domain/auth';
import { useApp } from './app-provider';
import { useLive } from './use-live';

const today = () => new Date().toISOString().slice(0, 10);

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export default function ImportExport({ ws }: { ws: string }) {
  const app = useApp();
  const scope = ws === ALL_WS ? { sql: '1', params: [] as string[] } : { sql: FILE_SCOPE_SQL, params: [ws, ws] };
  const files = useLive(`SELECT id, name, workspace_id FROM files WHERE deleted_at IS NULL AND ${ws === ALL_WS ? '1' : '(workspace_id = ? OR id IN (SELECT file_id FROM file_shares WHERE workspace_id = ? AND deleted_at IS NULL))'} ORDER BY rowid`, scope.params);
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!app.config || !app.ctx) return null;
  const { me, rolePermissions } = app.config;
  const ctx = app.ctx;
  const allowed = (k: string) => can({ role: me.role }, k, rolePermissions);
  const ok = (text: string) => setMsg({ kind: 'ok', text });
  const fail = (e: unknown) => setMsg({ kind: 'error', text: (e as Error).message });
  const wsOf = (fileId?: string) => String((files ?? []).find((f) => f.id === fileId)?.workspace_id ?? '') || null;
  const guard = async (fn: () => Promise<void>) => { setMsg(null); setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const fileId = target || String(files?.[0]?.id ?? '');
  const labels = async () => ((await ctx.db.all('SELECT label FROM custom_field_defs WHERE deleted_at IS NULL ORDER BY rowid')) as { label: string }[]).map((r) => r.label);
  const tcRows = async () => ctx.db.all(`SELECT * FROM testcases WHERE deleted_at IS NULL AND (${scope.sql}) ORDER BY module, rowid`, ...scope.params);
  const bugRows = async () => {
    const [bugs, tcs, master] = await Promise.all([
      ctx.db.all(`SELECT * FROM bugs WHERE deleted_at IS NULL AND (${scope.sql}) ORDER BY rowid`, ...scope.params),
      ctx.db.all('SELECT id, code FROM testcases WHERE deleted_at IS NULL'),
      ctx.db.all('SELECT * FROM bug_status_master'),
    ]);
    const m = statusMaster(master);
    return bugExportRows(bugs, (id) => String(tcs.find((t) => t.id === id)?.code ?? ''), (c) => statusName(m, c));
  };

  const doImport = (file: File) => guard(async () => {
    if (!fileId) throw new Error('Buat file test case dulu.');
    const n = await importTestcases(ctx, fileId, parseImport(await file.arrayBuffer()));
    ok(`Berhasil menambahkan ${n} test case.`);
  });
  const exportTc = (kind: 'xlsx' | 'csv') => guard(async () => {
    const rows = tcExportRows(await tcRows(), await labels());
    const cols = tcExportColumns(await labels());
    if (kind === 'xlsx') download(workbookBytes(tcWorkbook(rows, cols)), `TestCases_${today()}.xlsx`, XLSX_TYPE);
    else download(arrayToCSV(rows, cols), `TestCases_${today()}.csv`, 'text/csv');
    await logActivity(ctx, ws === ALL_WS ? null : ws, 'testcase_export', `${rows.length} test case di-export ke ${kind === 'xlsx' ? 'Excel' : 'CSV'}`);
    ok(`Export ${rows.length} test case selesai.`);
  });
  const exportBug = (kind: 'xlsx' | 'csv') => guard(async () => {
    const rows = await bugRows();
    if (kind === 'xlsx') download(workbookBytes(bugWorkbook(rows)), `BugReports_${today()}.xlsx`, XLSX_TYPE);
    else download(arrayToCSV(rows, BUG_COLUMNS), `BugReports_${today()}.csv`, 'text/csv');
    await logActivity(ctx, ws === ALL_WS ? null : ws, 'bugreport_export', `${rows.length} bug di-export ke ${kind === 'xlsx' ? 'Excel' : 'CSV'}`);
    ok(`Export ${rows.length} bug selesai.`);
  });
  const backup = () => guard(async () => {
    const b = await makeBackup(ctx.db);
    download(JSON.stringify(b, null, 2), `QA_Backup_${today()}.json`, 'application/json');
    ok('Backup JSON diunduh.');
  });
  const restore = (file: File) => guard(async () => {
    const b = parseBackup(await file.text());
    if (!confirm('Restore menambahkan dan memperbarui data dari file ini. Lanjutkan?')) return;
    const n = await restoreBackup(ctx, b);
    await logActivity(ctx, wsOf(fileId), 'testcase_create', `${n} baris di-restore dari backup JSON`);
    ok(`${n} baris di-restore. Kode baru diberikan server saat sinkron.`);
  });

  return (
    <section>
      {msg ? <p role={msg.kind === 'error' ? 'alert' : 'status'} data-testid={`io-${msg.kind}`} style={{ whiteSpace: 'pre-line' }}>{msg.text}</p> : null}
      {allowed('testcase_create') ? (
        <div>
          <h3>Import Test Case (.xlsx / .csv)</h3>
          <label>File tujuan<select aria-label="Target file" value={fileId} onChange={(e) => setTarget(e.target.value)}>{(files ?? []).map((f) => <option key={String(f.id)} value={String(f.id)}>{String(f.name)}</option>)}</select></label>{' '}
          <input type="file" aria-label="Import file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doImport(f); }} />{' '}
          <button type="button" onClick={() => download(workbookBytes(templateWorkbook()), 'Template_Import_TestCase.xlsx', XLSX_TYPE)}>Download template</button>
        </div>
      ) : null}
      <div>
        <h3>Export</h3>
        <button type="button" disabled={busy} onClick={() => void exportTc('xlsx')}>Test Case Excel</button>{' '}
        <button type="button" disabled={busy} onClick={() => void exportTc('csv')}>Test Case CSV</button>{' '}
        <button type="button" disabled={busy} onClick={() => void exportBug('xlsx')}>Bug Report Excel</button>{' '}
        <button type="button" disabled={busy} onClick={() => void exportBug('csv')}>Bug Report CSV</button>
      </div>
      <div>
        <h3>Backup &amp; Restore (data di perangkat ini)</h3>
        <button type="button" disabled={busy} onClick={() => void backup()}>Backup JSON</button>{' '}
        {allowed('testcase_create') ? <input type="file" aria-label="Restore file" accept=".json" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restore(f); }} /> : null}
      </div>
    </section>
  );
}
