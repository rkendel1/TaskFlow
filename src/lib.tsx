/**
 * Shared frontend pieces: a hash router, the workspace data every screen uses (loaded once, live),
 * small presentational components and formatting. No business rules: the server decides.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryState, type FeltKitClientError } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

// ---------------------------------------------------------------------------------------------
// Routing: #/path?query. Filters live in the query, so they survive navigation and reloads.
// ---------------------------------------------------------------------------------------------

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/my-issues";
  const [path, query = ""] = raw.split("?");
  return { path: path!.split("/").filter(Boolean), query: new URLSearchParams(query) };
}

let cached = readRoute();
let cachedHash = window.location.hash;
const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  cached = readRoute();
  cachedHash = window.location.hash;
  listeners.forEach((l) => l());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => {
      // The hash can change without a hashchange event (history.replaceState, e.g. when FeltKit
      // clears an invitation link): re-read it, and keep returning the same object until it changes.
      if (window.location.hash !== cachedHash) {
        cachedHash = window.location.hash;
        cached = readRoute();
      }
      return cached;
    },
  );
}

export function href(path: string, query?: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

export function navigate(path: string, query?: Record<string, string | undefined | null>) {
  window.location.hash = href(path, query).slice(1);
}

/** Change some query parameters of the current route, keeping the rest. */
export function setQuery(changes: Record<string, string | null | undefined>) {
  const r = readRoute();
  const next = new URLSearchParams(r.query);
  for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
  const qs = next.toString();
  window.location.hash = `/${r.path.join("/")}${qs ? `?${qs}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Workspace data: one live load, shared by every screen.
// ---------------------------------------------------------------------------------------------

type Overview = NonNullable<ReturnType<typeof useQueryState<typeof api.workspace.overview>>["data"]>;
type Teams = NonNullable<ReturnType<typeof useQueryState<typeof api.teams.list>>["data"]>;
export type TeamInfo = Teams[number];
export type StateInfo = TeamInfo["states"][number];
type Members = NonNullable<ReturnType<typeof useQueryState<typeof api.workspace.members>>["data"]>;
export type Member = Members[number];
type Labels = NonNullable<ReturnType<typeof useQueryState<typeof api.labels.list>>["data"]>;
export type Label = Labels[number];

export interface WorkspaceData {
  overview: Overview;
  teams: Teams;
  members: Members;
  labels: Labels;
  team(id: string | undefined): TeamInfo | undefined;
  state(id: string | undefined): StateInfo | undefined;
  member(id: string | undefined): Member | undefined;
  label(id: string): Label | undefined;
  unread: number;
}

const WorkspaceContext = createContext<WorkspaceData | null>(null);

export function WorkspaceProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const overview = useQueryState(api.workspace.overview);
  const teams = useQueryState(api.teams.list);
  const members = useQueryState(api.workspace.members);
  const labels = useQueryState(api.labels.list);
  const inbox = useQueryState(api.inbox.list, { unread: true });
  const value = useMemo<WorkspaceData | null>(() => {
    if (!overview.data || !teams.data || !members.data || !labels.data) return null;
    const states = new Map(teams.data.flatMap((t) => t.states.map((st) => [st.id, st] as const)));
    return {
      overview: overview.data,
      teams: teams.data,
      members: members.data,
      labels: labels.data,
      team: (id) => teams.data!.find((t) => t.id === id),
      state: (id) => (id ? states.get(id) : undefined),
      member: (id) => members.data!.find((m) => m.id === id),
      label: (id) => labels.data!.find((l) => l.id === id),
      unread: inbox.data?.items.length ?? 0,
    };
  }, [overview.data, teams.data, members.data, labels.data, inbox.data]);
  const error = overview.error ?? teams.error ?? members.error ?? labels.error;
  if (error) return <div className="empty-state"><h2>Could not load this workspace</h2><p>{describe(error)}</p></div>;
  if (!value) return <>{fallback}</>;
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceData {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace outside WorkspaceProvider");
  return value;
}

// ---------------------------------------------------------------------------------------------
// Notices (toasts) and errors
// ---------------------------------------------------------------------------------------------

export function describe(error: unknown): string {
  const e = error as FeltKitClientError;
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}`;
  if (e?.code === "NOT_FOUND") return "That no longer exists, or you don't have access to it.";
  if (e?.code === "CONFLICT") return e.message;
  if (e?.code === "UNAUTHORIZED") return "Your session ended. Sign in again.";
  return e?.message ?? String(error);
}

type Toast = { id: number; tone: "error" | "info"; text: string };
const ToastContext = createContext<(tone: Toast["tone"], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

/** Run a mutation; report a refusal instead of throwing. */
export function useRun() {
  const toast = useContext(ToastContext);
  return useCallback(
    async <T,>(work: Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await work;
        if (success) toast("info", success);
        return r;
      } catch (e) {
        toast("error", describe(e));
        return undefined;
      }
    },
    [toast],
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

export const PRIORITIES = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
];
export const CATEGORY_LABEL: Record<string, string> = { backlog: "Backlog", unstarted: "Todo", started: "In progress", completed: "Done", canceled: "Canceled" };
export const TYPES = ["issue", "bug", "feature", "task"] as const;

export function StatusIcon({ category, color, size = 14 }: { category: string; color?: string; size?: number }) {
  const c = color ?? "currentColor";
  const r = size / 2 - 1.5;
  const mid = size / 2;
  const label = CATEGORY_LABEL[category] ?? category;
  if (category === "completed")
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="status-icon">
        <circle cx={mid} cy={mid} r={r + 0.5} fill={c} />
        <path d={`M${size * 0.3} ${mid} l${size * 0.15} ${size * 0.15} l${size * 0.25} -${size * 0.3}`} stroke="var(--surface)" strokeWidth="1.6" fill="none" />
      </svg>
    );
  if (category === "canceled")
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="status-icon">
        <circle cx={mid} cy={mid} r={r + 0.5} fill={c} />
        <path d={`M${size * 0.35} ${size * 0.35} L${size * 0.65} ${size * 0.65} M${size * 0.65} ${size * 0.35} L${size * 0.35} ${size * 0.65}`} stroke="var(--surface)" strokeWidth="1.6" />
      </svg>
    );
  const fraction = category === "started" ? 0.5 : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="status-icon">
      <circle cx={mid} cy={mid} r={r} fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={category === "backlog" ? "2 2" : undefined} />
      {fraction > 0 && <path d={`M${mid} ${mid} L${mid} ${mid - r + 2} A${r - 2} ${r - 2} 0 0 1 ${mid} ${mid + r - 2} Z`} fill={c} />}
    </svg>
  );
}

export function PriorityIcon({ priority }: { priority: number }) {
  const label = PRIORITIES[priority]?.label ?? "";
  if (priority === 1)
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label} className="priority-icon urgent">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" fill="var(--surface)" />
        <rect x="6.25" y="9.25" width="1.5" height="1.5" fill="var(--surface)" />
      </svg>
    );
  if (priority === 0)
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label} className="priority-icon none">
        {[2, 6, 10].map((x) => <rect key={x} x={x} y="6.25" width="2" height="1.5" rx=".5" fill="currentColor" />)}
      </svg>
    );
  const bars = 5 - priority; // high 3, medium 2, low 1
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label} className="priority-icon">
      {[0, 1, 2].map((i) => <rect key={i} x={1.5 + i * 4} y={9 - i * 3} width="3" height={3 + i * 3} rx=".8" fill="currentColor" opacity={i < bars ? 1 : 0.25} />)}
    </svg>
  );
}

export function Avatar({ id, size = 20 }: { id?: string; size?: number }) {
  const { member } = useWorkspace();
  const m = member(id);
  if (!id) return <span className="avatar empty" style={{ width: size, height: size }} aria-label="Unassigned" title="Unassigned" />;
  const name = m?.name ?? id;
  const initials = name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar${m?.type === "agent" ? " agent" : ""}`} title={name} aria-label={name} style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hash % 360} 45% 46%)` }}>
      {m?.type === "agent" ? "⚙" : initials}
    </span>
  );
}

export function LabelChip({ id }: { id: string }) {
  const { label } = useWorkspace();
  const l = label(id);
  if (!l) return null;
  return <span className="label-chip"><span className="label-dot" style={{ background: l.color }} />{l.name}</span>;
}

export function ago(when: number | string): string {
  const ms = typeof when === "string" ? Date.parse(when) : when;
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function shortDate(iso?: string): string {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Today in the viewer's time zone, for overdue and cycle phase. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? "Progress"}>
      <div className="progress-fill" style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

/** Keyboard shortcuts that ignore typing in fields. */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
      const key = `${e.metaKey || e.ctrlKey ? "mod+" : ""}${e.key.toLowerCase()}`;
      const handler = map[key];
      if (!handler || (typing && !key.startsWith("mod+") && key !== "escape")) return;
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
