import { getServerDb } from '@/lib/server-db';
import { getSession, requireUser, userFromSession } from '@/lib/server/session';
import { subscribe } from '@/lib/server/events';

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return new Response(null, { status: 401 });
  // Snapshot the cookie session so the ping can re-check it: logout, password reset or removal must end the stream.
  const s = await getSession();
  const snap = s.userId ? { userId: s.userId, sessionVersion: s.sessionVersion } : null;
  const enc = new TextEncoder();
  let done = false;
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(c) {
      const send = (chunk: string) => { try { c.enqueue(enc.encode(chunk)); } catch { /* closed */ } };
      const off = subscribe(user.role === 'admin', user.workspaceIds, () => send('event: sync\ndata: {}\n\n'));
      const close = () => { cleanup(); try { c.close(); } catch { /* closed */ } };
      const ping = setInterval(async () => {
        if (snap && !(await userFromSession(await getServerDb(), snap))) return close();
        send(': ping\n\n');
      }, 25_000);
      // One idempotent cleanup shared by abort, cancel and a revoked session.
      cleanup = () => { if (done) return; done = true; off(); clearInterval(ping); };
      req.signal.addEventListener('abort', close);
      send(': open\n\n');
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
  });
}
