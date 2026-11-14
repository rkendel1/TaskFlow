import { s } from "@feltdb/feltkit";
import { app, comments, issues, teams } from "./app.js";
import { issueKey, memberIds, must, notify, parseMentions, recordIssue } from "./_domain.js";

/**
 * Comment on an issue. Mentions (`@[Name](id)`) of workspace members notify them; the issue's
 * creator, assignee and earlier commenters hear about it too. All of it commits together.
 */
export const add = app.mutation({
  access: "comments.write",
  args: { issueId: s.string(), body: s.string({ minLength: 1, maxLength: 10000 }) },
  returns: s.object({ id: s.string(), mentions: s.array(s.string()) }),
  capability: { name: "comments.add", description: "Comment on an issue. Mention a member with @[Name](memberId) to notify them." },
  handler: async (ctx, { issueId, body }) => {
    const me = ctx.auth.requirePrincipal().id;
    const issue = must(await ctx.db.get(issues, issueId), "issue");
    const team = must(await ctx.db.get(teams, issue.teamId), "team");
    const members = await memberIds(ctx);
    const mentions = parseMentions(body).filter((id) => members.has(id));
    const earlier = await ctx.db.find(comments, { issueId });
    const id = await ctx.db.insert(comments, { issueId, authorId: me, body: body.trim(), mentions, createdAt: Date.now() });
    await recordIssue(ctx, issueId, "comment.added", { commentId: id });
    const key = issueKey(team, issue);
    const preview = body.trim().replace(/@\[([^\]]+)\]\([^)]*\)/g, "@$1").slice(0, 140);
    notify(ctx, mentions, { type: "issue.mentioned", title: `You were mentioned on ${key}: ${issue.title}`, body: preview, issueId, issueKey: key });
    const followers = [issue.creatorId, issue.assigneeId, ...earlier.map((c) => c.authorId)].filter((p) => p && !mentions.includes(p) && members.has(p));
    notify(ctx, followers, { type: "issue.commented", title: `New comment on ${key}: ${issue.title}`, body: preview, issueId, issueKey: key });
    return { id, mentions };
  },
});

/** Only the author edits (_policy.ts). The previous text is not kept; the trail records the edit. */
export const edit = app.mutation({
  access: "comments.write",
  args: { commentId: s.string(), body: s.string({ minLength: 1, maxLength: 10000 }) },
  handler: async (ctx, { commentId, body }) => {
    const comment = must(await ctx.db.get(comments, commentId), "comment");
    if (comment.deletedAt) return;
    const members = await memberIds(ctx);
    await ctx.db.patch(comments, commentId, { body: body.trim(), mentions: parseMentions(body).filter((id) => members.has(id)), editedAt: Date.now() });
    await recordIssue(ctx, comment.issueId, "comment.edited", { commentId });
  },
});

/** The author or a moderator removes a comment. The record stays as a tombstone so the thread and history keep their shape. */
export const remove = app.mutation({
  access: "comments.write",
  args: { commentId: s.string() },
  handler: async (ctx, { commentId }) => {
    const comment = must(await ctx.db.get(comments, commentId), "comment");
    if (comment.deletedAt) return;
    await ctx.db.patch(comments, commentId, { deletedAt: Date.now() });
    await recordIssue(ctx, comment.issueId, "comment.deleted", { commentId, by: ctx.auth.requirePrincipal().id });
  },
});
