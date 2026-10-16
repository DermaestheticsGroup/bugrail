// Creates the schema and seeds the demo Rewinds on the remote Turso DB. Runs before `next build`.
import { createClient } from "@libsql/client";
import { SCHEMA } from "../lib/rewind/schema";
import { JAMS, COMMENTS } from "../app/rewind/_app/seed";

const url = process.env.REWIND_TURSO_DATABASE_URL;
if (!url) {
  console.log("migrate: REWIND_TURSO_DATABASE_URL not set, skipping (app runs local-only)");
  process.exit(0);
}
const db = createClient({ url, authToken: process.env.REWIND_TURSO_AUTH_TOKEN });
const now = Date.now();
await db.batch(
  [
    ...SCHEMA,
    ...JAMS.map((j, i) => ({ sql: "INSERT OR IGNORE INTO jams VALUES (?, ?, ?, ?)", args: [j.id, JSON.stringify(j), i, now] })),
    ...COMMENTS.map((c, i) => ({ sql: "INSERT OR IGNORE INTO comments VALUES (?, ?, ?, ?)", args: [c.id, JSON.stringify(c), i, now] })),
  ],
  "write",
);
console.log("migrate: schema ready");
