import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { PRIORITIES, StatusIcon, TYPES, navigate, useHotkeys, useRun, useWorkspace } from "./lib";

/** ⌘K: jump to an issue by key or title, or to a page. */
export function CommandBar({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const ws = useWorkspace();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const found = useQueryState(api.issues.search, text.trim() ? { text: text.trim(), limit: 8 } : "skip");
  useHotkeys({ escape: onClose }, [onClose]);
  const pages = [
    { label: "Create issue", go: onCreate },
    { label: "Inbox", go: () => navigate("/inbox") },
    { label: "My issues", go: () => navigate("/my-issues") },
    { label: "Needs attention", go: () => navigate("/attention") },
    { label: "Projects", go: () => navigate("/projects") },
    { label: "Settings", go: () => navigate("/settings") },
    ...ws.overview.teams.map((t) => ({ label: `${t.name} issues`, go: () => navigate(`/team/${t.id}`) })),
  ].filter((p) => !text || p.label.toLowerCase().includes(text.toLowerCase()));
  const issues = (text.trim() ? found.data ?? [] : []).map((i) => ({ label: `${i.key} ${i.title}`, category: i.category, go: () => navigate(window.location.hash.slice(1).split("?")[0] || "/my-issues", { issue: i.id }) }));
  const options = [...issues, ...pages];
  const pick = (i: number) => { options[i]?.go(); onClose(); };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="command" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Search issues by key or title, or jump to…"
          value={text}
          onChange={(e) => { setText(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === "Enter") pick(active);
          }}
          aria-label="Search"
        />
        <ul role="listbox">
          {options.map((o, i) => (
            <li key={`${o.label}${i}`} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}>
              {"category" in o ? <StatusIcon category={o.category as string} /> : <span className="cmd-icon">→</span>} {o.label}
            </li>
          ))}
          {text.trim() && found.data && !issues.length && <li className="muted">No issues match “{text}”.</li>}
        </ul>
      </div>
    </div>
  );
}

export function CreateIssueDialog({ defaultTeamId, onClose, onCreated }: { defaultTeamId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const ws = useWorkspace();
  const create = useMutation(api.issues.create);
  const run = useRun();
  const [teamId, setTeamId] = useState(defaultTeamId ?? ws.overview.teams[0]?.id ?? "");
  const team = ws.team(teamId);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  useHotkeys({ escape: onClose }, [onClose]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const opt = (k: string) => (f.get(k) as string) || undefined;
    const r = await run(create({
      teamId,
      title: f.get("title") as string,
      ...(opt("description") ? { description: opt("description") } : {}),
      ...(opt("stateId") ? { stateId: opt("stateId") } : {}),
      priority: Number(f.get("priority") ?? 0),
      type: (opt("type") ?? "issue") as never,
      ...(opt("assigneeId") ? { assigneeId: opt("assigneeId") } : {}),
      ...(opt("dueDate") ? { dueDate: opt("dueDate") } : {}),
    }), undefined);
    if (r) onCreated(r.id);
  };
  if (!ws.overview.teams.length) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="dialog" role="dialog" aria-label="New issue" onClick={(e) => e.stopPropagation()}>
          <p>Create a team first (Settings → Teams), or load demo data.</p>
          <button onClick={() => { onClose(); navigate("/settings"); }}>Open settings</button>
        </div>
      </div>
    );
  }
  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="New issue" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="dialog-head">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
            {ws.overview.teams.map((t) => <option key={t.id} value={t.id}>{t.key}</option>)}
          </select>
          <span className="muted">New issue</span>
        </div>
        <input ref={titleRef} name="title" className="dialog-title" placeholder="Issue title" required maxLength={200} aria-label="Title" />
        <textarea name="description" placeholder="Add description…" rows={4} aria-label="Description" />
        <div className="dialog-props">
          <select name="stateId" aria-label="Status" defaultValue={team?.states.find((s) => s.category === "unstarted")?.id}>
            {team?.states.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
          </select>
          <select name="priority" aria-label="Priority" defaultValue="0">{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          <select name="type" aria-label="Type">{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <select name="assigneeId" aria-label="Assignee"><option value="">Unassigned</option>{ws.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <input type="date" name="dueDate" aria-label="Due date" />
        </div>
        <div className="dialog-foot">
          <span className="muted small"><kbd>Esc</kbd> to cancel</span>
          <button>Create issue</button>
        </div>
      </form>
    </div>
  );
}
