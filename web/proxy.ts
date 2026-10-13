import { NextResponse, type NextRequest } from 'next/server';

// Redirects anonymous page loads to /login. Only checks that a session cookie exists: every route handler
// still verifies it through requireUser(), so this is a convenience, not the security boundary.
export function proxy(req: NextRequest) {
  if (req.cookies.has('bugrail_session')) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  // Not /api, /login, Next internals, the service worker, wasm or other static files.
  matcher: ['/((?!api|login|_next|sw\\.js|favicon\\.ico|.*\\.[\\w]+$).*)'],
};
