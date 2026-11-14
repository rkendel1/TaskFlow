/**
 * Domain rules shared by function modules. Not authorization: who may act on what is decided by
 * `_policy.ts` before a handler runs. These are rules about the data itself.
 */
import { fail, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import type { Doc } from "@feltdb/feltkit";
import { activity, cycles, issues, labels, milestones, projects, teams, workflowStates, STATE_CATEGORIES } from "./app.js";
import { canReachTeam } from "./_policy.js";

type Ctx = QueryCtx | MutationCtx;
export type Issue = Doc<typeof issues.shape> & { id: string; __version: number };
export type Team = Doc<typeof teams.shape> & { id: string; __version: number };
export type State = Doc<typeof workflowStates.shape> & { id: string };
export type Category = (typeof STATE_CATEGORIES)[number];

export const OPEN: ReadonlySet<Category> = new Set(["backlog", "unstarted", "started"]);
export const DONE: ReadonlySet<Category> = new Set(["completed", "canceled"]);

export const DEFAULT_STATES: ReadonlyArray<{ name: string; category: Category; color: string }> = [
  { name: "Backlog", category: "backlog", color: "#a1a1aa" },
  { name: "Todo", category: "unstarted", color: "#71717a" },
  { name: "In Progress", category: "started", color: "#eab308" },
  { name: "In Review", category: "started", color: "#22c55e" },
  { name: "Done", category: "completed", color: "#6366f1" },
  { name: "Canceled", category: "canceled", color: "#9ca3af" },
];

export function issueKey(team: { key: string }, issue: { number: number }): string {
  return `${team.key}-${issue.number}`;
}

/** Today's date (UTC) as YYYY-MM-DD. Callers may pass their own local date instead. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A record the policy already resolved. Absent means the policy and the handler disagree: a bug, not a 404. */
export function must<T>(record: T | null | undefined, what: string): T {
  if (!record) fail("INTERNAL", `${what} passed the policy but could not be read.`);
  return record;
}

/** The workspace member ids (people and agents), read live: removed members drop out on the next call. */
export async function memberIds(ctx: Ctx): Promise<Set<string>> {
  return new Set((await ctx.tenancy.members()).map((m) => m.principalId));
}

export async function requireMember(ctx: Ctx, userId: string, what = "assignee"): Promise<void> {
  if (!(await memberIds(ctx)).has(userId)) fail("INVALID_ARGUMENT", `The ${what} is not a member of this workspace.`);
}

/** Teams the caller can reach (all of them for owners and admins). */
export async function reachableTeams(ctx: Ctx): Promise<Team[]> {
  const principal = ctx.auth.requirePrincipal();
  const all = (await ctx.db.find(teams, {}, { orderBy: [{ field: "key", direction: "asc" }] })) as Team[];
  const out: Team[] = [];
  for (const team of all) if (await canReachTeam(ctx.db, principal, team)) out.push(team);
  return out;
}

export async function teamStates(ctx: Ctx, teamId: string): Promise<State[]> {
  return (await ctx.db.find(workflowStates, { teamId }, { orderBy: [{ field: "position", direction: "asc" }] })) as State[];
}

/**
 * The references an issue may hold, checked against the issue's team. The policy has already
 * proved the caller can reach each one; this proves they belong together (a cycle of the same
 * team, a milestone of the chosen project, a label of this team or the workspace).
 *
 * Every reference is read through the tenant-scoped reader on purpose: FeltDB accepts an `s.ref`
 * to another workspace's record (docs/GAP-REGISTER.md TF-GAP-02).
 */
export async function checkIssueRefs(
  ctx: Ctx,
  teamId: string,
  refs: { stateId?: string; projectId?: string | null; milestoneId?: string | null; cycleId?: string | null; parentId?: string | null; labelIds?: string[]; selfId?: string },
): Promise<void> {
  if (refs.stateId) {
    const state = await ctx.db.get(workflowStates, refs.stateId);
    if (!state || state.teamId !== teamId) fail("INVALID_ARGUMENT", "That status belongs to another team.");
  }
  if (refs.projectId) {
    const project = await ctx.db.get(projects, refs.projectId);
    if (!project) fail("NOT_FOUND", "No such project.");
  }
  if (refs.milestoneId) {
    const milestone = await ctx.db.get(milestones, refs.milestoneId);
    if (!milestone) fail("NOT_FOUND", "No such milestone.");
    if (!refs.projectId || milestone.projectId !== refs.projectId) fail("INVALID_ARGUMENT", "A milestone must belong to the issue's project.");
  }
  if (refs.cycleId) {
    const cycle = await ctx.db.get(cycles, refs.cycleId);
    if (!cycle || cycle.teamId !== teamId) fail("INVALID_ARGUMENT", "A cycle must belong to the issue's team.");
  }
  if (refs.parentId) {
    if (refs.parentId === refs.selfId) fail("INVALID_ARGUMENT", "An issue cannot be its own parent.");
    const parent = await ctx.db.get(issues, refs.parentId);
    if (!parent) fail("NOT_FOUND", "No such parent issue.");
    // No cycles in the hierarchy.
    let cursor: string | undefined = parent.parentId;
    for (let depth = 0; cursor && depth < 50; depth++) {
      if (cursor === refs.selfId) fail("INVALID_ARGUMENT", "That would make the issue its own ancestor.");
      cursor = (await ctx.db.get(issues, cursor))?.parentId;
    }
  }
  for (const labelId of refs.labelIds ?? []) {
    const label = await ctx.db.get(labels, labelId);
    if (!label || (label.teamId && label.teamId !== teamId)) fail("INVALID_ARGUMENT", "A label must belong to the workspace or to the issue's team.");
  }
}

/** One field change in the activity trail, committed with the change. */
export async function recordIssue(ctx: MutationCtx, issueId: string, type: string, data?: Record<string, unknown>): Promise<void> {
  await activity.record(ctx, { subject: "issue", id: issueId, type, ...(data ? { data } : {}) });
}

/**
 * Notify people about an issue, after the mutation commits (never for one that does not).
 * The actor is never notified of their own change. The notification carries the workspace so
 * the inbox can show the current workspace's (AppPort Services notifications are per recipient,
 * not per workspace: docs/GAP-REGISTER.md TF-GAP-05).
 */
export function notify(
  ctx: MutationCtx,
  recipients: Iterable<string | undefined>,
  input: { type: string; title: string; body?: string; issueId: string; issueKey: string },
): void {
  const actor = ctx.auth.requirePrincipal().id;
  const workspaceId = ctx.auth.tenant?.id;
  for (const recipient of new Set(recipients)) {
    if (!recipient || recipient === actor) continue;
    ctx.afterCommit.notifications.send({
      recipient,
      type: input.type,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      data: { workspaceId, issueId: input.issueId, issueKey: input.issueKey, actor },
      idempotencyKey: `${input.type}:${input.issueId}:${ctx.requestId}:${recipient}`,
    });
  }
}

/** Mentions are written `@[Name](principalId)`; only workspace members count. */
export function parseMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/@\[[^\]]{1,80}\]\(([A-Za-z0-9_.:@-]{1,128})\)/g)) ids.add(m[1]!);
  return [...ids];
}
