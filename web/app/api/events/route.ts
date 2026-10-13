import { requireUser } from '@/lib/server/session';
import { subscribe } from '@/lib/server/events';

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return new Response(null, { status: 401 });
  const enc = new TextEncoder();
  let off = () => {}, ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(c) {
      const send = (chunk: string) => { try { c.enqueue(enc.encode(chunk)); } catch { /* closed */ } };
      send(': open\n\n');
      off = subscribe(user.role === 'admin', user.workspaceIds, () => send('event: sync\ndata: {}\n\n'));
      ping = setInterval(() => send(': ping\n\n'), 25_000);
      req.signal.addEventListener('abort', () => { off(); clearInterval(ping); try { c.close(); } catch { /* closed */ } });
    },
    cancel() { off(); clearInterval(ping); },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
  });
}
