import { Suspense } from 'react';
import AppProvider from '@/components/app-provider';

// The provider lives in the layout, so soft navigation between screens keeps the database open and the sync engine running.
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <AppProvider>{children}</AppProvider>
    </Suspense>
  );
}
