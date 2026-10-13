"use client";

import { prepareLoginFor } from '@/components/app-provider';
import { clearSnapshot, fetchConfig, saveConfig, saveSnapshot } from '@/lib/client/boot';

// Minimal login form; the full shell lands in Phase 5. Without JavaScript it posts form-encoded and the route redirects.
export default function Login() {
  return (
    <form method="post" action="/api/auth/login" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
      if (res.ok) {
        const { userId } = await res.json();
        // A different user on this device: drop the previous user's local data first (warns if it holds unsent changes).
        if (!(await prepareLoginFor(userId))) { await fetch('/api/auth/logout', { method: 'POST' }); return; }
        // Never leave the previous user's snapshot behind: it would send this browser into their workspace.
        clearSnapshot();
        const r = await fetchConfig();
        if (r.kind !== 'ok') { await fetch('/api/auth/logout', { method: 'POST' }); alert('Signed in, but the server could not be reached to load your workspace. Try again.'); return; }
        saveConfig(r.config); saveSnapshot(r.config.me);
        location.href = '/';
      } else alert(res.status === 429 ? 'Too many attempts, try later.' : 'Wrong email or password.');
    }}>
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Password" required />
      <button type="submit">Log in</button>
    </form>
  );
}
