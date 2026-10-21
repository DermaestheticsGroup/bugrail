import { expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

mock.module("@/lib/server/session", () => ({ requireUser: async () => ({ id: 1 }) }));
process.env.REWIND_TURSO_DATABASE_URL = "libsql://example.invalid";

const { POST } = await import("../app/api/rewind/sync/[...path]/route");
const call = (path: string[]) =>
  POST(new NextRequest(`http://localhost/api/rewind/sync/${path.join("/")}`, { method: "POST" }), { params: Promise.resolve({ path }) });

test("sync proxy rejects the SQL pipeline endpoints", async () => {
  for (const p of [["v2", "pipeline"], ["v3", "pipeline"], ["v3", "cursor"], ["info", "..", "v3", "pipeline"], ["info", "%2e%2e", "v3", "pipeline"], ["%2e%2e"], ["info", "%252e%252e"], ["info%2f..%2fv3"]]) {
    expect((await call(p)).status).toBe(400);
  }
});

test("sync proxy never forwards a request that normalizes to a pipeline path", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => { seen.push(String(u)); return new Response("{}"); }) as unknown as typeof fetch;
  try {
    for (const p of [["info", "%2e%2e", "v3", "pipeline"], ["info", "%252e%252e"]]) await call(p);
    for (const p of [["info"], ["push"], ["pull-updates"]]) expect((await call(p)).status).toBe(200);
  } finally { globalThis.fetch = real; }
  expect(seen.map((u) => new URL(u).pathname)).toEqual(["/info", "/push", "/pull-updates"]);
});
