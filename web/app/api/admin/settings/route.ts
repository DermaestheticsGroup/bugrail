import { adminRoute } from '@/lib/server/admin-http';
import { setSecret } from '@/lib/server/admin';

// The Gemini key lives in `secrets`; it is never selected into a pull and never returned.
export const PUT = (req: Request) => adminRoute(req, (db, b) => setSecret(db, 'gemini_api_key', b.geminiApiKey));
