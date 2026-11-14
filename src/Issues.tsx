import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Avatar, CATEGORY_LABEL, LabelChip, PRIORITIES, PriorityIcon, StatusIcon, TYPES, localToday, setQuery, shortDate, useHotkeys, useRoute, useRun, useWorkspace } from "./lib";

type Result = NonNullable<ReturnType<typeof useQueryState<typeof api.issues.list>>["data"]>;
export type Row = Result["items"][number];

const CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
const PAGE = 150;

/** Filters from the URL: they survive navigation, reloads and shared links. */
function useFilters() {
  const { query } = useRoute();
  const list = (k: string) => query.get(k)?.split(",").filter(Boolean);
  return {
    view: (query.get("view") ?? "list") as "list" | "board",
    categories: list("status") as (typeof CATEGORIES)[number][] | undefined,
    priorities: list("priority")?.map(Number),
    assigneeId: query.get("assignee") ?? undefined,
    labelIds: list("label"),
    types: list("type") as (typeof TYPES)[number][] | undefined,
    text: query.get("q") ?? undefined,
    sort: (query.get("sort") ?? "manual") as "manual" | "priority" | "updated" | "created" | "due" | "key",
    projectId: query.get("project") ?? undefined,
    cycleId: query.get("cycle") ?? undefined,
  };
}

export function IssuesPage({ scope, title }: { scope: { teamId?: string; assigneeId?: string; projectId?: string; cycleId?: string }; title: string }) {
  const f = useFilters();
  const ws = useWorkspace();
  const [limit, setLimit] = useState(PAGE);
  const args = {
    ...scope,
    ...(f.categories ? { categories: f.categories } : {}),
    ...(f.priorities ? { priorities: f.priorities } : {}),
    ...(f.assigneeId && !scope.assigneeId ? { assigneeId: f.assigneeId } : {}),
    ...(f.labelIds ? { labelIds: f.labelIds } : {}),
    ...(f.types ? { types: f.types } : {}),
    ...(f.text ? { text: f.text } : {}),
    ...(f.projectId && !scope.projectId ? { projectId: f.projectId } : {}),
    ...(f.cycleId && !scope.cycleId ? { cycleId: f.cycleId } : {}),
    sort: f.sort,
    // The board needs every issue in the scope; the list pages.
    limit: f.view === "board" ? 1000 : limit,
  };
  const result = useQueryState(api.issues.list, args as never);
  const data = result.data as Result | undefined;
  const team = ws.team(scope.teamId);

  return (
    <section className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <div className="view-toggle" role="tablist" aria-label="View">
          <button role="tab" aria-selected={f.view === "list"} className={f.view === "list" ? "on" : ""} onClick={() => setQuery({ view: null })}>List</button>
          <button role="tab" aria-selected={f.view === "board"} className={f.view === "board" ? "on" : ""} onClick={() => setQuery({ view: "board" })}>Board</button>
        </div>
      </header>
      <FilterBar hideAssignee={Boolean(scope.assigneeId)} teamId={scope.teamId} />
      {result.error && <p className="error-line">{String((result.error as Error).message)}</p>}
      {!data ? (
        <div className="skeleton-list" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton-row" />)}</div>
      ) : f.view === "board" ? (
        <Board rows={data.items} teamStates={team?.states} total={data.total} />
      ) : (
        <IssueList rows={data.items} total={data.total} onMore={data.total > data.items.length ? () => setLimit((l) => l + PAGE) : undefined} />
      )}
    </section>
  );
}

function Multi({ label, options, value, onChange }: { label: string; options: Array<{ value: string; label: string }>; value: string[] | undefined; onChange: (v: string[]) => void }) {
  const selected = new Set(value ?? []);
  return (
    <details className="filter">
      <summary className={selected.size ? "active" : ""}>{label}{selected.size ? `: ${selected.size}` : ""}</summary>
      <div className="filter-menu" role="group" aria-label={label}>
        {options.map((o) => (
          <label key={o.value}>
            <input type="checkbox" checked={selected.has(o.value)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(o.value); else n.delete(o.value); onChange([...n]); }} />
            {o.label}
          </label>
        ))}
        {selected.size > 0 && <button className="link" onClick={() => onChange([])}>Clear</button>}
      </div>
    </details>
  );
}

function FilterBar({ hideAssignee, teamId }: { hideAssignee: boolean; teamId?: string }) {
  const f = useFilters();
  const ws = useWorkspace();
  const [text, setText] = useState(f.text ?? "");
  useEffect(() => {
    const t = setTimeout(() => { if ((f.text ?? "") !== text) setQuery({ q: text || null }); }, 250);
    return () => clearTimeout(t);
  }, [text, f.text]);
  const csv = (xs: Array<string | number>) => (xs.length ? xs.join(",") : null);
  const labels = ws.labels.filter((l) => !l.teamId || !teamId || l.teamId === teamId);
  const active = [f.categories, f.priorities, f.labelIds, f.types].some((x) => x?.length) || f.assigneeId || f.text;
  return (
    <div className="filter-bar" role="toolbar" aria-label="Filters">
      <input className="filter-text" placeholder="Filter by title or key…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter by title or key" />
      <Multi label="Status" options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c]! }))} value={f.categories} onChange={(v) => setQuery({ status: csv(v) })} />
      <Multi label="Priority" options={PRIORITIES.map((p) => ({ value: String(p.value), label: p.label }))} value={f.priorities?.map(String)} onChange={(v) => setQuery({ priority: csv(v) })} />
      {!hideAssignee && (
        <select className="filter-select" value={f.assigneeId ?? ""} onChange={(e) => setQuery({ assignee: e.target.value || null })} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {ws.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
      <Multi label="Label" options={labels.map((l) => ({ value: l.id, label: l.name }))} value={f.labelIds} onChange={(v) => setQuery({ label: csv(v) })} />
      <Multi label="Type" options={TYPES.map((t) => ({ value: t, label: t }))} value={f.types} onChange={(v) => setQuery({ type: csv(v) })} />
      <select className="filter-select" value={f.sort} onChange={(e) => setQuery({ sort: e.target.value === "manual" ? null : e.target.value })} aria-label="Sort">
        <option value="manual">Manual order</option>
        <option value="priority">Priority</option>
        <option value="updated">Last updated</option>
        <option value="created">Created</option>
        <option value="due">Due date</option>
        <option value="key">Identifier</option>
      </select>
      {active && <button className="link" onClick={() => { setText(""); setQuery({ status: null, priority: null, assignee: null, label: null, type: null, q: null }); }}>Clear filters</button>}
    </div>
  );
}

export function IssueRow({ row, focused, onFocus }: { row: Row; focused?: boolean; onFocus?: () => void }) {
  const ws = useWorkspace();
  const state = ws.state(row.stateId);
  const today = localToday();
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { if (focused) ref.current?.focus({ preventScroll: false }); }, [focused]);
  const route = useRoute();
  const q = new URLSearchParams(route.query);
  q.set("issue", row.id);
  return (
    <a ref={ref} className={`issue-row${focused ? " focused" : ""}`} href={`#/${route.path.join("/")}?${q}`} onFocus={onFocus}>
      <PriorityIcon priority={row.priority} />
      <span className="issue-key">{row.key}</span>
      <StatusIcon category={row.category} color={state?.color} />
      <span className="issue-title">{row.title}</span>
      <span className="issue-meta">
        {row.labelIds.slice(0, 2).map((l) => <LabelChip key={l} id={l} />)}
        {row.dueDate && <span className={`due${row.dueDate < today && (row.category === "unstarted" || row.category === "started" || row.category === "backlog") ? " overdue" : ""}`}>{shortDate(row.dueDate)}</span>}
        {row.estimate !== undefined && <span className="estimate" title="Estimate">{row.estimate}</span>}
        <Avatar id={row.assigneeId} />
      </span>
    </a>
  );
}

function IssueList({ rows, total, onMore }: { rows: Row[]; total: number; onMore?: () => void }) {
  const [focus, setFocus] = useState(-1);
  const groups = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const c of CATEGORIES) by.set(c, []);
    for (const r of rows) by.get(r.category)!.push(r);
    return [...by.entries()].filter(([, xs]) => xs.length);
  }, [rows]);
  const flat = groups.flatMap(([, xs]) => xs);
  useHotkeys({
    j: () => setFocus((i) => Math.min(flat.length - 1, i + 1)),
    arrowdown: (e) => { e.preventDefault(); setFocus((i) => Math.min(flat.length - 1, i + 1)); },
    k: () => setFocus((i) => Math.max(0, i - 1)),
    arrowup: (e) => { e.preventDefault(); setFocus((i) => Math.max(0, i - 1)); },
  }, [flat.length]);
  if (!rows.length) return <div className="empty-state"><h2>No issues</h2><p>Nothing matches. Press <kbd>C</kbd> to create one.</p></div>;
  let index = -1;
  return (
    <div className="issue-list" role="list">
      {groups.map(([category, xs]) => (
        <div key={category} role="group" aria-label={CATEGORY_LABEL[category]}>
          <div className="group-header"><StatusIcon category={category} /> {CATEGORY_LABEL[category]} <span className="muted">{xs.length}</span></div>
          {xs.map((r) => {
            index++;
            const i = index;
            return <IssueRow key={r.id} row={r} focused={focus === i} onFocus={() => setFocus(i)} />;
          })}
        </div>
      ))}
      <div className="list-footer muted">
        Showing {rows.length} of {total}
        {onMore && <button className="link" onClick={onMore}>Load more</button>}
      </div>
    </div>
  );
}

/**
 * Columns are the team's statuses (or, across teams, the five categories). Dragging a card changes
 * its status on the server; the live query then moves it for everyone.
 */
function Board({ rows, teamStates, total }: { rows: Row[]; teamStates?: Array<{ id: string; name: string; category: string; color: string }>; total: number }) {
  const ws = useWorkspace();
  const move = useMutation(api.issues.move);
  const run = useRun();
  const [over, setOver] = useState<string | null>(null);
  const columns = teamStates
    ? teamStates.map((st) => ({ key: st.id, title: st.name, category: st.category, color: st.color, rows: rows.filter((r) => r.stateId === st.id) }))
    : CATEGORIES.map((c) => ({ key: c, title: CATEGORY_LABEL[c]!, category: c, color: undefined, rows: rows.filter((r) => r.category === c) }));
  const drop = async (columnKey: string, issueId: string) => {
    setOver(null);
    const row = rows.find((r) => r.id === issueId);
    if (!row) return;
    // Across teams a column is a category: use the issue's own team's first status in it.
    const stateId = teamStates ? columnKey : ws.team(row.teamId)?.states.find((st) => st.category === columnKey)?.id;
    if (!stateId || stateId === row.stateId) return;
    await run(move({ issueId, stateId, sortOrder: Date.now(), expectedVersion: row.__version }));
  };
  return (
    <div className="board" aria-label="Board">
      {columns.map((col) => (
        <div
          key={col.key}
          className={`column${over === col.key ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(col.key); }}
          onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
          onDrop={(e) => { e.preventDefault(); void drop(col.key, e.dataTransfer.getData("text/issue")); }}
          aria-label={col.title}
        >
          <div className="column-header"><StatusIcon category={col.category} color={col.color} /> {col.title} <span className="muted">{col.rows.length}</span></div>
          <div className="column-body">
            {col.rows.slice(0, 200).map((r) => <Card key={r.id} row={r} />)}
            {col.rows.length > 200 && <p className="muted small">+{col.rows.length - 200} more; filter to narrow.</p>}
          </div>
        </div>
      ))}
      {total > rows.length && <p className="muted small">Showing {rows.length} of {total}.</p>}
    </div>
  );
}

function Card({ row }: { row: Row }) {
  const route = useRoute();
  const q = new URLSearchParams(route.query);
  q.set("issue", row.id);
  return (
    <a className="card" draggable onDragStart={(e) => { e.dataTransfer.setData("text/issue", row.id); e.dataTransfer.effectAllowed = "move"; }} href={`#/${route.path.join("/")}?${q}`}>
      <div className="card-top"><span className="issue-key">{row.key}</span><Avatar id={row.assigneeId} size={18} /></div>
      <div className="card-title">{row.title}</div>
      <div className="card-meta">
        <PriorityIcon priority={row.priority} />
        {row.labelIds.slice(0, 2).map((l) => <LabelChip key={l} id={l} />)}
        {row.dueDate && <span className={`due${row.dueDate < localToday() ? " overdue" : ""}`}>{shortDate(row.dueDate)}</span>}
      </div>
    </a>
  );
}

