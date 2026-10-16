// Stroke icons in Rewind's sidebar style (16px, 2px stroke), one per nav slug.
const PATHS: Record<string, string> = {
  dashboard: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  testcases: 'M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12l2 2 4-4',
  bugs: 'M8 8a4 4 0 0 1 8 0v1H8zM6 9h12v5a6 6 0 0 1-12 0zM12 9v11M3 13h3M18 13h3M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2',
  summary: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
  report: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  'import-export': 'M7 4v12M3 12l4 4 4-4M17 20V8M13 12l4-4 4 4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  'master/status': 'M4 6h16M4 12h10M4 18h6',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3',
  roles: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  workspaces: 'M3 7h18v13H3zM8 7V4h8v3',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
  rewind: 'M11 5L3 12l8 7zM21 5l-8 7 8 7z',
};

export default function NavIcon({ slug }: { slug: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[slug] ?? PATHS.summary} />
    </svg>
  );
}
