import { getServerDb } from '@/lib/server-db';
import { push } from '@/lib/sync/server';
import { broadcast } from '@/lib/server/events';
import { requireUser } from '@/lib/server/session';

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return new Response('unauthorized', { status: 401, headers: { date: new Date().toUTCString() } });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) return new Response('bad request', { status: 400 });
  const touched = new Set<string>();
  const result = await push(await getServerDb(), user, body.rows, touched);
  if (touched.size) broadcast(touched);
  return Response.json(result, { headers: { date: new Date().toUTCString() } });
}
