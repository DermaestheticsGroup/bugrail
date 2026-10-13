import { getServerDb } from '@/lib/server-db';
import { push } from '@/lib/sync/server';
import { userFromHeader } from '@/lib/sync/users';

export async function POST(req: Request) {
  const user = userFromHeader(req.headers.get('x-dev-user'));
  if (!user) return new Response('unauthorized', { status: 401, headers: { date: new Date().toUTCString() } });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) return new Response('bad request', { status: 400 });
  const result = await push(await getServerDb(), user, body.rows);
  return Response.json(result, { headers: { date: new Date().toUTCString() } });
}
