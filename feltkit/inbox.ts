import { s } from "@feltdb/feltkit";
import { app } from "./app.js";

/**
 * The size of one AppPort Services notifications page. `ctx.services.notifications.list()` returns
 * only the first page, newest first, and has no cursor (FeltKit 0.3.30; FRAME-GAP-08a, fixed on an
 * unpublished FeltKit branch). Measured: 70 sent, 50 listed (docs/GAP-REGISTER.md TF-GAP-15).
 */
const SERVICE_PAGE = 50;

const workspaceOf = (n: { data?: unknown }) => (n.data as Record<string, unknown> | undefined)?.workspaceId;

/**
 * My notifications in the current workspace, newest first. Notifications belong to the recipient,
 * not to a workspace (TF-GAP-05), so each carries its workspace in `data` and this filters by the
 * session's. `truncated` says the service returned a full page: older notifications exist that
 * FeltKit 0.3.30 cannot list, and the screen says so rather than hiding them silently.
 */
export const list = app.query({
  access: "notifications.read",
  args: { unread: s.optional(s.boolean()) },
  handler: async (ctx, { unread }) => {
    const workspaceId = ctx.auth.tenant?.id;
    if (!workspaceId) return { items: [], truncated: false };
    const page = await ctx.services.notifications.list(unread ? { unread: true } : {});
    const items = page
      .filter((n) => workspaceOf(n) === workspaceId)
      .map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body ?? null, data: (n.data ?? {}) as Record<string, string>, createdAt: n.createdAt, read: Boolean(n.readAt) }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { items, truncated: page.length >= SERVICE_PAGE };
  },
});

export const markRead = app.mutation({
  access: "notifications.update",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await ctx.services.notifications.markRead(id);
  },
});

/**
 * Mark every unread notification of this workspace read. One `list()` returns at most one page, so
 * read pages of unread until none of this workspace's remain. Bounded: a page holding only other
 * workspaces' unread notifications stops it, since without a cursor nothing behind them is reachable.
 */
export const markAllRead = app.mutation({
  access: "notifications.update",
  returns: s.object({ marked: s.integer(), complete: s.boolean() }),
  handler: async (ctx) => {
    const workspaceId = ctx.auth.tenant?.id;
    let marked = 0;
    for (let round = 0; round < 200; round++) {
      const page = await ctx.services.notifications.list({ unread: true });
      const mine = page.filter((n) => workspaceOf(n) === workspaceId);
      for (const n of mine) await ctx.services.notifications.markRead(n.id);
      marked += mine.length;
      if (page.length < SERVICE_PAGE) return { marked, complete: true };
      if (!mine.length) return { marked, complete: false };
    }
    return { marked, complete: false };
  },
});
