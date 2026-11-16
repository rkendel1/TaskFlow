import { fail, s } from "@feltdb/feltkit";
import { activity, app, issues, milestones, projects, workflowStates, PROJECT_STATUSES, STATE_CATEGORIES } from "./app.js";
import { must, reachableTeams, requireMember, today } from "./_domain.js";
import { policy } from "./_policy.js";

const date = () => s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Progress = s.object({ total: s.integer(), completed: s.integer(), started: s.integer(), canceled: s.integer(), percent: s.number() });

type Category = (typeof STATE_CATEGORIES)[number];

/** Progress by state category. Canceled issues leave the scope, as in Linear. */
async function progressOf(ctx: Parameters<typeof reachableTeams>[0], items: Array<{ stateId: string; estimate?: number }>) {
  const categories = new Map<string, Category>();
  let total = 0, completed = 0, started = 0, canceled = 0;
  for (const i of items) {
    if (!categories.has(i.stateId)) categories.set(i.stateId, (await ctx.db.get(workflowStates, i.stateId))?.category ?? "backlog");
    const c = categories.get(i.stateId)!;
    if (c === "canceled") { canceled++; continue; }
    total++;
    if (c === "completed") completed++;
    if (c === "started") started++;
  }
  return { total, completed, started, canceled, percent: total ? Math.round((completed / total) * 1000) / 10 : 0 };
}

export const list = app.query({
  access: "projects.read",
  args: { teamId: s.optional(s.string()) },
  handler: async (ctx, { teamId }) => {
    const teamIds = teamId ? [teamId] : (await reachableTeams(ctx)).map((t) => t.id);
    const out = [];
    for (const id of teamIds) {
      for (const p of await ctx.db.find(projects, { teamId: id }, { orderBy: [{ field: "createdAt", direction: "desc" }] })) {
        out.push({ ...p, progress: await progressOf(ctx, await ctx.db.find(issues, { projectId: p.id })) });
      }
    }
    return out;
  },
});

export const create = app.mutation({
  access: "projects.write",
  args: {
    teamId: s.string(),
    name: s.string({ minLength: 1, maxLength: 80 }),
    description: s.optional(s.string({ maxLength: 4000 })),
    status: s.optional(s.enum(PROJECT_STATUSES)),
    leadId: s.optional(s.string()),
    startDate: s.optional(date()),
    targetDate: s.optional(date()),
  },
  returns: s.string(),
  handler: async (ctx, a) => {
    if (a.leadId) await requireMember(ctx, a.leadId, "lead");
    if (a.startDate && a.targetDate && a.targetDate < a.startDate) fail("INVALID_ARGUMENT", "The target date is before the start date.");
    const now = Date.now();
    const id = await ctx.db.insert(projects, {
      teamId: a.teamId,
      name: a.name.trim(),
      ...(a.description ? { description: a.description } : {}),
      status: a.status ?? "planned",
      ...(a.leadId ? { leadId: a.leadId } : {}),
      ...(a.startDate ? { startDate: a.startDate } : {}),
      ...(a.targetDate ? { targetDate: a.targetDate } : {}),
      createdBy: ctx.auth.requirePrincipal().id,
      createdAt: now,
      updatedAt: now,
    });
    await activity.record(ctx, { subject: "project", id, type: "project.created", data: { name: a.name.trim() } });
    return id;
  },
});

export const update = app.mutation({
  access: "projects.write",
  args: {
    projectId: s.string(),
    name: s.optional(s.string({ minLength: 1, maxLength: 80 })),
    description: s.optional(s.nullable(s.string({ maxLength: 4000 }))),
    status: s.optional(s.enum(PROJECT_STATUSES)),
    leadId: s.optional(s.nullable(s.string())),
    startDate: s.optional(s.nullable(date())),
    targetDate: s.optional(s.nullable(date())),
  },
  handler: async (ctx, { projectId, ...changes }) => {
    const project = must(await ctx.db.get(projects, projectId), "project");
    if (changes.leadId) await requireMember(ctx, changes.leadId, "lead");
    const patch: Record<string, unknown> = {};
    for (const [field, to] of Object.entries(changes)) {
      if (to === undefined) continue;
      const from = (project as Record<string, unknown>)[field];
      if ((from ?? null) === to) continue;
      patch[field] = to === null ? undefined : to;
      await activity.record(ctx, { subject: "project", id: projectId, type: field === "status" ? "project.status_changed" : "project.updated", data: { field, from: field === "description" ? null : (from ?? null), to: field === "description" ? null : to } });
    }
    const start = (patch.startDate ?? project.startDate) as string | undefined;
    const target = (patch.targetDate ?? project.targetDate) as string | undefined;
    if (start && target && target < start) fail("INVALID_ARGUMENT", "The target date is before the start date.");
    if (Object.keys(patch).length) await ctx.db.patch(projects, projectId, { ...patch, updatedAt: Date.now() });
  },
});

/** A project's overview: progress overall and per milestone, status mix, and its history. */
export const summary = app.query({
  access: "projects.read",
  args: { projectId: s.string() },
  returns: s.object({
    id: s.string(),
    name: s.string(),
    status: s.enum(PROJECT_STATUSES),
    teamId: s.string(),
    leadId: s.optional(s.string()),
    startDate: s.optional(s.string()),
    targetDate: s.optional(s.string()),
    description: s.optional(s.string()),
    overdue: s.boolean(),
    progress: Progress,
    milestones: s.array(s.object({ id: s.string(), name: s.string(), targetDate: s.optional(s.string()), progress: Progress })),
    unassignedToMilestone: Progress,
    history: s.array(s.object({ type: s.string(), actor: s.string(), at: s.number(), data: s.optional(s.record(s.unknown())) })),
  }),
  capability: { name: "projects.summary", description: "A project's progress (issues completed of its scope), per milestone, whether it is past its target date, and its history." },
  handler: async (ctx, { projectId }) => {
    const p = must(await ctx.db.get(projects, projectId), "project");
    const items = await ctx.db.find(issues, { projectId });
    const ms = await ctx.db.find(milestones, { projectId }, { orderBy: [{ field: "position", direction: "asc" }] });
    const progress = await progressOf(ctx, items);
    const history = await activity.history(ctx, "project", projectId, { limit: 100 });
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      teamId: p.teamId,
      ...(p.leadId ? { leadId: p.leadId } : {}),
      ...(p.startDate ? { startDate: p.startDate } : {}),
      ...(p.targetDate ? { targetDate: p.targetDate } : {}),
      ...(p.description ? { description: p.description } : {}),
      overdue: Boolean(p.targetDate && p.targetDate < today() && p.status !== "completed" && p.status !== "canceled" && progress.percent < 100),
      progress,
      milestones: await Promise.all(ms.map(async (m) => ({ id: m.id, name: m.name, ...(m.targetDate ? { targetDate: m.targetDate } : {}), progress: await progressOf(ctx, items.filter((i) => i.milestoneId === m.id)) }))),
      unassignedToMilestone: await progressOf(ctx, items.filter((i) => !i.milestoneId)),
      history: history.map((h) => ({ type: h.type, actor: h.actor, at: h.at, ...(h.data ? { data: h.data } : {}) })),
    };
  },
});

export const addMilestone = app.mutation({
  access: "projects.write",
  args: { projectId: s.string(), name: s.string({ minLength: 1, maxLength: 80 }), targetDate: s.optional(date()) },
  returns: s.string(),
  handler: async (ctx, { projectId, name, targetDate }) => {
    const existing = await ctx.db.find(milestones, { projectId });
    const id = await ctx.db.insert(milestones, { projectId, name: name.trim(), ...(targetDate ? { targetDate } : {}), position: existing.length });
    await activity.record(ctx, { subject: "project", id: projectId, type: "project.milestone_added", data: { milestoneId: id, name: name.trim() } });
    return id;
  },
});

export const updateMilestone = app.mutation({
  access: "projects.write",
  args: { milestoneId: s.string(), name: s.optional(s.string({ minLength: 1, maxLength: 80 })), targetDate: s.optional(s.nullable(date())) },
  handler: async (ctx, { milestoneId, name, targetDate }) => {
    const m = must(await ctx.db.get(milestones, milestoneId), "milestone");
    await ctx.db.patch(milestones, milestoneId, { ...(name ? { name: name.trim() } : {}), ...(targetDate !== undefined ? { targetDate: targetDate ?? undefined } : {}) });
    await activity.record(ctx, { subject: "project", id: m.projectId, type: "project.milestone_updated", data: { milestoneId, ...(name ? { name } : {}), ...(targetDate !== undefined ? { targetDate } : {}) } });
  },
});

/** Remove a milestone; its issues stay in the project, without a milestone. */
export const removeMilestone = app.mutation({
  access: "projects.write",
  args: { milestoneId: s.string() },
  handler: async (ctx, { milestoneId }) => {
    const m = must(await ctx.db.get(milestones, milestoneId), "milestone");
    for (const i of await ctx.db.find(issues, { projectId: m.projectId })) if (i.milestoneId === milestoneId) await ctx.db.patch(issues, i.id, { milestoneId: undefined, updatedAt: Date.now() });
    await ctx.db.delete(milestones, milestoneId);
    await activity.record(ctx, { subject: "project", id: m.projectId, type: "project.milestone_removed", data: { milestoneId, name: m.name } });
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(list, { targets: { teamId: "team" } });
policy(create, { targets: { teamId: "team" } });
policy(update, { targets: { projectId: "project" } });
policy(summary, { targets: { projectId: "project" } });
policy(addMilestone, { targets: { projectId: "project" } });
policy(updateMilestone, { targets: { milestoneId: "milestone" } });
policy(removeMilestone, { targets: { milestoneId: "milestone" } });
