import { getSession } from '@/lib/server/session';

export async function POST() {
  (await getSession()).destroy();
  return Response.json({ ok: true });
}
