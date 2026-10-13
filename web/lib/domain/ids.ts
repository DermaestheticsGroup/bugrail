// Display codes. `id` is the internal unique key, `code` is the BUG-0001 number people see.
export const bugCode = (b?: { code?: string; id?: string } | null): string => (b && (b.code || b.id)) || '';
export const tcCode = bugCode;

export const IdGen = {
  /* Next display number in a workspace = highest number still in use there + 1.
     Computed from live data (no stored counter), so deleting rows frees their
     numbers. Gaps in the middle stay (nothing is renumbered). */
  nextInScope(prefix: string, codesInScope: string[] | null | undefined): string {
    // Module prefixes can hold regex metacharacters ("C++"); match them literally.
    const literalPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${literalPrefix}-(\\d+)$`);
    const max = (codesInScope || []).reduce((m, c) => {
      const hit = String(c).match(re);
      return hit ? Math.max(m, parseInt(hit[1], 10)) : m;
    }, 0);
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
  },
  uid(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  },
};

/* Abbreviates a Module name into a 3-letter Test Case ID prefix.
   "Login" -> "LOG", "User Management" -> initials "UM" + extra letters -> "UMS". */
export function moduleAbbrev(module?: string): string {
  const words = String(module || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'TC';
  const initials = words.map(w => w[0].toUpperCase());
  if (initials.length >= 3) return initials.slice(0, 3).join('');
  const extra = words.flatMap(w => w.slice(1).toUpperCase().split(''));
  return initials.concat(extra).slice(0, 3).join('').padEnd(3, 'X');
}

/* List sorting: the "id" column sorts by the number people see, and numbers
   compare naturally so LOG-0002 < LOG-0010. */
export function compareRows<R extends Record<string, unknown>>(
  a: R, b: R, sortKey: string, sortDir: 'asc' | 'desc', codeOf: (r: R) => string,
): number {
  const val = (r: R) => (sortKey === 'id' ? codeOf(r) : r[sortKey]) ?? '';
  const cmp = String(val(a)).localeCompare(String(val(b)), 'id', { numeric: true, sensitivity: 'base' });
  return sortDir === 'asc' ? cmp : -cmp;
}
