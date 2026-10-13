import { adminRoute } from '@/lib/server/admin-http';
import { createWorkspace, listWorkspaces } from '@/lib/server/admin';

export const GET = (req: Request) => adminRoute(req, (db) => listWorkspaces(db));
export const POST = (req: Request) => adminRoute(req, (db, b) => createWorkspace(db, b.name));
