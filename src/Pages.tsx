import { useState, type FormEvent } from "react";
import { AccountSettings, TenantSettings, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { IssueRow, IssuesPage, type Row } from "./Issues";
import { Avatar, ProgressBar, ago, href, localToday, navigate, shortDate, useRun, useWorkspace } from "./lib";

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export function InboxPage() {
  const inbox = useQueryState(api.inbox.list, {});
  const markRead = useMutation(api.inbox.markRead);
  const markAll = useMutation(api.inbox.markAllRead);
  const run = useRun();
  const items = inbox.data ?? [];
  return (
    <section className="page">
      <header className="page-header">
        <h1>Inbox</h1>
        {items.some((n) => !n.read) && <button className="secondary" onClick={() => void run(markAll({}))}>Mark all read</button>}
      </header>
      {!inbox.data ? <div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /></div> : !items.length ? (
        <div className="empty-state"><h2>You're all caught up</h2><p>Assignments, mentions, comments and status changes on your issues appear here.</p></div>
      ) : (
        <ul className="inbox">
          {items.map((n) => (
            <li key={n.id} className={n.read ? "read" : ""}>
              <a href={href("/inbox", { issue: n.data.issueId })} onClick={() => !n.read && void markRead({ id: n.id })}>
                <Avatar id={n.data.actor} size={22} />
                <span className="inbox-text"><strong>{n.title}</strong>{n.body && <span className="muted">{n.body}</span>}</span>
                <span className="muted small">{ago(n.createdAt)}</span>
                {!n.read && <span className="unread-dot" aria-label="Unread" />}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Needs attention: overdue and blocked
// ---------------------------------------------------------------------------------------------

export function AttentionPage() {
  const data = useQueryState(api.issues.attention, { today: localToday() });
  return (
    <section className="page">
      <header className="page-header"><h1>Needs attention</h1></header>
      {!data.data ? <div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /></div> : (
        <>
          <h2 className="section-title">Overdue <span className="muted">{data.data.overdue.length}</span></h2>
          <div className="issue-list">{data.data.overdue.map((r) => <IssueRow key={r.id} row={r as Row} />)}</div>
          {!data.data.overdue.length && <p className="muted pad">Nothing is past its due date.</p>}
          <h2 className="section-title">Blocked <span className="muted">{data.data.blocked.length}</span></h2>
          <div className="issue-list">
            {data.data.blocked.map((r) => (
              <div key={r.id} className="blocked-row"><IssueRow row={r as Row} /><span className="muted small">blocked by {r.blockedBy.join(", ")}</span></div>
            ))}
          </div>
          {!data.data.blocked.length && <p className="muted pad">No open issue is waiting on another.</p>}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = { planned: "Planned", started: "In progress", paused: "Paused", completed: "Completed", canceled: "Canceled" };

export function ProjectsPage({ teamId }: { teamId?: string }) {
  const ws = useWorkspace();
  const projects = useQueryState(api.projects.list, teamId ? { teamId } : {});
  const create = useMutation(api.projects.create);
  const run = useRun();
  const [adding, setAdding] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const id = await run(create({ teamId: (f.get("teamId") as string) || teamId!, name: f.get("name") as string, ...(f.get("targetDate") ? { targetDate: f.get("targetDate") as string } : {}) }));
    if (id) navigate(`/projects/${id}`);
  };
  return (
    <section className="page">
      <header className="page-header">
        <h1>{teamId ? `${ws.team(teamId)?.name} projects` : "Projects"}</h1>
        <button className="secondary" onClick={() => setAdding((v) => !v)}>New project</button>
      </header>
      {adding && (
        <form className="inline-form" onSubmit={submit}>
          <input name="name" placeholder="Project name" required aria-label="Project name" autoFocus />
          {!teamId && <select name="teamId" aria-label="Team">{ws.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
          <label className="small muted">Target <input type="date" name="targetDate" aria-label="Target date" /></label>
          <button>Create</button>
        </form>
      )}
      {!projects.data ? <div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /></div> : !projects.data.length ? (
        <div className="empty-state"><h2>No projects</h2><p>Projects group issues toward an outcome with a target date.</p></div>
      ) : (
        <table className="table">
          <thead><tr><th>Name</th><th>Team</th><th>Status</th><th>Lead</th><th>Target</th><th>Progress</th></tr></thead>
          <tbody>
            {projects.data.map((p) => (
              <tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
                <td><a href={href(`/projects/${p.id}`)}>{p.name}</a></td>
                <td>{ws.team(p.teamId)?.key}</td>
                <td><span className={`pill ${p.status}`}>{STATUS_LABEL[p.status]}</span></td>
                <td><Avatar id={p.leadId} size={18} /></td>
                <td className={p.targetDate && p.targetDate < localToday() && p.status !== "completed" ? "overdue" : ""}>{shortDate(p.targetDate)}</td>
                <td className="progress-cell"><ProgressBar percent={p.progress.percent} /> <span className="muted small">{p.progress.percent}%</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ProjectPage({ projectId }: { projectId: string }) {
  const ws = useWorkspace();
  const summary = useQueryState(api.projects.summary, { projectId });
  const update = useMutation(api.projects.update);
  const addMilestone = useMutation(api.projects.addMilestone);
  const run = useRun();
  if (summary.error) return <section className="page"><div className="empty-state"><p>That project does not exist, or you can't see it.</p></div></section>;
  const p = summary.data;
  if (!p) return <section className="page"><div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /></div></section>;
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="crumb"><a href={href("/projects")}>Projects</a> / {ws.team(p.teamId)?.name}</p>
          <h1>{p.name}</h1>
        </div>
        <select value={p.status} onChange={(e) => void run(update({ projectId, status: e.target.value as never }))} aria-label="Project status">
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </header>
      <div className="project-grid">
        <div className="card-box">
          <h2 className="section-title">Progress</h2>
          <ProgressBar percent={p.progress.percent} />
          <p className="muted small">{p.progress.completed} of {p.progress.total} done · {p.progress.started} in progress{p.progress.canceled ? ` · ${p.progress.canceled} canceled` : ""}</p>
          {p.overdue && <p className="overdue small">Past its target date ({shortDate(p.targetDate)}).</p>}
          <div className="dates">
            <label>Start <input type="date" value={p.startDate ?? ""} onChange={(e) => void run(update({ projectId, startDate: e.target.value || null }))} /></label>
            <label>Target <input type="date" value={p.targetDate ?? ""} onChange={(e) => void run(update({ projectId, targetDate: e.target.value || null }))} /></label>
            <label>Lead <select value={p.leadId ?? ""} onChange={(e) => void run(update({ projectId, leadId: e.target.value || null }))}>
              <option value="">No lead</option>
              {ws.members.filter((m) => m.type === "user").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></label>
          </div>
          {p.description && <p>{p.description}</p>}
        </div>
        <div className="card-box">
          <h2 className="section-title">Milestones</h2>
          {p.milestones.map((m) => (
            <div key={m.id} className="milestone">
              <span>{m.name} <span className="muted small">{shortDate(m.targetDate)}</span></span>
              <ProgressBar percent={m.progress.percent} label={`${m.name} progress`} />
              <span className="muted small">{m.progress.completed}/{m.progress.total}</span>
            </div>
          ))}
          <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget; if (await run(addMilestone({ projectId, name: f.get("name") as string, ...(f.get("date") ? { targetDate: f.get("date") as string } : {}) }))) form.reset(); }}>
            <input name="name" placeholder="New milestone" required aria-label="Milestone name" />
            <input type="date" name="date" aria-label="Milestone date" />
            <button>Add</button>
          </form>
        </div>
        <div className="card-box">
          <h2 className="section-title">Project activity</h2>
          <ol className="timeline compact">
            {[...p.history].reverse().slice(0, 15).map((h, i) => <li key={i} className="event"><Avatar id={h.actor} size={16} /> {h.type.replace("project.", "").replace("_", " ")} <span className="muted">{ago(h.at)}</span></li>)}
          </ol>
        </div>
      </div>
      <IssuesPage scope={{ projectId }} title="Issues" />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------------------------

export function CyclesPage({ teamId }: { teamId: string }) {
  const ws = useWorkspace();
  const cycles = useQueryState(api.cycles.list, { teamId, today: localToday() });
  const create = useMutation(api.cycles.create);
  const run = useRun();
  const lastEnd = cycles.data?.[0]?.endDate;
  const nextStart = lastEnd ? new Date(new Date(`${lastEnd}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) : localToday();
  const nextEnd = new Date(new Date(`${nextStart}T00:00:00Z`).getTime() + 13 * 86_400_000).toISOString().slice(0, 10);
  return (
    <section className="page">
      <header className="page-header">
        <h1>{ws.team(teamId)?.name} cycles</h1>
        <button className="secondary" onClick={() => void run(create({ teamId, startDate: nextStart, endDate: nextEnd }), "Cycle created")}>New cycle ({shortDate(nextStart)} – {shortDate(nextEnd)})</button>
      </header>
      {!cycles.data ? <div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /></div> : !cycles.data.length ? (
        <div className="empty-state"><h2>No cycles</h2><p>Cycles are time boxes for a team's work.</p></div>
      ) : (
        <div className="cycles">
          {cycles.data.map((c) => (
            <a key={c.id} className={`cycle-card ${c.phase}`} href={href(`/cycles/${c.id}`)}>
              <div><strong>Cycle {c.number}</strong> {c.phase === "active" && <span className="pill started">Current</span>} {c.phase === "upcoming" && <span className="pill planned">Upcoming</span>}</div>
              <div className="muted small">{shortDate(c.startDate)} – {shortDate(c.endDate)}</div>
              <ProgressBar percent={c.progress.percent} label={`Cycle ${c.number} progress`} />
              <div className="muted small">{c.progress.completed}/{c.progress.scope} issues · {c.progress.pointsDone}/{c.progress.points} points</div>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

export function CyclePage({ cycleId }: { cycleId: string }) {
  const ws = useWorkspace();
  const cycle = useQueryState(api.cycles.get, { cycleId, today: localToday() });
  if (cycle.error) return <section className="page"><div className="empty-state"><p>That cycle does not exist, or you can't see it.</p></div></section>;
  const c = cycle.data;
  if (!c) return <section className="page"><div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /></div></section>;
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="crumb"><a href={href(`/team/${c.teamId}/cycles`)}>{ws.team(c.teamId)?.name} cycles</a></p>
          <h1>Cycle {c.number} <span className="muted small">{shortDate(c.startDate)} – {shortDate(c.endDate)}</span></h1>
        </div>
      </header>
      <div className="card-box">
        <ProgressBar percent={c.progress.percent} />
        <p className="muted small">{c.progress.completed} of {c.progress.scope} done · {c.progress.started} in progress · {c.progress.pointsDone}/{c.progress.points} points · {c.phase}</p>
      </div>
      <IssuesPage scope={{ cycleId }} title="Issues in this cycle" />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export function SettingsPage({ teamId }: { teamId?: string }) {
  const ws = useWorkspace();
  const admin = ws.overview.workspace.role === "owner" || ws.overview.workspace.role === "admin";
  return (
    <section className="page settings">
      <header className="page-header"><h1>Settings</h1></header>
      <div className="settings-grid">
        <div className="card-box">
          <h2 className="section-title">Workspace</h2>
          <p className="muted small">Name, members, roles and invitations are FeltKit's: the same rules apply on every interface.</p>
          <TenantSettings />
        </div>
        <div className="card-box">
          <h2 className="section-title">Teams</h2>
          <TeamsSettings selected={teamId} />
        </div>
        {admin && <WorkspacePreferences />}
        <div className="card-box">
          <h2 className="section-title">Account</h2>
          <AccountSettings />
        </div>
      </div>
    </section>
  );
}

function WorkspacePreferences() {
  const settings = useQueryState(api.workspace.settings);
  const update = useMutation(api.workspace.updateSettings);
  const seed = useMutation(api.seed.demo);
  const run = useRun();
  const ws = useWorkspace();
  return (
    <div className="card-box">
      <h2 className="section-title">Preferences</h2>
      <label className="field">Estimates
        <select value={settings.data?.estimates ?? "points"} onChange={(e) => void run(update({ estimates: e.target.value as never }))}>
          <option value="points">Points</option>
          <option value="tshirt">T-shirt sizes</option>
          <option value="none">Off</option>
        </select>
      </label>
      {!ws.teams.length && (
        <p>
          <button className="secondary" onClick={() => void run(seed({}), "Demo data loaded")}>Load demo data</button>
          <span className="muted small"> Three teams, projects, cycles and 360 issues, into this empty workspace.</span>
        </p>
      )}
      <h3>Agents</h3>
      <p className="muted small">An agent works here with a session an operator issues (<code>npx feltkit session create --type agent --id &lt;id&gt; --role agent</code>), added as a member with the <code>agent</code> role. It reaches TaskFlow over MCP at <code>/mcp</code> with exactly that role; deletions it proposes wait for a person.</p>
      <ul className="plain">{ws.members.filter((m) => m.type === "agent").map((m) => <li key={m.id}><Avatar id={m.id} size={16} /> {m.name} <span className="muted small">{m.role}</span></li>)}</ul>
    </div>
  );
}

function TeamsSettings({ selected }: { selected?: string }) {
  const ws = useWorkspace();
  const run = useRun();
  const create = useMutation(api.teams.create);
  const update = useMutation(api.teams.update);
  const addMember = useMutation(api.teams.addMember);
  const removeMember = useMutation(api.teams.removeMember);
  const join = useMutation(api.teams.join);
  const addState = useMutation(api.teams.addState);
  const [chosen, setCurrent] = useState(selected);
  const current = chosen && ws.team(chosen) ? chosen : ws.teams[0]?.id;
  const team = ws.team(current);
  const me = ws.overview.me.id;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const id = await run(create({ key: (f.get("key") as string).toUpperCase(), name: f.get("name") as string, private: f.get("private") === "on" }), "Team created");
    if (id) { form.reset(); setCurrent(id); }
  };
  return (
    <>
      <form className="inline-form" onSubmit={submit}>
        <input name="key" placeholder="KEY" required pattern="[A-Za-z][A-Za-z0-9]{1,4}" maxLength={5} aria-label="Team key" style={{ width: 70 }} />
        <input name="name" placeholder="Team name" required aria-label="Team name" />
        <label className="small"><input type="checkbox" name="private" /> Private</label>
        <button>Create team</button>
      </form>
      {ws.teams.length > 0 && (
        <select value={current} onChange={(e) => setCurrent(e.target.value)} aria-label="Team">
          {ws.teams.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.name}</option>)}
        </select>
      )}
      {team && (
        <div className="team-settings">
          <label className="field">Name <input defaultValue={team.name} key={team.id + team.name} onBlur={(e) => e.target.value !== team.name && void run(update({ teamId: team.id, name: e.target.value }))} /></label>
          <label className="small"><input type="checkbox" checked={team.private} onChange={(e) => void run(update({ teamId: team.id, private: e.target.checked }))} /> Private (only members, owners and admins see it)</label>
          {!team.members.some((m) => m.userId === me) && <button className="secondary" onClick={() => void run(join({ teamId: team.id }))}>Join team</button>}
          <h3>Members</h3>
          <ul className="plain">
            {team.members.map((m) => (
              <li key={m.userId}>
                <Avatar id={m.userId} size={18} /> {ws.member(m.userId)?.name ?? m.userId} <span className="muted small">{m.role}</span>
                {m.role !== "lead" && <button className="link small" onClick={() => void run(addMember({ teamId: team.id, userId: m.userId, role: "lead" }))}>Make lead</button>}
                <button className="link small" onClick={() => void run(removeMember({ teamId: team.id, userId: m.userId }))}>Remove</button>
              </li>
            ))}
          </ul>
          <select value="" onChange={(e) => e.target.value && void run(addMember({ teamId: team.id, userId: e.target.value }))} aria-label="Add a member">
            <option value="">Add a member…</option>
            {ws.members.filter((m) => !team.members.some((t) => t.userId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
          </select>
          <h3>Workflow</h3>
          <ul className="plain">{team.states.map((st) => <li key={st.id}><span className="label-dot" style={{ background: st.color }} /> {st.name} <span className="muted small">{st.category}</span></li>)}</ul>
          <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget; if (await run(addState({ teamId: team.id, name: f.get("name") as string, category: f.get("category") as never }))) form.reset(); }}>
            <input name="name" placeholder="New status" required aria-label="Status name" />
            <select name="category" aria-label="Category">{["backlog", "unstarted", "started", "completed", "canceled"].map((c) => <option key={c}>{c}</option>)}</select>
            <button>Add</button>
          </form>
        </div>
      )}
    </>
  );
}
