import { NextResponse, type NextRequest } from 'next/server';

// Optional HTTP Basic Auth in front of the whole app (e.g. a Vercel preview); off unless both env vars are set.
export function basicAuthOk(header: string | null, user = process.env.BASIC_AUTH_USER, pass = process.env.BASIC_AUTH_PASSWORD): boolean {
  if (!user || !pass) return true;
  if (!header?.startsWith('Basic ')) return false;
  return atob(header.slice(6)) === `${user}:${pass}`;
}

const PAGE_PUBLIC = /^\/(api|login)(\/|$)|^\/(_next|sw\.js|favicon\.ico)|\.[\w]+$/;

// Redirects anonymous page loads to /login. Only checks that a session cookie exists: every route handler
// still verifies it through requireUser(), so this is a convenience, not the security boundary.
export function proxy(req: NextRequest) {
  if (!basicAuthOk(req.headers.get('authorization'))) {
    return new NextResponse('Authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="bugrail"' } });
  }
  if (PAGE_PUBLIC.test(req.nextUrl.pathname) || req.cookies.has('bugrail_session')) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  // Everything except Next build assets, so basic auth also covers /api and /login.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
