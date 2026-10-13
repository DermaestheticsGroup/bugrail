import { getServerDb } from '@/lib/server-db';
import { pull } from '@/lib/sync/server';
import { userFromHeader } from '@/lib/sync/users';

export async function GET(req: Request) {
  const user = userFromHeader(req.headers.get('x-dev-user'));
  if (!user) return new Response('unauthorized', { status: 401, headers: { date: new Date().toUTCString() } });
  const q = new URL(req.url).searchParams;
  // Missing av/sv force a reset rather than skipping the check.
  const since = Number(q.get('since') ?? 0), av = Number(q.get('av') ?? -1), sv = Number(q.get('sv') ?? 0);
  if (![since, av, sv].every(Number.isInteger) || since < 0) return new Response('bad request', { status: 400 });
  const result = await pull(await getServerDb(), user, since, av, sv);
  return Response.json(result, { headers: { date: new Date().toUTCString() } });
}
