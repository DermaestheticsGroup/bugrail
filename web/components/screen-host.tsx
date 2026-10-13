'use client';
import { useParams } from 'next/navigation';
import { navBySlug } from '@/lib/client/nav';
import Shell from './shell';
import { Bugs, Dashboard, Later, Testcases } from './screens';

export default function ScreenHost() {
  const p = useParams<{ ws: string; screen?: string[] }>();
  const ws = decodeURIComponent(String(p.ws));
  const slug = (p.screen ?? []).join('/');
  const nav = navBySlug(slug);
  return (
    <Shell ws={ws} slug={slug}>
      {slug === 'dashboard' ? <Dashboard ws={ws} /> : slug === 'bugs' ? <Bugs ws={ws} /> : slug === 'testcases' ? <Testcases ws={ws} /> : <Later title={nav?.title ?? slug} />}
    </Shell>
  );
}
