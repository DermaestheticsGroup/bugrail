import { getServerDb } from '@/lib/server-db';
import { clientIp, login } from '@/lib/server/auth-routes';
import { getSession } from '@/lib/server/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const ip = clientIp(req.headers);
  const r = await login(await getServerDb(), ip, body?.email, body?.password);
  if (!r.ok) return new Response(null, { status: r.status });
  const s = await getSession();
  s.userId = r.userId;
  s.sessionVersion = r.sessionVersion;
  await s.save();
  return Response.json({ ok: true });
}
