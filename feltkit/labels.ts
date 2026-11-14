import { fail, s } from "@feltdb/feltkit";
import { app, labels } from "./app.js";
import { reachableTeams } from "./_domain.js";

/** Workspace labels, and labels of the teams I can reach. */
export const list = app.query({
  access: "workspace.read",
  handler: async (ctx) => {
    const reachable = new Set((await reachableTeams(ctx)).map((t) => t.id));
    return (await ctx.db.find(labels, {})).filter((l) => !l.teamId || reachable.has(l.teamId)).sort((a, b) => (a.name < b.name ? -1 : 1));
  },
});

export const create = app.mutation({
  access: "labels.write",
  args: { name: s.string({ minLength: 1, maxLength: 40 }), color: s.optional(s.string({ maxLength: 20 })), teamId: s.optional(s.string()) },
  returns: s.string(),
  handler: async (ctx, { name, color, teamId }) => {
    const clash = (await ctx.db.find(labels, {})).find((l) => (l.teamId ?? null) === (teamId ?? null) && l.name.toLowerCase() === name.trim().toLowerCase());
    if (clash) fail("CONFLICT", `There is already a label called ${clash.name}.`);
    return ctx.db.insert(labels, { name: name.trim(), color: color ?? "#64748b", ...(teamId ? { teamId } : {}) });
  },
});
