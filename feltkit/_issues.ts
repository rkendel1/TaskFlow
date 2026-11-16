/**
 * Filing an issue: the one implementation behind issues:create, capture (capture:file) and the
 * assistant. Callers have already passed the resource policy for the team; this applies the domain
 * rules (status of the team, members, references), numbers it from the team's sequence, records
 * history and notifies the assignee, all in the caller's transaction.
 */
import { fail, type MutationCtx } from "@feltdb/feltkit";
import { issues, teams, type ISSUE_TYPES } from "./app.js";
import { checkIssueRefs, issueKey, must, notify, recordIssue, requireMember, teamStates, type Team } from "./_domain.js";

export interface NewIssue {
  teamId: string;
  title: string;
  description?: string;
  stateId?: string;
  priority?: number;
  type?: (typeof ISSUE_TYPES)[number];
  assigneeId?: string;
  labelIds?: string[];
  estimate?: number;
  dueDate?: string;
  projectId?: string;
  milestoneId?: string;
  cycleId?: string;
  parentId?: string;
}

/** `history`: extra facts for the issue.created entry (e.g. it was captured, or filed on someone's behalf). */
export async function createIssue(ctx: MutationCtx, a: NewIssue, options: { history?: Record<string, unknown> } = {}): Promise<{ id: string; key: string }> {
    const me = ctx.auth.requirePrincipal().id;
    const team = must(await ctx.db.get(teams, a.teamId), "team") as Team;
    const states = await teamStates(ctx, team.id);
    const state = a.stateId ? states.find((st) => st.id === a.stateId) : states.find((st) => st.category === "unstarted") ?? states[0];
    if (!state) fail("INVALID_ARGUMENT", a.stateId ? "That status belongs to another team." : "The team has no statuses.");
    if (a.assigneeId) await requireMember(ctx, a.assigneeId);
    await checkIssueRefs(ctx, team.id, { projectId: a.projectId, milestoneId: a.milestoneId, cycleId: a.cycleId, parentId: a.parentId, labelIds: a.labelIds });
    const number = await ctx.db.sequence(`issue:${team.id}`);
    const now = Date.now();
    const id = await ctx.db.insert(issues, {
      teamId: team.id,
      number,
      title: a.title.trim(),
      ...(a.description?.trim() ? { description: a.description.trim() } : {}),
      stateId: state.id,
      priority: a.priority ?? 0,
      type: a.type ?? "issue",
      ...(a.assigneeId ? { assigneeId: a.assigneeId } : {}),
      creatorId: me,
      labelIds: a.labelIds ?? [],
      ...(a.estimate !== undefined ? { estimate: a.estimate } : {}),
      ...(a.dueDate ? { dueDate: a.dueDate } : {}),
      ...(a.projectId ? { projectId: a.projectId } : {}),
      ...(a.milestoneId ? { milestoneId: a.milestoneId } : {}),
      ...(a.cycleId ? { cycleId: a.cycleId } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
      ...(state.category === "completed" ? { completedAt: now } : {}),
      ...(state.category === "canceled" ? { canceledAt: now } : {}),
    });
    const key = issueKey(team, { number });
    await recordIssue(ctx, id, "issue.created", { key, title: a.title.trim(), state: state.name, ...options.history });
    if (a.assigneeId) notify(ctx, [a.assigneeId], { type: "issue.assigned", title: `${key} was assigned to you: ${a.title.trim()}`, issueId: id, issueKey: key });
    return { id, key };
}
