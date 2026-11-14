import { s } from "@feltdb/feltkit";
import { app, plain, teams, things } from "./app.js";

export const addTeam = app.mutation({ access: "things.write", args: { key: s.string() }, handler: (ctx, { key }) => ctx.db.insert(teams, { key }) });
export const addPlain = app.mutation({ access: "things.write", args: { key: s.string() }, handler: (ctx, { key }) => ctx.db.insert(plain, { key }) });
export const removePlain = app.mutation({ access: "things.write", args: { id: s.string() }, handler: (ctx, { id }) => ctx.db.delete(plain, id) });
/** Trusts s.ref to keep references inside the workspace. */
export const addThing = app.mutation({ access: "things.write", args: { plainId: s.string(), title: s.string() }, handler: (ctx, a) => ctx.db.insert(things, a) });
export const notifyMe = app.mutation({
  access: "things.write",
  args: { title: s.string() },
  handler: (ctx, { title }) => { ctx.afterCommit.notifications.send({ recipient: ctx.auth.requirePrincipal().id, type: "probe", title }); },
});
/** Lists notifications without filtering: what the service itself scopes. */
export const myNotifications = app.query({ access: "notifications.read", handler: async (ctx) => (await ctx.services.notifications.list()).map((n) => n.title) });
export const upload = app.mutation({ access: "files.write", args: { name: s.string() }, handler: async (ctx, { name }) => (await ctx.services.files.upload({ name, contentType: "text/plain", content: "secret" })).id });
export const listFiles = app.query({ access: "files.read", handler: async (ctx) => (await ctx.services.files.list()).map((f) => f.name) });
