import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <h1>BugRail G0 spike</h1>
      <nav>
        <Link href="/opfs">OPFS checks</Link> · <Link href="/other">Other page</Link>
      </nav>
    </main>
  );
}
