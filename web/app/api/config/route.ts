import { getServerDb } from '@/lib/server-db';
import { buildConfig } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';

export async function GET(req: Request) {
  const user = await requireUser(req);
  const headers = { date: new Date().toUTCString() };
  if (!user) return new Response(null, { status: 401, headers });
  return Response.json(await buildConfig(await getServerDb(), user), { headers });
}
