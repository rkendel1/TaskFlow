import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { activity, app, cycles, issues, workflowStates } from "./app.js";
import { must, recordIssue, today } from "./_domain.js";
import { policy } from "./_policy.js";

const date = () => s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

function phase(c: { startDate: string; endDate: string }, day: string): "upcoming" | "active" | "completed" {
  return day < c.startDate ? "upcoming" : day > c.endDate ? "completed" : "active";
}

async function progress(ctx: QueryCtx | MutationCtx, cycleId: string) {
  const items = await ctx.db.find(issues, { cycleId });
  let scope = 0, completed = 0, started = 0, points = 0, pointsDone = 0;
  const categories = new Map<string, string>();
  for (const i of items) {
    if (!categories.has(i.stateId)) categories.set(i.stateId, (await ctx.db.get(workflowStates, i.stateId))?.category ?? "backlog");
    const c = categories.get(i.stateId);
    if (c === "canceled") continue;
    scope++;
    points += i.estimate ?? 0;
    if (c === "completed") { completed++; pointsDone += i.estimate ?? 0; }
    if (c === "started") started++;
  }
  return { scope, completed, started, points, pointsDone, percent: scope ? Math.round((completed / scope) * 1000) / 10 : 0 };
}

export const list = app.query({
  access: "issues.read",
  args: { teamId: s.string(), today: s.optional(date()) },
  handler: async (ctx, { teamId, today: day }) => {
    const now = day ?? today();
    const all = await ctx.db.find(cycles, { teamId }, { orderBy: [{ field: "number", direction: "desc" }] });
    return Promise.all(all.map(async (c) => ({ ...c, phase: phase(c, now), progress: await progress(ctx, c.id) })));
  },
});

export const get = app.query({
  access: "issues.read",
  args: { cycleId: s.string(), today: s.optional(date()) },
  handler: async (ctx, { cycleId, today: day }) => {
    const c = must(await ctx.db.get(cycles, cycleId), "cycle");
    return { ...c, phase: phase(c, day ?? today()), progress: await progress(ctx, cycleId), history: await activity.history(ctx, "cycle", cycleId, { limit: 100 }) };
  },
});

export const create = app.mutation({
  access: "cycles.write",
  args: { teamId: s.string(), name: s.optional(s.string({ maxLength: 60 })), startDate: date(), endDate: date() },
  returns: s.string(),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { teamId, name, startDate, endDate }) => {
    if (endDate < startDate) fail("INVALID_ARGUMENT", "A cycle ends after it starts.");
    for (const c of await ctx.db.find(cycles, { teamId })) {
      if (startDate <= c.endDate && endDate >= c.startDate) fail("FAILED_PRECONDITION", `It overlaps cycle ${c.number} (${c.startDate} – ${c.endDate}).`);
    }
    const number = await ctx.db.sequence(`cycle:${teamId}`);
    const id = await ctx.db.insert(cycles, { teamId, number, ...(name ? { name } : {}), startDate, endDate, createdBy: ctx.auth.requirePrincipal().id });
    await activity.record(ctx, { subject: "cycle", id, type: "cycle.created", data: { number, startDate, endDate } });
    return id;
  },
});

/** Add issues to a cycle. Each must be in the cycle's team: a cycle is a team's. */
export const addIssues = app.mutation({
  access: "cycles.write",
  args: { cycleId: s.string(), issueIds: s.array(s.string()) },
  handler: async (ctx, { cycleId, issueIds }) => {
    if (issueIds.length > 500) fail("INVALID_ARGUMENT", "Add at most 500 issues at a time.");
    const cycle = must(await ctx.db.get(cycles, cycleId), "cycle");
    for (const issueId of issueIds) {
      // Read through the tenant-scoped reader: another workspace's issue is NOT_FOUND here.
      const issue = await ctx.db.get(issues, issueId);
      if (!issue) fail("NOT_FOUND", `No such issue ${issueId}.`);
      if (issue.teamId !== cycle.teamId) fail("INVALID_ARGUMENT", "An issue joins only a cycle of its own team.");
      if (issue.cycleId === cycleId) continue;
      await ctx.db.patch(issues, issueId, { cycleId, updatedAt: Date.now() });
      await recordIssue(ctx, issueId, "issue.updated", { field: "cycleId", from: issue.cycleId ?? null, to: cycleId });
      await activity.record(ctx, { subject: "cycle", id: cycleId, type: "cycle.issue_added", data: { issueId } });
    }
  },
});

export const removeIssues = app.mutation({
  access: "cycles.write",
  args: { cycleId: s.string(), issueIds: s.array(s.string()) },
  handler: async (ctx, { cycleId, issueIds }) => {
    for (const issueId of issueIds) {
      const issue = await ctx.db.get(issues, issueId);
      if (!issue || issue.cycleId !== cycleId) continue;
      await ctx.db.patch(issues, issueId, { cycleId: undefined, updatedAt: Date.now() });
      await recordIssue(ctx, issueId, "issue.updated", { field: "cycleId", from: cycleId, to: null });
      await activity.record(ctx, { subject: "cycle", id: cycleId, type: "cycle.issue_removed", data: { issueId } });
    }
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(list, { targets: { teamId: "team" } });
policy(get, { targets: { cycleId: "cycle" } });
policy(create, { targets: { teamId: "team" } });
policy(addIssues, { targets: { cycleId: "cycle" } });
policy(removeIssues, { targets: { cycleId: "cycle" } });
