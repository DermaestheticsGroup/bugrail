"use client";

// Minimal login form; the full shell lands in Phase 5. Without JavaScript it posts form-encoded and the route redirects.
export default function Login() {
  return (
    <form method="post" action="/api/auth/login" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
      if (res.ok) location.href = '/';
      else alert(res.status === 429 ? 'Too many attempts, try later.' : 'Wrong email or password.');
    }}>
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Password" required />
      <button type="submit">Log in</button>
    </form>
  );
}
