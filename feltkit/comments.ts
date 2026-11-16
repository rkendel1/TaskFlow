import { s } from "@feltdb/feltkit";
import { app, comments, issues, teams } from "./app.js";
import { ASSISTANT_ID, assistantRequest } from "./_assistant.js";
import { issueKey, memberIds, must, notify, parseMentions, recordIssue } from "./_domain.js";
import { canReachTeam, policy } from "./_policy.js";

/**
 * Comment on an issue. Mentions (`@[Name](id)`) of workspace members notify them; the issue's
 * creator, assignee and earlier commenters hear about it too. All of it commits together.
 */
export const add = app.mutation({
  access: "comments.write",
  args: { issueId: s.string(), body: s.string({ minLength: 1, maxLength: 10000 }) },
  returns: s.object({ id: s.string(), mentions: s.array(s.string()), assistant: s.optional(s.enum(["asked", "not-in-workspace", "not-on-team"])) }),
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
    // "@assistant follow up: <title>" asks the assistant to file a sub-issue for the commenter. It runs
    // after this commits, as itself, and acts only on the commenter's delegation (assistant.ts).
    const ask = assistantRequest(body);
    if (ask && ctx.auth.requirePrincipal().type === "user") {
      if (!members.has(ASSISTANT_ID)) return { id, mentions, assistant: "not-in-workspace" as const };
      // The assistant works with its own reach (role agent): a private team it is not on is out of
      // bounds whatever the person allowed. Say so now rather than queue a run the policy refuses.
      const assistant = { id: ASSISTANT_ID, type: "agent" as const, roles: [], tenant: { ...ctx.auth.tenant!, role: "agent" } };
      if (!(await canReachTeam(ctx.db, assistant as never, team))) return { id, mentions, assistant: "not-on-team" as const };
      ctx.afterCommit.agent("assistant", { issueId, commentId: id, title: ask });
      return { id, mentions, assistant: "asked" as const };
    }
    return { id, mentions };
  },
});

/**
 * Only the author edits. Declared on the function (FeltKit `owner`, 0.3.30), so the rule moves with
 * it and FeltKit enforces it on every interface; the policy hook still checks the team's reach. The
 * previous text is not kept; the trail records the edit.
 */
export const edit = app.mutation({
  access: "comments.write",
  args: { commentId: s.string(), body: s.string({ minLength: 1, maxLength: 10000 }) },
  owner: { collection: comments, id: "commentId", field: "authorId" },
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

// Resource policy (_policy.ts), bound to each definition.
policy(add, { targets: { issueId: "issue" } });
policy(edit, { targets: { commentId: "comment" } });
policy(remove, { targets: { commentId: "comment" }, require: "commentAuthorOrModerator" });
