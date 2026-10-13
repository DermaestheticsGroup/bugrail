'use client';
// Topbar bell. Built from rows that already exist (status and assignment events, Open test cases): no notification store.
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { seenKey, toDomain, unreadCount, type Rec } from '@/lib/client/analytics';
import { hrefFor } from '@/lib/client/nav';
import { can } from '@/lib/domain/auth';
import { NotifCalc } from '@/lib/domain/notifications';
import { useApp } from './app-provider';
import { useLive } from './use-live';

const readSeen = (email: string) => { try { return localStorage.getItem(seenKey(email)) || ''; } catch { return ''; } };

export default function NotifBell({ ws }: { ws: string }) {
  const app = useApp();
  const me = app.config?.me;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => (me ? readSeen(me.email) : ''));
  const files = useLive('SELECT id, name FROM files WHERE deleted_at IS NULL');
  const tcs = useLive("SELECT id, file_id, status, created_by FROM testcases WHERE deleted_at IS NULL AND status = 'Open'");
  const bugs = useLive('SELECT * FROM bugs WHERE deleted_at IS NULL');
  const events = useLive("SELECT * FROM bug_events WHERE kind IN ('status','assignment')");
  const data = useMemo(() => {
    if (!me || !files || !tcs || !bugs || !events || !app.config) return { events: [], reminders: [] };
    const dom = toDomain(files, tcs, bugs, events);
    const perms = app.config.rolePermissions;
    return NotifCalc.build({ bugs: dom.bugs, testcases: dom.tcs, me: me.email, canBug: can({ role: me.role }, 'bugreport_read', perms), canTc: can({ role: me.role }, 'testcase_read', perms) });
  }, [me, files, tcs, bugs, events, app.config]);
  const loaded = !!(files && tcs && bugs && events);
  // Seen advances only once the panel is open and its data has loaded, so events that arrive while it is open are marked too.
  useEffect(() => {
    if (!open || !loaded || !me) return;
    const now = new Date().toISOString();
    try { localStorage.setItem(seenKey(me.email), now); } catch { /* private mode: the badge just stays */ }
    setSeen(now);
  }, [open, loaded, me]);
  if (!me) return null;

  const unread = unreadCount(data.events, seen);
  const fileName = (id: string) => String(files?.find((f) => f.id === id)?.name ?? 'Tanpa File');
  const toggle = () => setOpen(!open);
  const link = (e: Rec) =>
    hrefFor(ws, e.target.fileId ? `bugs/${encodeURIComponent(e.target.fileId)}/${encodeURIComponent(e.target.id)}` : 'bugs');

  return (
    <span data-testid="notif">
      <button type="button" aria-label="Notifikasi" aria-expanded={open} onClick={toggle}>🔔 <span data-testid="notif-badge">{unread ? (unread > 99 ? '99+' : unread) : ''}</span></button>
      {open ? (
        <div role="region" aria-label="Panel notifikasi" data-testid="notif-panel">
          {data.reminders.length ? <h4>Pengingat</h4> : null}
          {data.reminders.map((r) => (
            <p key={r.fileId} data-testid="notif-reminder">⏳ <Link href={hrefFor(ws, `testcases/${encodeURIComponent(r.fileId)}`)} onClick={() => setOpen(false)}>{r.count} test case belum dijalankan</Link> — File: {fileName(r.fileId)}</p>
          ))}
          {data.events.length ? <h4>Aktivitas</h4> : null}
          {data.events.map((e, i) => (
            <p key={i} data-testid="notif-event">
              {e.icon} <Link href={link(e)} onClick={() => setOpen(false)}>{e.text}</Link>{e.note ? <em> — {e.note}</em> : null} <small>{new Date(e.at).toLocaleString()}</small>
            </p>
          ))}
          {!data.events.length && !data.reminders.length ? <p>Belum ada notifikasi untuk Anda.</p> : null}
        </div>
      ) : null}
    </span>
  );
}
