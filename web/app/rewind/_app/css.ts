const cache = new Map<string, Record<string, string>>();

// Mirrors the DC runtime's cssToObj for interpolated style strings.
export function css(s: string) {
  let o = cache.get(s);
  if (o) return o;
  o = {};
  for (const decl of s.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const p = decl.slice(0, i).trim();
    o[p.startsWith("--") ? p : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  if (cache.size > 2000) cache.clear();
  cache.set(s, o);
  return o;
}

export const asList = (l: unknown): any[] => (Array.isArray(l) ? l : []);
