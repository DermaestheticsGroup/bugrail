import { adminRoute } from '@/lib/server/admin-http';
import { deleteWorkspace, renameWorkspace } from '@/lib/server/admin';

type Ctx = { params: Promise<{ id: string }> };
export const PATCH = async (req: Request, { params }: Ctx) => { const { id } = await params; return adminRoute(req, (db, b) => renameWorkspace(db, id, b.name)); };
export const DELETE = async (req: Request, { params }: Ctx) => { const { id } = await params; return adminRoute(req, (db) => deleteWorkspace(db, id)); };
