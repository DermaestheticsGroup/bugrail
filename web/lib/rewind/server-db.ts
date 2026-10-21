import "server-only";
import { createClient } from "@libsql/client";

let client: ReturnType<typeof createClient> | null | undefined;
export const remoteDb = () => {
  if (client === undefined) {
    client = process.env.REWIND_TURSO_DATABASE_URL
      ? createClient({ url: process.env.REWIND_TURSO_DATABASE_URL, authToken: process.env.REWIND_TURSO_AUTH_TOKEN })
      : null;
  }
  return client;
};
