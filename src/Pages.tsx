import { useEffect, useRef, useState, type FormEvent } from "react";
import { AccountSettings, TenantSettings, useFeltKit, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { IssueRow, IssuesPage, type Row } from "./Issues";
import { Avatar, ProgressBar, ago, href, localToday, navigate, shortDate, useRoute, useRun, useWorkspace } from "./lib";

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export function InboxPage() {
  const inbox = useQueryState(api.inbox.list, {});
  const markRead = useMutation(api.inbox.markRead);
  const markAll = useMutation(api.inbox.markAllRead);
  const run = useRun();
  const items = inbox.data?.items ?? [];
  return (
    <section className="page">
      <header className="page-header">
        <h1>Inbox</h1>
        {items.some((n) => !n.read) && <button className="secondary" onClick={() => void run(markAll({}))}>Mark all read</button>}
      </header>
      {inbox.data?.truncated && <p className="muted small pad">Showing your most recent notifications. Older ones can't be listed yet.</p>}
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
        <AssistantSettings admin={admin} />
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

// ---------------------------------------------------------------------------------------------
// Capture: file an issue from anywhere (FeltKit surfaces and invocations)
// ---------------------------------------------------------------------------------------------

const STATE_TEXT: Record<string, string> = { received: "Received", validating: "Checking", accepted: "Queued", running: "Filing…", awaiting_approval: "Waiting for approval", completed: "Filed", failed: "Failed", cancelled: "Canceled" };

/** A bookmarklet that opens TaskFlow's capture form with the page's address, title and selection. */
function bookmarklet(): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  const code = `(()=>{const q=new URLSearchParams({url:location.href,title:document.title,selection:String(getSelection()||"").slice(0,4000)});window.open(${JSON.stringify(base)}+"#/capture?"+q,"_blank")})()`;
  return `javascript:${encodeURIComponent(code)}`;
}

/**
 * React 19 replaces a `javascript:` href with a stub that throws, as a guard against injected URLs.
 * A bookmarklet is the one place such a URL is the point, and its code is ours, so it is set on the
 * element after render.
 */
function Bookmarklet() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute("href", bookmarklet()); }, []);
  return <a ref={ref} className="bookmarklet" onClick={(e) => e.preventDefault()}>Capture to TaskFlow</a>;
}

export function CapturePage() {
  const ws = useWorkspace();
  const route = useRoute();
  const submit = useMutation(api.capture.submit);
  const cancel = useMutation(api.capture.cancel);
  const client = useFeltKit();
  const run = useRun();
  // Not useQueryState: a live query reading ctx.invocations is not re-run when an invocation changes
  // (FeltKit 0.3.30; docs/GAP-REGISTER.md TF-GAP-16). Re-read after each action, and every 1.5 s only
  // while a capture is still on its way.
  type Captures = Awaited<ReturnType<typeof client.query<typeof api.capture.list>>>;
  const [captures, setCaptures] = useState<{ data?: Captures }>({});
  const reload = async () => {
    try { setCaptures({ data: await client.query(api.capture.list) }); } catch { /* shown on the next read */ }
  };
  useEffect(() => { void reload(); }, []);
  const pending = (captures.data ?? []).some((c) => !["completed", "failed", "cancelled"].includes(c.state));
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void reload(), 1500);
    return () => clearInterval(timer);
  }, [pending]);
  const [teamId, setTeamId] = useState(ws.overview.teams[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [url, setUrl] = useState(route.query.get("url") ?? "");
  const [title, setTitle] = useState(route.query.get("title") ?? "");
  const [selection, setSelection] = useState(route.query.get("selection") ?? "");
  const send = async (e: FormEvent) => {
    e.preventDefault();
    // The envelope is FeltKit's contract: data about what was captured, never who is asking.
    const context = [
      ...(url.trim() ? [{ kind: "url", url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}) }] : []),
      ...(selection.trim() ? [{ kind: "selection", text: selection.trim(), ...(url.trim() ? { url: url.trim() } : {}) }] : []),
    ];
    const envelope = { contract: "feltkit.invocation/1", invocationId: `capture-${crypto.randomUUID()}`, surface: { id: "capture", version: "1.0.0", device: navigator.userAgent.slice(0, 60) }, instruction: instruction.trim(), context, returnTo: { kind: "app" }, submittedAt: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (await run(submit({ teamId, envelope }), "Captured. It will appear below when it's filed.")) {
      setInstruction(""); setUrl(""); setTitle(""); setSelection("");
      await reload();
    }
  };
  return (
    <section className="page">
      <header className="page-header"><h1>Capture</h1></header>
      <div className="settings-grid">
        <form className="card-box capture-form" onSubmit={send}>
          <h2 className="section-title">File it from where you are</h2>
          <label className="field">Team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>{ws.overview.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
          <label className="field">What is it?<textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} maxLength={2000} placeholder="Checkout button overlaps the total on mobile" /></label>
          <label className="field">Page address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" /></label>
          <label className="field">Page title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></label>
          <label className="field">Selected text<textarea value={selection} onChange={(e) => setSelection(e.target.value)} rows={3} maxLength={20000} /></label>
          <button disabled={!teamId || (!instruction.trim() && !url.trim() && !selection.trim())}>Capture</button>
          <p className="muted small">
            From any page: drag <Bookmarklet /> to your bookmarks bar, then click it on the page you want to file.
          </p>
        </form>
        <div className="card-box">
          <h2 className="section-title">Your captures</h2>
          {!captures.data ? <div className="skeleton-row" /> : !captures.data.length ? <p className="muted">Nothing captured in this workspace yet.</p> : (
            <ul className="plain captures">
              {captures.data.map((c) => (
                <li key={c.id}>
                  <span className={`pill ${c.state === "completed" ? "completed" : c.state === "failed" ? "canceled" : "planned"}`}>{STATE_TEXT[c.state] ?? c.state}</span>
                  <span className="capture-text">{c.instruction || c.context[0]?.title || c.context[0]?.url || "Captured"}</span>
                  <span className="muted small">{ago(c.receivedAt)}</span>
                  {c.result && <a href={href("/capture", { issue: c.result.issueId })}>{c.result.key}</a>}
                  {c.error && <span className="overdue small">{c.error.message}</span>}
                  {(c.state === "accepted" || c.state === "received") && <button className="link small" onClick={async () => { await run(cancel({ id: c.id })); await reload(); }}>Cancel</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Assistant: delegation through FeltKit's private AuthBoundry
// ---------------------------------------------------------------------------------------------

type Grant = { id: string; capabilities: string[]; expiresAt: number | null; status: string };

function AssistantSettings({ admin }: { admin: boolean }) {
  const ws = useWorkspace();
  const client = useFeltKit();
  const list = useMutation(api.assistant.grants);
  const grant = useMutation(api.assistant.grant);
  const revoke = useMutation(api.assistant.revoke);
  const run = useRun();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [days, setDays] = useState(30);
  const assistant = ws.member("taskflow-assistant");
  const refresh = async () => setGrants((await run(list({}))) ?? []);
  useEffect(() => { void refresh(); }, []);
  const active = (grants ?? []).filter((g) => g.status === "active" && (!g.expiresAt || g.expiresAt > Date.now()));
  return (
    <div className="card-box">
      <h2 className="section-title">Assistant</h2>
      <p className="muted small">On any issue, comment <code>@assistant follow up: &lt;title&gt;</code> and the TaskFlow assistant files a sub-issue for you. It acts as itself, only for people who allowed it, within its own role and the teams it is on. Each request is decided by the workspace's authority and recorded in the issue's history.</p>
      {!assistant ? (
        admin ? (
          <button className="secondary" onClick={() => void run(client.addMember("taskflow-assistant", "agent"), "The assistant joined this workspace")}>Add the assistant to this workspace</button>
        ) : <p className="muted small">The assistant isn't in this workspace. A workspace admin can add it.</p>
      ) : <p className="small"><Avatar id="taskflow-assistant" size={16} /> In this workspace as <strong>{assistant.role}</strong>. Add it to private teams it should work in.</p>}
      <h3>What you allow</h3>
      {grants === null ? <div className="skeleton-row" /> : active.length ? (
        <ul className="plain">
          {active.map((g) => (
            <li key={g.id}>File issues for me {g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleDateString()}` : ""}
              <button className="link small" onClick={async () => { await run(revoke({ id: g.id }), "Revoked"); await refresh(); }}>Revoke</button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="inline-form" style={{ padding: 0 }}>
          <span className="small">Let the assistant file issues for me for</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days">{[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}</select>
          <button onClick={async () => { await run(grant({ days }), "Allowed"); await refresh(); }}>Allow</button>
        </div>
      )}
    </div>
  );
}
