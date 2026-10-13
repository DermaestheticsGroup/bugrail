import { getServerDb } from '@/lib/server-db';
import { clientIp, login } from '@/lib/server/auth-routes';
import { getSession } from '@/lib/server/session';

export async function POST(req: Request) {
  // The login form posts form-encoded when JavaScript is off; fetch callers send JSON.
  const isForm = (req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
  const body = isForm ? Object.fromEntries(await req.formData().catch(() => new FormData())) : await req.json().catch(() => null);
  const r = await login(await getServerDb(), clientIp(req.headers), body?.email, body?.password);
  if (!r.ok) {
    return isForm ? Response.redirect(new URL(`/login?error=${r.status}`, req.url), 303) : new Response(null, { status: r.status });
  }
  const s = await getSession();
  s.userId = r.userId;
  s.sessionVersion = r.sessionVersion;
  await s.save();
  return isForm ? Response.redirect(new URL('/', req.url), 303) : Response.json({ ok: true });
}
