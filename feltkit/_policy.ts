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
 * Every function registers its rule next to its definition (`policy`, below). An unregistered
 * function is refused (default deny), and tests/foundation.test.ts fails if one is missing.
 */
import type { AuthorizeHook, AuthorizeRequest, DatabaseReader, Principal } from "@feltdb/feltkit";
import { comments, cycles, issues, labels, milestones, projects, teamMembers, teams, workflowStates } from "./app.js";

export type Target = "team" | "issue" | "project" | "cycle" | "comment" | "state" | "label" | "milestone";
type Requirement =
  /** The team lead of every target team, or a workspace owner/admin. */
  | "teamLead"
  /** The issue's creator, or a workspace owner/admin. */
  | "issueCreatorOrAdmin"
  /** The comment's author, or a holder of comments.moderate. */
  | "commentAuthorOrModerator";

export interface Rule {
  /** Argument name → what it names. Each one present is resolved and its team checked. */
  targets?: Record<string, Target>;
  require?: Requirement;
  /** The function needs no workspace (the inbox works before one is chosen). */
  noWorkspace?: true;
}

export const ISSUE_REFS: Record<string, Target> = { teamId: "team", stateId: "state", projectId: "project", milestoneId: "milestone", cycleId: "cycle", parentId: "issue" };

/**
 * Rules are bound to the function definitions themselves (`policy(definition, rule)` at the bottom of
 * each function module), never to "<module>:<export>" strings: FeltKit 0.3.30 hands the hook the
 * called function's `definition` (FRAME-GAP-04). Renaming or moving a function keeps its rule, a
 * mistyped binding fails to compile, and a function nobody registered is refused (default deny).
 */
const RULES = new WeakMap<object, Rule>();
const REGISTERED: object[] = [];

/** Register the resource rule of a function (or an application agent's run). */
export function policy(definition: object, rule: Rule): void {
  if (RULES.has(definition)) throw new Error("A function has two resource rules.");
  RULES.set(definition, rule);
  REGISTERED.push(definition);
}

/** The rule a definition was registered with (tests use this to prove coverage). */
export function ruleFor(definition: object): Rule | undefined {
  return RULES.get(definition);
}

/** Every registered definition (tests: no rule without a function). */
export function registeredDefinitions(): readonly object[] {
  return REGISTERED;
}

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
  const rule = request.definition ? RULES.get(request.definition) : undefined;
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
    case "commentAuthorOrModerator": {
      const comment = resolved.get("commentId")?.record;
      if (comment?.authorId === principal.id) return true;
      // comments.moderate is held by owner and admin (feltkit/app.ts).
      return ADMIN_ROLES.has(role) || deny("Only the comment's author or a moderator can delete it.");
    }
  }
};
