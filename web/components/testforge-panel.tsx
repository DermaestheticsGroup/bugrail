'use client';
// TestForge: pick fields, give a source (BRS text, screenshots or free text), review the staged rows, save them all. Online only.
import { useState } from 'react';
import { MAX_IMAGES, TESTFORGE_FIELDS, generate, saveStaged, validateGenerate, type Staged } from '@/lib/client/ai-tools';
import { useApp } from './app-provider';

const readImage = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(new Error('Gagal membaca gambar.')); r.readAsDataURL(f); });

export default function TestforgePanel({ fileId, onClose, onSaved }: { fileId: string; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const [step, setStep] = useState<'template' | 'generate' | 'review'>('template');
  const [mode, setMode] = useState<'brs' | 'screenshot' | 'text'>('brs');
  const [fields, setFields] = useState<string[]>(TESTFORGE_FIELDS.map((f) => f.key));
  const [content, setContent] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const guard = async (fn: () => Promise<void>) => { setErr(null); setBusy(true); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };

  const addImages = (files: FileList | null) => guard(async () => {
    const next = [...images];
    for (const f of Array.from(files ?? [])) {
      if (next.length >= MAX_IMAGES) throw new Error(`Maksimal ${MAX_IMAGES} screenshot per generate.`);
      next.push(await readImage(f));
    }
    setImages(next);
  });
  const gen = () => guard(async () => { setStaged(await generate({ mode, content, images, fields })); setStep('review'); });
  const save = () => guard(async () => { await saveStaged(app.ctx!, fileId, staged); onSaved(); });
  const edit = (i: number, key: string, v: string) => setStaged((cur) => cur.map((t, j) => (j === i ? { ...t, [key]: v } : t)));

  return (
    <dialog open aria-label="TestForge">
      <h3>Generate Test Case dengan AI</h3>
      {err ? <p role="alert" data-testid="tf-error">{err}</p> : null}
      {step === 'template' ? (
        <div>
          <p>Pilih field yang mau di-generate AI:</p>
          {TESTFORGE_FIELDS.map((f) => (
            <label key={f.key}><input type="checkbox" checked={fields.includes(f.key)} onChange={(e) => setFields(e.target.checked ? [...fields, f.key] : fields.filter((x) => x !== f.key))} />{f.label}</label>
          ))}
          <p><button type="button" onClick={onClose}>Batal</button> <button type="button" disabled={!fields.length} onClick={() => setStep('generate')}>Lanjut</button></p>
        </div>
      ) : null}
      {step === 'generate' ? (
        <div>
          <p>{(['brs', 'screenshot', 'text'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'brs' ? 'BRS' : m === 'text' ? 'Free Text' : 'Screenshot'}</button>)}</p>
          {mode === 'screenshot' ? (
            <div>
              <input type="file" aria-label="Screenshots" accept="image/*" multiple onChange={(e) => { void addImages(e.target.files); e.target.value = ''; }} />
              <p data-testid="tf-images">{images.length} gambar</p>
              {images.map((src, i) => <span key={i}><img src={src} alt={`Screenshot ${i + 1}`} width={60} /><button type="button" onClick={() => setImages(images.filter((_, j) => j !== i))}>Hapus</button></span>)}
            </div>
          ) : null}
          <textarea aria-label="Content" rows={mode === 'screenshot' ? 3 : 8} value={content} placeholder={mode === 'brs' ? 'Paste BRS text di sini...' : mode === 'text' ? 'Jelaskan fitur/skenario yang mau di-generate...' : 'Instruksi tambahan (opsional)...'} onChange={(e) => setContent(e.target.value)} />
          <p>
            <button type="button" onClick={() => setStep('template')}>Kembali</button>{' '}
            <button type="button" disabled={busy || !app.sync.online || !!validateGenerate({ mode, content, images, fields })} onClick={() => void gen()}>{busy ? 'Generating...' : app.sync.online ? 'Generate' : 'Perlu koneksi'}</button>
          </p>
        </div>
      ) : null}
      {step === 'review' ? (
        <div>
          {staged.length === 0 ? <p>Tidak ada hasil generate.</p> : staged.map((t, i) => (
            <fieldset key={i} data-testid="tf-staged">
              <legend>#{i + 1} <button type="button" onClick={() => setStaged(staged.filter((_, j) => j !== i))}>Hapus</button></legend>
              {fields.map((k) => (
                <label key={k}>{TESTFORGE_FIELDS.find((f) => f.key === k)?.label}<textarea aria-label={`${i + 1} ${k}`} rows={k === 'steps' || k === 'testCase' ? 3 : 1} value={t[k] ?? ''} onChange={(e) => edit(i, k, e.target.value)} /></label>
              ))}
            </fieldset>
          ))}
          <p>
            <button type="button" onClick={() => setStep('generate')}>Generate Ulang</button>{' '}
            <button type="button" disabled={busy || !staged.length} onClick={() => void save()}>Simpan Semua ke Test Case</button>
          </p>
        </div>
      ) : null}
    </dialog>
  );
}
