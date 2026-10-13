import { requireUser } from '@/lib/server/session';

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return new Response(null, { status: 401, headers: { date: new Date().toUTCString() } });
  return Response.json({ id: user.id, email: user.email, role: user.role, workspaceIds: user.workspaceIds }, { headers: { date: new Date().toUTCString() } });
}
