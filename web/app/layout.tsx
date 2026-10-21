import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import './styles/ds.css';
import './styles/rewind.css';
import './globals.css';
import './print.css';
import SwRegister from './sw-register';

// Restores the Settings theme (qa_theme) before first paint; styles/rewind.css swaps the --rw-* tokens on html[data-theme=dark].
const themeScript = "try{document.documentElement.dataset.theme=localStorage.getItem('qa_theme')||'light'}catch(e){}";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
