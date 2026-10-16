import type { Metadata } from "next";
import { Suspense } from "react";
import "@fontsource/poppins/300.css";
import "@fontsource/instrument-serif";
import "./_app/hover.css";
import { RewindApp } from "./_app/app";

export const metadata: Metadata = { title: "Rewind · BugRail", description: "Record, share and debug bugs with full context." };

// The app lives in the layout so it persists across routes: URL changes only swap the
// (empty) page segment, while the client app + local DB render every view instantly.
// Sign-in is BugRail's: proxy.ts sends anonymous loads to /login, and the APIs require a session.
export default function RewindLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<div style={{ height: "100vh", background: "var(--rw-frame)" }} />}>
        <RewindApp syncEnabled={!!process.env.REWIND_TURSO_DATABASE_URL} />
      </Suspense>
      {children}
    </>
  );
}
