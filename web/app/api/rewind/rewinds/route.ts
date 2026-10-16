// Server read of the synced Rewinds (for integrations, e.g. the MCP/CLI surfaces in Settings). Signed-in BugRail users only.
import { remoteDb } from "@/lib/rewind/server-db";
import { requireUser } from "@/lib/server/session";

export async function GET(req: Request) {
  if (!(await requireUser(req))) return new Response("unauthorized", { status: 401 });
  const db = remoteDb();
  if (!db) return Response.json({ error: "database not configured" }, { status: 503 });
  const { rows } = await db.execute("SELECT data FROM jams ORDER BY position");
  return Response.json(rows.map((r) => JSON.parse(String(r.data))));
}
