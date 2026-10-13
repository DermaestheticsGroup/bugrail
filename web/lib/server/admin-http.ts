import { getServerDb } from '../server-db';
import { requireAdmin } from './session';
import type { AdminResult } from './admin';
import type { Db } from '../db-types';

// Shared shell for the admin route handlers: admin check, JSON body, result to status.
export async function adminRoute(req: Request, fn: (db: Db, body: any) => Promise<AdminResult<object> | unknown>): Promise<Response> {
  const a = await requireAdmin(req);
  if ('res' in a) return a.res;
  const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
  const out: any = await fn(await getServerDb(), body ?? {});
  if (out && typeof out === 'object' && 'ok' in out && out.ok === false) return Response.json({ error: out.error }, { status: out.status });
  return Response.json(out);
}
