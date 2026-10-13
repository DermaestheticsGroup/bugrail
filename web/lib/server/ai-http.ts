import { getServerDb } from '../server-db';
import { rateLimited } from './rate-limit';
import { requireUser } from './session';
import { askGemini, type AiResult } from './ai';

// Gemini key: `secrets` first, then env. The request body never carries it.
export async function aiRoute(req: Request, fn: (body: any, key: string | undefined, ask: typeof askGemini) => Promise<AiResult>): Promise<Response> {
  const user = await requireUser(req);
  if (!user) return new Response(null, { status: 401 });
  // Legacy limit: 10 requests per 5 minutes, shared by both AI routes.
  if (rateLimited(`ai:${user.id}`, 10, 5 * 60_000)) return Response.json({ error: 'Too many requests, coba lagi nanti.' }, { status: 429 });
  const body = await req.json().catch(() => null);
  const row = await (await getServerDb()).get("SELECT value FROM secrets WHERE key = 'gemini_api_key'");
  try {
    const r = await fn(body, row?.value || process.env.GEMINI_API_KEY || undefined, askGemini);
    return Response.json(r.body, { status: r.status });
  } catch (err) {
    console.error('AI route failed', err);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}
