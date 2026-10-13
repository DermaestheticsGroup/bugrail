import OfflineBadge from './offline-badge';
import SwRegister from './sw-register';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OfflineBadge />
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
