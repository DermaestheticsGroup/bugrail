import ScreenHost from '@/components/screen-host';

// One thin server page for every screen: the client reads the path, so the document is identical for all of them.
export default function Page() {
  return <ScreenHost />;
}
