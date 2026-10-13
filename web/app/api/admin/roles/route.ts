import { adminRoute } from '@/lib/server/admin-http';
import { getPermissions, savePermissions } from '@/lib/server/admin';

export const GET = (req: Request) => adminRoute(req, (db) => getPermissions(db));
export const PUT = (req: Request) => adminRoute(req, (db, b) => savePermissions(db, b));
