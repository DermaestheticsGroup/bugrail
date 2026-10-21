// Backend-for-frontend proxy for Turso Sync: the browser's local database syncs
// through here so the Turso auth token never leaves the server. Signed-in BugRail users only.
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/session";

// Turso sync endpoints the client may reach; anything else (e.g. the SQL pipeline) is not proxied. Unverified against the sync-wasm wire protocol: widen if sync 404s.
const ALLOWED = new Set(["info", "export", "sync", "v2", "v3"]);

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: Ctx) {
  if (!(await requireUser(req))) return new Response("unauthorized", { status: 401 });
  const remote = process.env.REWIND_TURSO_DATABASE_URL;
  if (!remote) return new Response("sync not configured", { status: 503 });
  const { path } = await ctx.params;
  if (!ALLOWED.has(path[0]) || path.some((s) => s === "." || s === ".." || /[\/\\]/.test(s))) {
    return new Response("invalid path", { status: 400 });
  }
  if (process.env.REWIND_TURSO_AUTH_TOKEN && /^http:\/\//i.test(remote)) {
    return new Response("sync misconfigured: remote must be https", { status: 500 });
  }
  const base = remote.replace(/^(libsql|turso):\/\//, "https://");
  const headers = new Headers();
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (process.env.REWIND_TURSO_AUTH_TOKEN) headers.set("authorization", `Bearer ${process.env.REWIND_TURSO_AUTH_TOKEN}`);
  let res: Response;
  try {
    res = await fetch(`${base}/${path.join("/")}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    return new Response("upstream unavailable", { status: 502 });
  }
  const out = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) out.set("content-type", ct);
  out.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
