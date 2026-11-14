import { s } from "@feltdb/feltkit";
import { app } from "./app.js";

/**
 * My notifications in the current workspace. AppPort Services notifications belong to the
 * recipient, not to a workspace (docs/GAP-REGISTER.md TF-GAP-05), so each carries its workspace in
 * `data` and this filters by the session's.
 */
export const list = app.query({
  access: "notifications.read",
  args: { unread: s.optional(s.boolean()) },
  handler: async (ctx, { unread }) => {
    const workspaceId = ctx.auth.tenant?.id;
    if (!workspaceId) return [];
    return (await ctx.services.notifications.list(unread ? { unread: true } : {}))
      .filter((n) => (n.data as Record<string, unknown> | undefined)?.workspaceId === workspaceId)
      .map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body ?? null, data: (n.data ?? {}) as Record<string, string>, createdAt: n.createdAt, read: Boolean(n.readAt) }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },
});

export const markRead = app.mutation({
  access: "notifications.update",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await ctx.services.notifications.markRead(id);
  },
});

export const markAllRead = app.mutation({
  access: "notifications.update",
  handler: async (ctx) => {
    const workspaceId = ctx.auth.tenant?.id;
    for (const n of await ctx.services.notifications.list({ unread: true })) {
      if ((n.data as Record<string, unknown> | undefined)?.workspaceId === workspaceId) await ctx.services.notifications.markRead(n.id);
    }
  },
});
