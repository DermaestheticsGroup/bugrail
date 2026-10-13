'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ALL_WS, allowedWorkspaces, hrefFor, navBySlug, navFor } from '@/lib/client/nav';
import { CLOCK_LIMIT_MS } from '@/lib/client/sync-engine';
import { useApp } from './app-provider';
import NotifBell from './notif-bell';
import RejectedPanel from './rejected-panel';

function Badge() {
  const { sync } = useApp();
  const last = sync.lastPullAt ? new Date(sync.lastPullAt).toLocaleTimeString() : 'never';
  // The pending count shows offline too: that is when it matters most.
  const label = sync.pending > 0 ? `${sync.pending} pending` : sync.syncing ? 'syncing' : 'up to date';
  return (
    <p data-testid="sync-badge" title={`last pull: ${last}`}>
      <span data-testid="conn">{sync.online ? 'online' : 'offline'}</span> · <span data-testid="pending">{label}</span> · pulled {last}
      {sync.error ? <span role="alert"> · {sync.error}</span> : null}
    </p>
  );
}

// `children` is the current screen. Everything else is shell: nav (gated by the local role matrix), workspace picker, banners.
export default function Shell({ ws, slug, children }: { ws: string; slug: string; children: React.ReactNode }) {
  const app = useApp();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => { if (app.phase === 'anon') router.replace('/login'); }, [app.phase, router]);
  // Keep the session-expired state visible but never discard local data: the same user's next login pushes the outbox.
  useEffect(() => { if (app.sync.auth === 'expired') router.replace('/login?expired=1'); }, [app.sync.auth, router]);

  if (app.phase === 'booting') return <p data-testid="booting">Loading…</p>;
  if (app.phase === 'error') return <p role="alert">Could not open the local database: {app.error}</p>;
  if (app.phase !== 'ready' || !app.config) return null;

  const { me, workspaces, rolePermissions } = app.config;
  const items = navFor(me.role, rolePermissions[me.role] ? rolePermissions : null);
  const current = navBySlug(slug);
  const choices = allowedWorkspaces(me.role, me.workspaceIds, workspaces.map((w) => w.id));
  const nameOf = (id: string) => (id === ALL_WS ? 'Semua workspace' : workspaces.find((w) => w.id === id)?.name ?? id);
  const blocked = Math.abs(app.sync.skewMs) > CLOCK_LIMIT_MS;

  return (
    <div>
      <header>
        <strong>BugRail</strong>
        <Badge />
        {choices.length > 1 ? (
          <select aria-label="Workspace" value={ws} onChange={(e) => router.push(hrefFor(e.target.value, slug))}>
            {choices.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
          </select>
        ) : <span>{nameOf(ws)}</span>}
        <NotifBell ws={ws} />
        <span>{me.email}</span>
        <button type="button" onClick={() => void app.logout()}>Log out</button>
      </header>
      {blocked ? <p role="alert" data-testid="clock-banner">Your device clock is more than 5 minutes off the server. Editing is paused until it is fixed.</p> : null}
      <RejectedPanel />
      <nav aria-label="Main">
        {/* Every page lists every link, so Next prefetches them all while online and soft navigation keeps working offline. */}
        {items.map((n) => (
          <Link key={n.slug} href={hrefFor(ws, n.slug)} aria-current={path === hrefFor(ws, n.slug) ? 'page' : undefined}>{n.title}</Link>
        ))}
      </nav>
      <main>
        <h1>{current?.title ?? slug}</h1>
        <p>{current?.sub}</p>
        {current?.onlineOnly && !app.sync.online ? <p data-testid="needs-connection">This page needs a connection.</p> : children}
      </main>
    </div>
  );
}
