// Node cannot resolve the extensionless imports in lib/; this hook retries them with .ts, then runs the smoke.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && spec.startsWith('.')) return next(spec + '.ts', ctx);
    throw e;
  }
}`));
await import('./smoke-node.ts');
