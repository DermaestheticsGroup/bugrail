'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ALL_WS, allowedWorkspaces, hrefFor } from '@/lib/client/nav';
import { loadSnapshot } from '@/lib/client/boot';

// "/" has no screen of its own: send a known user to their first workspace, anyone else to login.
export default function Entry() {
  const router = useRouter();
  useEffect(() => {
    const me = loadSnapshot();
    if (!me) { router.replace('/login'); return; }
    const first = allowedWorkspaces(me.role, me.workspaceIds)[0] ?? ALL_WS;
    router.replace(hrefFor(first, 'dashboard'));
  }, [router]);
  return <p>Loading…</p>;
}
