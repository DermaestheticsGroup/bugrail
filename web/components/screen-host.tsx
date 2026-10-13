'use client';
import { useParams } from 'next/navigation';
import { navBySlug, resolveScreen } from '@/lib/client/nav';
import Shell from './shell';
import { Bugs, Dashboard, Later } from './screens';
import TestcaseScreen from './testcase-screen';

export default function ScreenHost() {
  const p = useParams<{ ws: string; screen?: string[] }>();
  const ws = decodeURIComponent(String(p.ws));
  const { slug, rest } = resolveScreen(p.screen ?? []);
  const nav = navBySlug(slug);
  return (
    <Shell ws={ws} slug={slug}>
      {slug === 'dashboard' ? <Dashboard ws={ws} /> : slug === 'bugs' ? <Bugs ws={ws} /> : slug === 'testcases' ? <TestcaseScreen ws={ws} fileId={rest[0] ? decodeURIComponent(rest[0]) : null} /> : <Later title={nav?.title ?? slug} />}
    </Shell>
  );
}
