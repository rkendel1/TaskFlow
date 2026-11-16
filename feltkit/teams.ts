import { fail, s } from "@feltdb/feltkit";
import { activity, app, teamMembers, teams, workflowStates, STATE_CATEGORIES } from "./app.js";
import { DEFAULT_STATES, must, requireMember, reachableTeams, teamStates } from "./_domain.js";
import { policy } from "./_policy.js";

/** Teams I can reach, with their members and workflow. */
export const list = app.query({
  access: "workspace.read",
  handler: async (ctx) => {
    const out = [];
    for (const team of await reachableTeams(ctx)) {
      const members = await ctx.db.find(teamMembers, { teamId: team.id });
      out.push({ ...team, members: members.map((m) => ({ userId: m.userId, role: m.role })), states: await teamStates(ctx, team.id) });
    }
    return out;
  },
});

export const get = app.query({
  access: "workspace.read",
  args: { teamId: s.string() },
  handler: async (ctx, { teamId }) => {
    const team = must(await ctx.db.get(teams, teamId), "team");
    const members = await ctx.db.find(teamMembers, { teamId });
    return { ...team, members: members.map((m) => ({ userId: m.userId, role: m.role })), states: await teamStates(ctx, teamId), history: await activity.history(ctx, "team", teamId, { limit: 50 }) };
  },
});

export const create = app.mutation({
  access: "teams.write",
  args: {
    key: s.string({ pattern: "^[A-Z][A-Z0-9]{1,4}$" }),
    name: s.string({ minLength: 1, maxLength: 60 }),
    description: s.optional(s.string({ maxLength: 500 })),
    private: s.optional(s.boolean()),
  },
  returns: s.string(),
  handler: async (ctx, { key, name, description, private: isPrivate }) => {
    const me = ctx.auth.requirePrincipal().id;
    // Unique per workspace, checked here: FeltKit's `unique` spans workspaces (TF-GAP-01). A concurrent
    // create of the same key read the same (empty) result, so one of the two commits fails with CONFLICT.
    if ((await ctx.db.find(teams, { key })).length) fail("CONFLICT", `A team with the key ${key} already exists in this workspace.`);
    const teamId = await ctx.db.insert(teams, { key, name: name.trim(), ...(description ? { description } : {}), private: isPrivate ?? false, createdBy: me, createdAt: Date.now() });
    await ctx.db.insert(teamMembers, { teamId, userId: me, role: "lead", addedBy: me, addedAt: Date.now() });
    for (const [position, st] of DEFAULT_STATES.entries()) await ctx.db.insert(workflowStates, { teamId, ...st, position });
    await activity.record(ctx, { subject: "team", id: teamId, type: "team.created", data: { key, name } });
    return teamId;
  },
});

export const update = app.mutation({
  access: "teams.write",
  args: { teamId: s.string(), name: s.optional(s.string({ minLength: 1, maxLength: 60 })), description: s.optional(s.string({ maxLength: 500 })), private: s.optional(s.boolean()) },
  handler: async (ctx, { teamId, ...changes }) => {
    const team = must(await ctx.db.get(teams, teamId), "team");
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(changes)) if (value !== undefined && (team as Record<string, unknown>)[field] !== value) patch[field] = value;
    if (!Object.keys(patch).length) return;
    await ctx.db.patch(teams, teamId, patch);
    for (const [field, to] of Object.entries(patch)) await activity.record(ctx, { subject: "team", id: teamId, type: "team.updated", data: { field, from: (team as Record<string, unknown>)[field] ?? null, to } });
  },
});

export const addMember = app.mutation({
  access: "teams.write",
  args: { teamId: s.string(), userId: s.string(), role: s.optional(s.enum(["lead", "member"])) },
  handler: async (ctx, { teamId, userId, role }) => {
    await requireMember(ctx, userId, "person");
    const [existing] = await ctx.db.find(teamMembers, { teamId, userId });
    const me = ctx.auth.requirePrincipal().id;
    if (existing) {
      if (role && existing.role !== role) await ctx.db.patch(teamMembers, existing.id, { role });
    } else {
      await ctx.db.insert(teamMembers, { teamId, userId, role: role ?? "member", addedBy: me, addedAt: Date.now() });
    }
    await activity.record(ctx, { subject: "team", id: teamId, type: "team.member_added", data: { userId, role: role ?? existing?.role ?? "member" } });
  },
});

export const removeMember = app.mutation({
  access: "teams.write",
  args: { teamId: s.string(), userId: s.string() },
  handler: async (ctx, { teamId, userId }) => {
    const members = await ctx.db.find(teamMembers, { teamId });
    const target = members.find((m) => m.userId === userId);
    if (!target) fail("NOT_FOUND", "That person is not on the team.");
    if (target.role === "lead" && members.filter((m) => m.role === "lead").length === 1) fail("FAILED_PRECONDITION", "A team keeps at least one lead. Make someone else lead first.");
    await ctx.db.delete(teamMembers, target.id);
    await activity.record(ctx, { subject: "team", id: teamId, type: "team.member_removed", data: { userId } });
  },
});

/** Join a public team (the policy only lets you reach teams you may see). */
export const join = app.mutation({
  access: "teams.write",
  args: { teamId: s.string() },
  handler: async (ctx, { teamId }) => {
    const me = ctx.auth.requirePrincipal().id;
    if ((await ctx.db.find(teamMembers, { teamId, userId: me })).length) return;
    await ctx.db.insert(teamMembers, { teamId, userId: me, role: "member", addedBy: me, addedAt: Date.now() });
    await activity.record(ctx, { subject: "team", id: teamId, type: "team.member_added", data: { userId: me, role: "member" } });
  },
});

export const addState = app.mutation({
  access: "teams.write",
  args: { teamId: s.string(), name: s.string({ minLength: 1, maxLength: 40 }), category: s.enum(STATE_CATEGORIES), color: s.optional(s.string({ maxLength: 20 })) },
  returns: s.string(),
  handler: async (ctx, { teamId, name, category, color }) => {
    const states = await teamStates(ctx, teamId);
    if (states.some((st) => st.name.toLowerCase() === name.trim().toLowerCase())) fail("CONFLICT", `The team already has a status called ${name}.`);
    const position = states.length ? Math.max(...states.map((st) => st.position)) + 1 : 0;
    const id = await ctx.db.insert(workflowStates, { teamId, name: name.trim(), category, color: color ?? "#71717a", position });
    await activity.record(ctx, { subject: "team", id: teamId, type: "team.state_added", data: { name, category } });
    return id;
  },
});

export const updateState = app.mutation({
  access: "teams.write",
  args: { stateId: s.string(), name: s.optional(s.string({ minLength: 1, maxLength: 40 })), color: s.optional(s.string({ maxLength: 20 })), position: s.optional(s.number()) },
  handler: async (ctx, { stateId, ...changes }) => {
    const state = must(await ctx.db.get(workflowStates, stateId), "state");
    const patch = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length) await ctx.db.patch(workflowStates, stateId, patch);
    await activity.record(ctx, { subject: "team", id: state.teamId, type: "team.state_updated", data: { stateId, ...patch } });
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(list, {});
policy(get, { targets: { teamId: "team" } });
policy(create, {});
policy(update, { targets: { teamId: "team" }, require: "teamLead" });
policy(addMember, { targets: { teamId: "team" }, require: "teamLead" });
policy(removeMember, { targets: { teamId: "team" }, require: "teamLead" });
policy(join, { targets: { teamId: "team" } });
policy(addState, { targets: { teamId: "team" }, require: "teamLead" });
policy(updateState, { targets: { stateId: "state" }, require: "teamLead" });
