/**
 * TaskFlow's resource policy: the one `feltkit({ authorize })` hook.
 *
 * Roles (feltkit/app.ts) decide whether a caller may call a function at all. This hook decides
 * whether the caller may act on *the records named in the arguments*. It runs on every interface
 * (HTTP, AppPort, MCP, agent actions) after roles and argument validation, reading through the
 * call's own tenant-scoped reader, so:
 *   - another workspace's record does not exist here (NOT_FOUND);
 *   - its reads are fenced at commit (a team membership removed mid-call fails the mutation);
 *   - a live query re-runs, and is refused, when the caller loses access.
 *
 * Every function is registered in RULES. An unregistered function is refused (default deny), and
 * tests/policy.test.ts fails if a function is added without a rule.
 */
import type { AuthorizeHook, AuthorizeRequest, DatabaseReader, Principal } from "@feltdb/feltkit";
import { comments, cycles, issues, labels, milestones, projects, teamMembers, teams, workflowStates } from "./app.js";

type Target = "team" | "issue" | "project" | "cycle" | "comment" | "state" | "label" | "milestone";
type Requirement =
  /** The team lead of every target team, or a workspace owner/admin. */
  | "teamLead"
  /** The issue's creator, or a workspace owner/admin. */
  | "issueCreatorOrAdmin"
  /** The comment's author. */
  | "commentAuthor"
  /** The comment's author, or a holder of comments.moderate. */
  | "commentAuthorOrModerator";

interface Rule {
  /** Argument name → what it names. Each one present is resolved and its team checked. */
  targets?: Record<string, Target>;
  require?: Requirement;
  /** The function needs no workspace (the inbox works before one is chosen). */
  noWorkspace?: true;
}

const ISSUE_REFS: Record<string, Target> = { teamId: "team", stateId: "state", projectId: "project", milestoneId: "milestone", cycleId: "cycle", parentId: "issue" };

/** "<module>:<export>" → rule. Workspace-level functions have no targets. */
export const RULES: Record<string, Rule> = {
  // workspace
  "workspace:overview": {},
  "workspace:members": {},
  "workspace:settings": {},
  "workspace:updateSettings": {},
  "seed:demo": {},
  // teams
  "teams:list": {},
  "teams:get": { targets: { teamId: "team" } },
  "teams:create": {},
  "teams:update": { targets: { teamId: "team" }, require: "teamLead" },
  "teams:addMember": { targets: { teamId: "team" }, require: "teamLead" },
  "teams:removeMember": { targets: { teamId: "team" }, require: "teamLead" },
  "teams:join": { targets: { teamId: "team" } },
  "teams:addState": { targets: { teamId: "team" }, require: "teamLead" },
  "teams:updateState": { targets: { stateId: "state" }, require: "teamLead" },
  // labels
  "labels:list": {},
  "labels:create": { targets: { teamId: "team" } },
  // projects
  "projects:list": { targets: { teamId: "team" } },
  "projects:create": { targets: { teamId: "team" } },
  "projects:update": { targets: { projectId: "project" } },
  "projects:summary": { targets: { projectId: "project" } },
  "projects:addMilestone": { targets: { projectId: "project" } },
  "projects:updateMilestone": { targets: { milestoneId: "milestone" } },
  "projects:removeMilestone": { targets: { milestoneId: "milestone" } },
  // cycles
  "cycles:list": { targets: { teamId: "team" } },
  "cycles:get": { targets: { cycleId: "cycle" } },
  "cycles:create": { targets: { teamId: "team" } },
  "cycles:addIssues": { targets: { cycleId: "cycle" } },
  "cycles:removeIssues": { targets: { cycleId: "cycle" } },
  // issues
  "issues:list": { targets: { teamId: "team", projectId: "project", cycleId: "cycle" } },
  "issues:search": {},
  "issues:get": { targets: { issueId: "issue" } },
  "issues:create": { targets: ISSUE_REFS },
  "issues:update": { targets: { issueId: "issue", ...ISSUE_REFS } },
  "issues:assign": { targets: { issueId: "issue" } },
  "issues:setStatus": { targets: { issueId: "issue" } },
  "issues:close": { targets: { issueId: "issue" } },
  "issues:reopen": { targets: { issueId: "issue" } },
  "issues:move": { targets: { issueId: "issue", stateId: "state" } },
  "issues:addRelation": { targets: { issueId: "issue", blockedId: "issue" } },
  "issues:removeRelation": { targets: { issueId: "issue", blockedId: "issue" } },
  "issues:remove": { targets: { issueId: "issue" }, require: "issueCreatorOrAdmin" },
  "issues:attention": { targets: { teamId: "team" } },
  // comments
  "comments:add": { targets: { issueId: "issue" } },
  "comments:edit": { targets: { commentId: "comment" }, require: "commentAuthor" },
  "comments:remove": { targets: { commentId: "comment" }, require: "commentAuthorOrModerator" },
  // attachments (files carry their issue in metadata; the issue is the resource)
  "attachments:list": { targets: { issueId: "issue" } },
  "attachments:uploadLink": { targets: { issueId: "issue" } },
  "attachments:attach": { targets: { issueId: "issue" } },
  "attachments:download": { targets: { issueId: "issue" } },
  "attachments:remove": { targets: { issueId: "issue" } },
  // inbox (AppPort Services notifications are per recipient; the service enforces it)
  "inbox:list": { noWorkspace: true },
  "inbox:markRead": { noWorkspace: true },
  "inbox:markAllRead": {},
};

const ADMIN_ROLES = new Set(["owner", "admin"]);

const deny = (reason: string, code: "FORBIDDEN" | "NOT_FOUND" = "FORBIDDEN") => ({ allowed: false as const, code, reason });

/** The team a target belongs to, or null when it does not exist in this workspace. */
async function teamOf(db: DatabaseReader, kind: Target, id: string): Promise<{ teamId: string; record: Record<string, unknown> } | null> {
  switch (kind) {
    case "team": {
      const t = await db.get(teams, id);
      return t ? { teamId: t.id, record: t } : null;
    }
    case "issue": {
      const r = await db.get(issues, id);
      return r ? { teamId: r.teamId, record: r } : null;
    }
    case "project": {
      const r = await db.get(projects, id);
      return r ? { teamId: r.teamId, record: r } : null;
    }
    case "cycle": {
      const r = await db.get(cycles, id);
      return r ? { teamId: r.teamId, record: r } : null;
    }
    case "state": {
      const r = await db.get(workflowStates, id);
      return r ? { teamId: r.teamId, record: r } : null;
    }
    case "milestone": {
      const r = await db.get(milestones, id);
      if (!r) return null;
      const p = await db.get(projects, r.projectId);
      return p ? { teamId: p.teamId, record: r } : null;
    }
    case "comment": {
      const r = await db.get(comments, id);
      if (!r) return null;
      const i = await db.get(issues, r.issueId);
      return i ? { teamId: i.teamId, record: r } : null;
    }
    case "label": {
      const r = await db.get(labels, id);
      return r ? { teamId: r.teamId ?? "", record: r } : null;
    }
  }
}

/** The caller's membership in a team, or null. */
export async function teamMembership(db: DatabaseReader, teamId: string, userId: string) {
  const [m] = await db.find(teamMembers, { teamId, userId });
  return m ?? null;
}

/**
 * Whether `principal` may reach `team`: owners and admins reach every team; guests only teams
 * they belong to; everyone else every public team and the private teams they belong to.
 */
export async function canReachTeam(db: DatabaseReader, principal: Principal, team: { id: string; private: boolean }): Promise<boolean> {
  const role = principal.tenant?.role ?? "";
  if (ADMIN_ROLES.has(role)) return true;
  if (!team.private && role !== "guest") return true;
  return (await teamMembership(db, team.id, principal.id)) !== null;
}

export const authorize: AuthorizeHook = async (request: AuthorizeRequest) => {
  const rule = RULES[request.function];
  // Default deny: a function nobody wrote a rule for is not callable.
  if (!rule) return deny(`No resource policy for ${request.function}.`);
  const principal = request.principal;
  if (!principal) return deny("Sign in.");
  if (!principal.tenant && !rule.noWorkspace) return deny("Choose a workspace first.");
  // A workspace is the session's, never an argument.
  if ("workspaceId" in request.args) return deny("The workspace comes from your session, not from the request.");

  const { db, args } = request;
  const reachedTeams = new Map<string, { id: string; private: boolean }>();
  const resolved = new Map<string, { teamId: string; record: Record<string, unknown> }>();
  for (const [arg, kind] of Object.entries(rule.targets ?? {})) {
    const id = args[arg];
    if (id === undefined || id === null || id === "") continue;
    if (typeof id !== "string") return deny(`${arg} must be an id.`);
    const found = await teamOf(db, kind, id);
    // Unknown, or in another workspace: indistinguishable on purpose.
    if (!found) return deny(`No such ${kind}.`, "NOT_FOUND");
    resolved.set(arg, found);
    if (!found.teamId) continue; // a workspace-wide label
    if (!reachedTeams.has(found.teamId)) {
      const team = await db.get(teams, found.teamId);
      if (!team || !(await canReachTeam(db, principal, team))) return deny(`No such ${kind}.`, "NOT_FOUND");
      reachedTeams.set(team.id, team);
    }
  }

  const role = principal.tenant?.role ?? "";
  switch (rule.require) {
    case undefined:
      return true;
    case "teamLead": {
      if (ADMIN_ROLES.has(role)) return true;
      for (const teamId of reachedTeams.keys()) {
        const m = await teamMembership(db, teamId, principal.id);
        if (m?.role !== "lead") return deny("Only the team's lead or a workspace admin can change the team.");
      }
      return reachedTeams.size > 0 || deny("No team named.");
    }
    case "issueCreatorOrAdmin": {
      const issue = resolved.get("issueId")?.record;
      if (!issue) return deny("No issue named.");
      if (ADMIN_ROLES.has(role) || issue.creatorId === principal.id) return true;
      return deny("Only the issue's creator or a workspace admin can delete it.");
    }
    case "commentAuthor": {
      const comment = resolved.get("commentId")?.record;
      return comment?.authorId === principal.id || deny("Only the comment's author can edit it.");
    }
    case "commentAuthorOrModerator": {
      const comment = resolved.get("commentId")?.record;
      if (comment?.authorId === principal.id) return true;
      // comments.moderate is held by owner and admin (feltkit/app.ts).
      return ADMIN_ROLES.has(role) || deny("Only the comment's author or a moderator can delete it.");
    }
  }
};
