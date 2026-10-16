// Backend-for-frontend proxy for Turso Sync: the browser's local database syncs
// through here so the Turso auth token never leaves the server. Signed-in BugRail users only.
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/session";

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: Ctx) {
  if (!(await requireUser(req))) return new Response("unauthorized", { status: 401 });
  const remote = process.env.REWIND_TURSO_DATABASE_URL;
  if (!remote) return new Response("sync not configured", { status: 503 });
  const { path } = await ctx.params;
  const base = remote.replace(/^(libsql|turso):\/\//, "https://");
  const headers = new Headers();
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (process.env.REWIND_TURSO_AUTH_TOKEN) headers.set("authorization", `Bearer ${process.env.REWIND_TURSO_AUTH_TOKEN}`);
  const res = await fetch(`${base}/${path.join("/")}${req.nextUrl.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    signal: req.signal,
  });
  const out = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) out.set("content-type", ct);
  out.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
