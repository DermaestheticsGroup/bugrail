import { escapeHtml } from './html';

/* Plain-text "Test Step" cell from an import into Steps HTML. If most lines start
   with a number ("1.", "2)"), it becomes a real <ol>. */
export function textToStepsHtml(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) return text; // already HTML (e.g. re-imported export)
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const numberedRe = /^\d+[.)]\s*/;
  const numbered = lines.filter(l => numberedRe.test(l)).length;
  if (numbered >= Math.ceil(lines.length * 0.6)) {
    return '<ol>' + lines.map(l => `<li>${escapeHtml(l.replace(numberedRe, ''))}</li>`).join('') + '</ol>';
  }
  return lines.map(l => `<p>${escapeHtml(l)}</p>`).join('');
}

const unescape = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/* Reverse of textToStepsHtml, for export: lists are re-numbered as plain text lines.
   shortcut: regex, not a DOM walk (server and tests have no DOM); upgrade if nested lists must export. */
export function stepsHtmlToText(html?: string | null): string {
  if (!html) return '';
  const numbered = html.replace(/<(ol|ul)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
    let i = 0;
    return inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_l, body: string) => {
      i += 1;
      return `<li>${tag.toLowerCase() === 'ol' ? `${i}. ` : '- '}${body}</li>`;
    });
  });
  const text = numbered.replace(/<\/(p|li)>|<br\s*\/?>/gi, '$&\n').replace(/<[^>]*>/g, '');
  return unescape(text).replace(/\n{2,}/g, '\n').trim();
}

const ID_STOPWORDS = ['yang', 'dan', 'atau', 'tidak', 'untuk', 'dengan', 'adalah', 'ini', 'itu', 'pada', 'akan', 'dari', 'ke', 'di', 'sudah', 'belum', 'harus', 'bisa', 'dapat', 'maka'];
const EN_STOPWORDS = ['the', 'and', 'or', 'not', 'for', 'with', 'is', 'are', 'this', 'that', 'on', 'will', 'from', 'to', 'in', 'already', 'must', 'can', 'should', 'then'];

/* Heuristic ID/EN detection via stopword counting, to pick a translate direction. */
export function detectLang(text?: string | null): 'en' | 'id' {
  const words = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
  let idScore = 0, enScore = 0;
  words.forEach(w => { if (ID_STOPWORDS.includes(w)) idScore++; if (EN_STOPWORDS.includes(w)) enScore++; });
  return enScore > idScore ? 'en' : 'id';
}
