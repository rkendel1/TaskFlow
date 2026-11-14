import { s } from "@feltdb/feltkit";
import { app, issues, teamMembers, workspaceSettings } from "./app.js";
import { OPEN, reachableTeams, teamStates } from "./_domain.js";

const Settings = s.object({ estimates: s.enum(["none", "points", "tshirt"]), defaultTeamId: s.optional(s.string()) });

/** Everything the navigation needs: the workspace, me, the teams I can reach and my open work. */
export const overview = app.query({
  access: "workspace.read",
  handler: async (ctx) => {
    const tenant = app.requireTenant(ctx);
    const me = ctx.auth.requirePrincipal();
    const teamsHere = await reachableTeams(ctx);
    const myMemberships = await ctx.db.find(teamMembers, { userId: me.id });
    const mine = await ctx.db.find(issues, { assigneeId: me.id });
    const openStates = new Set<string>();
    for (const team of teamsHere) for (const st of await teamStates(ctx, team.id)) if (OPEN.has(st.category)) openStates.add(st.id);
    return {
      workspace: { id: tenant.id, name: tenant.name, role: tenant.role },
      me: { id: me.id, name: me.displayName ?? me.id, type: me.type },
      teams: teamsHere.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        private: t.private,
        myRole: myMemberships.find((m) => m.teamId === t.id)?.role ?? null,
      })),
      myOpenIssues: mine.filter((i) => openStates.has(i.stateId)).length,
    };
  },
});

/** The workspace's people and agents (platform membership; nothing copied). */
export const members = app.query({
  access: "workspace.read",
  handler: async (ctx) =>
    (await ctx.tenancy.members())
      .map((m) => ({ id: m.principalId, name: m.displayName ?? m.email ?? m.principalId, email: m.email ?? null, role: m.role, type: m.type }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
});

export const settings = app.query({
  access: "workspace.read",
  returns: Settings,
  handler: async (ctx) => {
    const [row] = await ctx.db.find(workspaceSettings, {});
    return { estimates: row?.estimates ?? "points", ...(row?.defaultTeamId ? { defaultTeamId: row.defaultTeamId } : {}) };
  },
});

export const updateSettings = app.mutation({
  access: "workspace.manage",
  args: { estimates: s.optional(s.enum(["none", "points", "tshirt"])), defaultTeamId: s.optional(s.string()) },
  handler: async (ctx, args) => {
    const [row] = await ctx.db.find(workspaceSettings, {});
    const me = ctx.auth.requirePrincipal().id;
    const next = { estimates: args.estimates ?? row?.estimates ?? "points", defaultTeamId: args.defaultTeamId ?? row?.defaultTeamId, updatedBy: me, updatedAt: Date.now() };
    if (row) await ctx.db.patch(workspaceSettings, row.id, next);
    else await ctx.db.insert(workspaceSettings, next as never);
  },
});
