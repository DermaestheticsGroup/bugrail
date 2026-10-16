import "server-only";
import { createClient } from "@libsql/client";

export const remoteDb = () =>
  process.env.REWIND_TURSO_DATABASE_URL
    ? createClient({ url: process.env.REWIND_TURSO_DATABASE_URL, authToken: process.env.REWIND_TURSO_AUTH_TOKEN })
    : null;
