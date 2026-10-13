import { adminRoute } from '@/lib/server/admin-http';
import { createUser, listUsers } from '@/lib/server/admin';

export const GET = (req: Request) => adminRoute(req, (db) => listUsers(db));
export const POST = (req: Request) => adminRoute(req, (db, b) => createUser(db, b));
