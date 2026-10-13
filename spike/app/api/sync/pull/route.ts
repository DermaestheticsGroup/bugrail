import { getServerDb } from '@/lib/server-db';
import { pull } from '@/lib/sync/server';
import { userFromHeader } from '@/lib/sync/users';

export async function GET(req: Request) {
  const user = userFromHeader(req.headers.get('x-spike-user'));
  if (!user) return new Response('unauthorized', { status: 401, headers: { date: new Date().toUTCString() } });
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0);
  if (!Number.isFinite(since) || since < 0) return new Response('bad request', { status: 400 });
  const result = await pull(await getServerDb(), user, since);
  return Response.json(result, { headers: { date: new Date().toUTCString() } });
}
