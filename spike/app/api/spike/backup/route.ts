import { getServerDb } from '@/lib/server-db';

// shortcut: unauthenticated spike-only endpoint; production runs backups from a systemd timer through an admin-only path.
// Disabled (404) unless BUGRAIL_SPIKE=1, and targets containing '..' are refused.
export async function POST(req: Request) {
  if (process.env.BUGRAIL_SPIKE !== '1') return new Response('not found', { status: 404 });
  const target = new URL(req.url).searchParams.get('to');
  if (!target || !/^[\w./-]+\.db$/.test(target) || target.includes('..')) return new Response('bad target', { status: 400 });
  const db = await getServerDb();
  const t0 = performance.now();
  try {
    await db.exec(`VACUUM INTO '${target}'`);
    return Response.json({ ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
