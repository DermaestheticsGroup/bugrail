import { adminRoute } from '@/lib/server/admin-http';
import { deleteUser, updateUser } from '@/lib/server/admin';

type Ctx = { params: Promise<{ id: string }> };
export const PATCH = async (req: Request, { params }: Ctx) => { const { id } = await params; return adminRoute(req, (db, b) => updateUser(db, id, b)); };
export const DELETE = async (req: Request, { params }: Ctx) => { const { id } = await params; return adminRoute(req, (db) => deleteUser(db, id)); };
