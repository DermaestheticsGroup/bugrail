import { expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

mock.module("@/lib/server/session", () => ({ requireUser: async () => ({ id: 1 }) }));
process.env.REWIND_TURSO_DATABASE_URL = "libsql://example.invalid";

const { POST } = await import("../app/api/rewind/sync/[...path]/route");
const call = (path: string[]) =>
  POST(new NextRequest(`http://localhost/api/rewind/sync/${path.join("/")}`, { method: "POST" }), { params: Promise.resolve({ path }) });

test("sync proxy rejects the SQL pipeline endpoints", async () => {
  for (const p of [["v2", "pipeline"], ["v3", "pipeline"], ["v3", "cursor"], ["info", "..", "v3", "pipeline"]]) {
    expect((await call(p)).status).toBe(400);
  }
});
