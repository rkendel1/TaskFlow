import { useEffect, useRef, useState } from "react";
import { AcceptInvitation, AuthNotices, CreateTenant, SignIn, TenantSwitcher, useAuth, useAuthRedirect, useConnectionState, useSession, useTenant } from "@feltdb/feltkit/react";
import { ThemeToggle } from "./theme";
import { Avatar, href, navigate, ToastProvider, useHotkeys, useRoute, useWorkspace, WorkspaceProvider } from "./lib";
import { IssuesPage } from "./Issues";
import { IssuePanel } from "./IssuePanel";
import { AttentionPage, CapturePage, CyclePage, CyclesPage, InboxPage, ProjectPage, ProjectsPage, SettingsPage } from "./Pages";
import { CommandBar, CreateIssueDialog } from "./Command";

/** Development sign-in: the declared dev users, switchable from the corner. Absent in production. */
function DevIdentity() {
  const { session, signInAsDevUser } = useSession();
  if (!session || !session.devUsers.length) return null;
  return (
    <label className="dev-identity" title="Development only: act as a declared dev user">
      <span className="sr-only">Signed in as</span>
      <select value={session.principal?.id ?? ""} onChange={(e) => e.target.value && void signInAsDevUser(e.target.value)}>
        {!session.principal && <option value="">Choose a dev user</option>}
        {session.devUsers.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.id} (dev)</option>)}
      </select>
    </label>
  );
}

export function App() {
  const auth = useAuth();
  const tenant = useTenant();
  const { redirect } = useAuthRedirect();
  const { session, signInAsDevUser } = useSession();
  // Once an invitation is accepted (or dismissed), carry on into the app.
  const [invitationHandled, setInvitationHandled] = useState(false);
  // Development: sign in as the first dev user so the app opens ready to use.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !session.principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, signInAsDevUser]);

  if (auth.loading) return <div className="boot" aria-busy="true" />;
  if (redirect?.kind === "invitation" && !invitationHandled)
    return (
      <div className="gate">
        <AcceptInvitation brand={{ name: "TaskFlow" }} onAccepted={() => { setInvitationHandled(true); auth.refresh(); tenant.refresh(); }} onDismiss={() => setInvitationHandled(true)} />
        <DevIdentity />
      </div>
    );
  if (!auth.user)
    return (
      <div className="gate">
        <SignIn brand={{ name: "TaskFlow", logo: "/favicon.png" }} />
        <DevIdentity />
      </div>
    );
  if (!tenant.current)
    return (
      <div className="gate">
        <CreateTenant title="Create your workspace" />
        <DevIdentity />
      </div>
    );
  return (
    <ToastProvider>
      <WorkspaceProvider key={tenant.current.id} fallback={<div className="boot" aria-busy="true" />}>
        <Shell />
      </WorkspaceProvider>
    </ToastProvider>
  );
}

function Shell() {
  const route = useRoute();
  const ws = useWorkspace();
  const live = useConnectionState();
  const [command, setCommand] = useState(false);
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useHotkeys({ "mod+k": (e) => { e.preventDefault(); setCommand(true); }, c: (e) => { e.preventDefault(); setCreating(true); }, "/": (e) => { e.preventDefault(); setCommand(true); } });
  useEffect(() => setNavOpen(false), [route.path.join("/")]);

  const [section, id, sub] = route.path;
  const issueId = route.query.get("issue");
  const here = `/${route.path.join("/")}`;
  // A team's root ("/team/x") is active only on itself, not on "/team/x/cycles".
  const nav = (path: string, label: string, extra?: React.ReactNode) => (
    <a className={`nav-item${here === path || (!path.startsWith("/team/") && here.startsWith(`${path}/`)) ? " active" : ""}`} href={href(path)}>
      <span>{label}</span>
      {extra}
    </a>
  );

  let page: React.ReactNode;
  if (section === "inbox") page = <InboxPage />;
  else if (section === "attention") page = <AttentionPage />;
  else if (section === "capture") page = <CapturePage />;
  else if (section === "settings") page = <SettingsPage teamId={id} />;
  else if (section === "projects" && id) page = <ProjectPage projectId={id} />;
  else if (section === "projects") page = <ProjectsPage />;
  else if (section === "cycles" && id) page = <CyclePage cycleId={id} />;
  else if (section === "team" && id && sub === "cycles") page = <CyclesPage teamId={id} />;
  else if (section === "team" && id && sub === "projects") page = <ProjectsPage teamId={id} />;
  else if (section === "team" && id) page = <IssuesPage key={`team-${id}`} scope={{ teamId: id }} title={ws.team(id)?.name ?? "Team"} />;
  else page = <IssuesPage key="mine" scope={{ assigneeId: "me" }} title="My issues" />;

  return (
    <div className={`app${issueId ? " with-panel" : ""}`}>
      <aside className={`sidebar${navOpen ? " open" : ""}`} aria-label="Navigation">
        <div className="sidebar-top">
          <TenantSwitcher className="switcher" />
          <button className="icon-button" onClick={() => setCommand(true)} aria-label="Search (⌘K)" title="Search (⌘K)">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
        <button className="new-issue" onClick={() => setCreating(true)}>New issue <kbd>C</kbd></button>
        <nav className="nav">
          {nav("/inbox", "Inbox", ws.unread ? <span className="count">{ws.unread}</span> : null)}
          {nav("/my-issues", "My issues", ws.overview.myOpenIssues ? <span className="count muted">{ws.overview.myOpenIssues}</span> : null)}
          {nav("/attention", "Needs attention")}
          {nav("/capture", "Capture")}
          {nav("/projects", "Projects")}
        </nav>
        <div className="nav-heading">Your teams</div>
        <nav className="nav">
          {ws.overview.teams.map((t) => (
            <details key={t.id} className="team-nav" open={id === t.id || ws.overview.teams.length <= 3}>
              <summary>
                <span className="team-key">{t.key}</span> {t.name} {t.private && <span title="Private team" aria-label="Private team">🔒</span>}
              </summary>
              {nav(`/team/${t.id}`, "Issues")}
              {nav(`/team/${t.id}/cycles`, "Cycles")}
              {nav(`/team/${t.id}/projects`, "Projects")}
            </details>
          ))}
          {!ws.overview.teams.length && <p className="muted small pad">No teams yet. Create one in Settings.</p>}
        </nav>
        <div className="sidebar-bottom">
          {nav("/settings", "Settings")}
          <div className="me">
            <Avatar id={ws.overview.me.id} size={22} />
            <span className="me-name">{ws.overview.me.name}</span>
            <span className={`live-dot${live ? " on" : ""}`} title={live ? "Live: changes appear as they happen" : "Reconnecting…"} aria-label={live ? "Live" : "Reconnecting"} />
          </div>
          <div className="sidebar-tools">
            <ThemeToggle />
            <DevIdentity />
          </div>
        </div>
      </aside>
      <main className="main">
        <button className="nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu" aria-expanded={navOpen}>☰</button>
        <AuthNotices />
        {page}
      </main>
      {issueId && <IssuePanel issueId={issueId} onClose={() => { const q = new URLSearchParams(route.query); q.delete("issue"); window.location.hash = `${here}${q.toString() ? `?${q}` : ""}`; }} />}
      {command && <CommandBar onClose={() => setCommand(false)} onCreate={() => { setCommand(false); setCreating(true); }} />}
      {creating && <CreateIssueDialog defaultTeamId={section === "team" ? id : undefined} onClose={() => setCreating(false)} onCreated={(issueIdNew) => { setCreating(false); navigate(here, { ...Object.fromEntries(route.query), issue: issueIdNew }); }} />}
    </div>
  );
}
