"use client";
// Wires the design's state machine to Next.js routing and the local-first Turso database.
// UI state is the in-memory projection; every mutation lands in it first (instant), then
// in the local DB, then syncs to Turso Cloud in the background when online.
import { usePathname, useRouter } from "next/navigation";
import { useOffline } from "next/offline";
import { useEffect, useState } from "react";
import { RewindLogic, PERSIST } from "./logic";
import { JAMS, COMMENTS } from "./seed";
import type { LocalDb, Snapshot } from "@/lib/rewind/local-db";

// "dark" is not stored here: BugRail's theme (qa_theme, html[data-theme]) is the one source of truth.
const KV_KEYS = [...PERSIST, "links", "tokens", "tg", "connected", "avatar", "wsLogos", "view"];
const SYNC_MS = 4000;
// Rewind is mounted under /rewind inside BugRail; every route below is relative to it.
export const BASE = "/rewind";
// Rewind's sidebar gets one extra item that returns to BugRail (the logic's `nav` is data, so no template change).
const BUGRAIL_ICON = "M15 6l-6 6 6 6M9 12h11";

type Route = { route: string; sel?: string; stab?: string };
export function routeFromPath(p: string): Route {
  const [a, b] = p.slice(p.startsWith(BASE) ? BASE.length : 0).split("/").filter(Boolean);
  if (a === "r" && b) return { route: "viewer", sel: b };
  if (a === "settings") return { route: "settings", stab: b || "general" };
  if (a === "links" || a === "helpdesk") return { route: a };
  return { route: "all" };
}
export function pathFromState(s: Route) {
  if (s.route === "viewer") return BASE + "/r/" + s.sel;
  if (s.route === "settings") return BASE + "/settings/" + s.stab;
  if (s.route === "links" || s.route === "helpdesk") return BASE + "/" + s.route;
  return BASE;
}

type Props = { pathname: string; router: ReturnType<typeof useRouter>; syncEnabled: boolean; offline: boolean; darkMode: boolean; showBrowserChrome?: boolean };

class Rewind extends RewindLogic {
  declare props: Props;
  declare state: any;
  db: LocalDb | null = null;
  saved: Snapshot | null = null;
  pending: string | null = null;
  saving: Promise<unknown> = Promise.resolve();
  syncT: ReturnType<typeof setInterval> | undefined;
  dead = false;

  constructor(props: Props) {
    super(props);
    const r = routeFromPath(props.pathname);
    this.state = { ...this.state, ...r, jams: JAMS.map((j) => ({ ...j })), comments: COMMENTS };
  }

  snapshot(s = this.state): Snapshot {
    return { jams: s.jams, comments: s.comments, kv: Object.fromEntries(KV_KEYS.map((k) => [k, s[k]])) };
  }

  async componentDidMount() {
    super.componentDidMount();
    for (const p of ["", "/links", "/helpdesk", "/settings/general"]) this.props.router.prefetch(BASE + p);
    try {
      const { openLocalDb, seedIfEmpty, saveDiff } = await import("@/lib/rewind/local-db");
      const initial = this.snapshot();
      const db = await openLocalDb(this.props.syncEnabled);
      if (this.dead) return db.close();
      if (this.props.syncEnabled && navigator.onLine) await db.pull().catch(() => {});
      await seedIfEmpty(db, initial);
      // edits made while the DB was opening are replayed as a diff, not lost
      await saveDiff(db, initial, this.snapshot());
      if (this.dead) return db.close();
      this.db = db;
      await this.reload();
      if (this.dead) return;
      document.documentElement.dataset.db = "ready";
      if (this.props.syncEnabled) this.syncT = setInterval(() => this.sync(), SYNC_MS);
    } catch (e) {
      console.warn("rewind: local database unavailable, running in memory", e);
    }
  }

  componentWillUnmount() {
    super.componentWillUnmount();
    this.dead = true;
    clearInterval(this.syncT);
    this.db?.close();
  }

  private saveSeq?: number;

  async reload() {
    if (!this.db) return;
    const snap = await (await import("@/lib/rewind/local-db")).loadSnapshot(this.db);
    this.saved = snap;
    const kv = Object.fromEntries(Object.entries(snap.kv).filter(([k, v]) => KV_KEYS.includes(k) && v != null));
    this.setState({ jams: snap.jams, comments: snap.comments, ...kv });
  }

  async sync() {
    const db = this.db;
    if (!db || this.props.offline || !navigator.onLine) return;
    try {
      await this.saving;
      await db.push();
      if (await db.pull()) await this.reload();
    } catch {
      // network dropped mid-sync; local rows stay queued for the next tick
    }
  }

  renderVals() {
    const v = super.renderVals();
    const back = { label: "BugRail", d: BUGRAIL_ICON, bg: "transparent", fg: "var(--rw-body)", fw: "500", onClick: () => this.props.router.push("/") };
    return { ...v, nav: [...v.nav, back] };
  }

  componentDidUpdate(pp: Props, ps: any) {
    super.componentDidUpdate(pp, ps);
    const s = this.state;

    // Rewind's own theme switch writes BugRail's theme, so both halves of the app stay on one theme.
    if (ps.dark !== s.dark) {
      try { localStorage.setItem("qa_theme", s.dark ? "dark" : "light"); } catch { /* private mode: this page only */ }
      document.documentElement.dataset.theme = s.dark ? "dark" : "light";
    }

    // URL <-> state: in-app navigation pushes a route, back/forward restores state
    if (pp.pathname !== this.props.pathname) {
      if (this.props.pathname === this.pending) this.pending = null;
      else {
        const r = routeFromPath(this.props.pathname);
        if (pathFromState({ ...s, ...r }) !== pathFromState(s)) this.setState({ ...r, ...(r.route === "viewer" ? { t: 0, playing: false } : {}) });
      }
    } else {
      const path = pathFromState(s);
      if (path !== this.props.pathname && path !== this.pending) {
        this.pending = path;
        this.props.router.push(path, { scroll: false });
      }
    }

    // reconnect: flush queued local writes right away
    if (pp.offline && !this.props.offline) this.sync();

    if (this.db && this.saved) {
      const next = this.snapshot();
      const prev = this.saved;
      const changed = next.jams !== prev.jams || next.comments !== prev.comments || KV_KEYS.some((k) => next.kv[k] !== prev.kv[k]);
      if (changed) {
        this.saved = next;
        const db = this.db;
        // html[data-saving] is set while a local write is pending; the browser check polls it instead of sleeping
        document.documentElement.dataset.saving = "1";
        const mine = (this.saveSeq = (this.saveSeq ?? 0) + 1);
        this.saving = this.saving
          .then(async () => {
            const { saveDiff } = await import("@/lib/rewind/local-db");
            if ((await saveDiff(db, prev, next)) && this.props.syncEnabled && !this.props.offline) db.push().catch(() => {});
          })
          .catch((e) => console.warn("rewind: local write failed", e))
          .then(() => { if (this.saveSeq === mine) delete document.documentElement.dataset.saving; });
      }
    }
  }
}

// BugRail's root layout registers the service worker and restores html[data-theme] before paint.
export function RewindApp({ syncEnabled }: { syncEnabled: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const offline = useOffline();
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => setDarkMode(document.documentElement.dataset.theme === "dark"), []);
  return <Rewind pathname={pathname} router={router} syncEnabled={syncEnabled} offline={offline} darkMode={darkMode} showBrowserChrome={false} />;
}
