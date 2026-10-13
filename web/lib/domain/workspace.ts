// Ported from qa-app/js/workspace.js (WorkspaceCalc only; picker UI stays in the UI layer).
// Rows come from the DB layer as loose records until Phase 3 types them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

export const WorkspaceCalc = {
  ALL: '__all__', // admin-only choice: every workspace at once (no filtering)
  ALL_COLOR: ['#EEF0F4', '#4B5563'],
  DONE_BUG_STATUSES: ['CLOSED', 'REJECTED'],
  COLORS: [['#EEEDFE', '#3C3489'], ['#E1F5EE', '#085041'], ['#E6F1FB', '#0C447C'], ['#FAEEDA', '#633806'], ['#FBEAF0', '#72243E']],

  // Legacy accounts have a single workspaceId; new ones a workspaceIds array.
  userWorkspaceIds(user?: Rec | null): string[]{
    if (!user) return [];
    if (Array.isArray(user.workspaceIds)) return user.workspaceIds.filter(Boolean);
    return user.workspaceId ? [user.workspaceId] : [];
  },

  colorFor(workspaces: Rec[] | undefined, id: string){
    if (id === this.ALL) return this.ALL_COLOR;
    const i = Math.max(0, (workspaces || []).findIndex((w: Rec) => w.id === id));
    return this.COLORS[i % this.COLORS.length];
  },

  initials(name?: string){
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
  },

  /* Which workspace to open without showing the picker, or null to show it.
     '' = the account has no workspace (sees shared/legacy files only). */
  autoEnter(ids: string[], pref: { autoOpen?: boolean; last?: string; [legacy: string]: unknown } = {}){
    if (!ids.length) return '';
    if (ids.length === 1) return ids[0];
    if (pref.autoOpen && ids.includes(pref.last as string)) return pref.last as string;
    return null;
  },

  cards({ workspaces = [], ids = [], files = [], testcases = [], bugs = [], visits = {} }: { workspaces?: Rec[]; ids?: string[]; files?: Rec[]; testcases?: Rec[]; bugs?: Rec[]; visits?: Record<string, string> }){
    const lastId = Object.entries(visits).filter(([id]) => ids.includes(id)).sort((a, b) => b[1].localeCompare(a[1]))[0]?.[0];
    const all = { id: this.ALL, name: 'Semua workspace' };
    return ids.map(id => id === this.ALL ? all : workspaces.find(w => w.id === id)).filter((w): w is Rec => Boolean(w)).map(w => {
      const own = w.id === this.ALL ? files : files.filter(f => f.workspaceId === w.id);
      const fileIds = new Set(own.map(f => f.id));
      const latestFile = own.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
      return {
        id: w.id, name: w.name, initials: w.id === this.ALL ? 'ALL' : this.initials(w.name), color: this.colorFor(workspaces, w.id),
        files: own.length,
        testcases: testcases.filter(t => fileIds.has(t.fileId)).length,
        openBugs: bugs.filter(b => fileIds.has(b.fileId) && !this.DONE_BUG_STATUSES.includes(b.status)).length,
        lastOpened: visits[w.id] || null,
        isLast: w.id === lastId,
        latestFile: latestFile ? { name: latestFile.name, at: latestFile.createdAt } : null
      };
    });
  },

  /* Shared bug link (#bug=<id>): which workspace to activate so the bug's file
     is visible. Prefers staying in the active workspace when it already sees
     the file. Returns a workspace id, '' (no switch needed — shared file for a
     workspace-less user), or null = this account has no access. */
  workspaceForFile(file: Rec | null | undefined, ids: string[], isAdmin: boolean, active?: string){
    if (!file) return null;
    const sees = (ws: string) => (isAdmin && ws === this.ALL) || !file.workspaceId || file.workspaceId === ws || (file.sharedWith || []).includes(ws);
    if (active && (isAdmin || ids.includes(active)) && sees(active)) return active;
    if (file.workspaceId && ids.includes(file.workspaceId)) return file.workspaceId;
    const viaShare = ids.find((ws: string) => ws !== this.ALL && sees(ws));
    if (viaShare) return viaShare;
    if (!file.workspaceId) return active || '';
    return isAdmin ? file.workspaceId : null;
  },

  timeAgo(iso?: string, now = Date.now()){
    if (!iso) return '';
    const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
    if (min < 1) return 'baru saja';
    if (min < 60) return `${min} menit lalu`;
    if (min < 60 * 24) return `${Math.round(min / 60)} jam lalu`;
    return `${Math.round(min / 1440)} hari lalu`;
  }
};
