import { aiRoute } from '@/lib/server/ai-http';
import { generateTestCases } from '@/lib/server/ai';

export const POST = (req: Request) => aiRoute(req, generateTestCases);
