import { aiRoute } from '@/lib/server/ai-http';
import { analyzeBug } from '@/lib/server/ai';

export const POST = (req: Request) => aiRoute(req, analyzeBug);
