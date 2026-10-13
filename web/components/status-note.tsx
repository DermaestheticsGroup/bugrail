'use client';
import { useCallback, useRef, useState } from 'react';
import type { StatusChange } from '@/lib/client/bugs';

const urlsOk = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean).every((l) => { try { return /^https?:$/.test(new URL(l).protocol); } catch { return false; } });

// The reason (required) and optional attachment links a status change asks for. `ask` resolves null when cancelled.
export function useStatusNote(): { dialog: React.ReactNode; ask: (label: string) => Promise<StatusChange | null> } {
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [links, setLinks] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const resolver = useRef<((v: StatusChange | null) => void) | null>(null);

  const ask = useCallback((label: string) => new Promise<StatusChange | null>((resolve) => {
    resolver.current?.(null); // a second request supersedes an unanswered one
    resolver.current = resolve;
    setNote(''); setLinks(''); setErr(null); setOpen(label);
  }), []);
  const done = (v: StatusChange | null) => { resolver.current?.(v); resolver.current = null; setOpen(null); };

  const dialog = open === null ? null : (
    <form role="dialog" aria-label="Status change" data-modal-open="status-note" onSubmit={(e) => {
      e.preventDefault();
      if (!note.trim()) { setErr('Keterangan wajib diisi.'); return; }
      if (!urlsOk(links)) { setErr('Attachment harus berupa URL http/https, satu per baris.'); return; }
      done({ note: note.trim(), attachment: links.trim() });
    }}>
      <p><strong>{open}</strong></p>
      <label>Keterangan (wajib) <textarea aria-label="Status note" value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
      <label>Attachment (opsional, URL per baris) <textarea aria-label="Status attachments" value={links} onChange={(e) => setLinks(e.target.value)} /></label>
      {err ? <p role="alert">{err}</p> : null}
      <button type="submit">Ubah status</button> <button type="button" onClick={() => done(null)}>Batal</button>
    </form>
  );
  return { dialog, ask };
}
