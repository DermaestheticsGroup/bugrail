// Next display number in a scope = highest number among the codes passed + 1. Codes the caller omits are free;
// the server passes tombstoned codes too, so a revived bug keeps its number. Gaps stay (people refer to these numbers).
export function nextInScope(prefix: string, codesInScope: (string | null)[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = codesInScope.reduce((m, c) => {
    const hit = String(c ?? '').match(re);
    return hit ? Math.max(m, parseInt(hit[1], 10)) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
