'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { hrefFor, navBySlug, resolveScreen } from '@/lib/client/nav';
import { useApp } from './app-provider';
import Shell from './shell';
import { Dashboard, Later } from './screens';
import BugScreen from './bug-screen';
import TestcaseScreen from './testcase-screen';

// Old links look like "#bug=<id>": open that bug's detail page once the local database can find it.
function BugHashShim({ ws }: { ws: string }) {
  const app = useApp();
  const router = useRouter();
  useEffect(() => {
    if (app.phase !== 'ready' || !app.db) return;
    const raw = /^#bug=(.+)$/.exec(window.location.hash);
    if (!raw) return;
    let id: string;
    try { id = decodeURIComponent(raw[1]); } catch { return; } // a malformed escape is just not a bug link
    void app.db.get('SELECT id, file_id FROM bugs WHERE id = ? AND deleted_at IS NULL', id).then((b) => {
      if (b) router.replace(hrefFor(ws, `bugs/${encodeURIComponent(String(b.file_id))}/${encodeURIComponent(String(b.id))}`));
    });
  }, [app.phase, app.db, ws, router]);
  return null;
}

export default function ScreenHost() {
  const p = useParams<{ ws: string; screen?: string[] }>();
  const ws = decodeURIComponent(String(p.ws));
  const { slug, rest } = resolveScreen(p.screen ?? []);
  const nav = navBySlug(slug);
  return (
    <Shell ws={ws} slug={slug}>
      <BugHashShim ws={ws} />
      {slug === 'dashboard' ? <Dashboard ws={ws} /> : slug === 'bugs' ? <BugScreen ws={ws} rest={rest} /> : slug === 'testcases' ? <TestcaseScreen ws={ws} fileId={rest[0] ? decodeURIComponent(rest[0]) : null} /> : <Later title={nav?.title ?? slug} />}
    </Shell>
  );
}
