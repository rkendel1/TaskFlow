/**
 * The TaskFlow assistant: an application agent that files follow-up issues for people who allowed it.
 *
 * Three independent checks, all required:
 *   1. the person's delegation: AuthBoundry decides `issues.create` on behalf of the person who asked,
 *      from the grants that person made (ctx.authority.grants), revocable and expiring;
 *   2. the assistant's own authority: it works in a workspace only as a member (role `agent`), with
 *      that role's permissions and nothing else;
 *   3. TaskFlow's policy: it must reach the issue's team (_policy.ts, bound to this agent's run).
 * The person's authority is never borrowed: the assistant acts as itself, for them, and the issue's
 * history records whom it acted for, which delegation allowed it, and how the executor was proven.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, comments, issues, teams } from "./app.js";
import { ASSISTANT_ID } from "./_assistant.js";
import { issueKey, memberIds, must, recordIssue } from "./_domain.js";
import { createIssue } from "./_issues.js";
import { policy } from "./_policy.js";

const CAPABILITIES = ["issues.create"] as const;

export const assistant = app.agent("assistant", {
  principal: { id: ASSISTANT_ID, displayName: "TaskFlow assistant" },
  roles: [],
  access: "issues.create",
  description: "Files follow-up issues for people who allowed it.",
  handler: async (ctx, input: { issueId: string; commentId: string; title: string }) => {
    const person = ctx.trigger.by.principalId;
    const parent = must(await ctx.db.get(issues, input.issueId), "issue");
    const team = must(await ctx.db.get(teams, parent.teamId), "team");
    const members = await memberIds(ctx);
    const name = (await ctx.tenancy.members()).find((m) => m.principalId === person)?.displayName ?? person;
    const reply = async (body: string) => {
      const id = await ctx.db.insert(comments, { issueId: parent.id, authorId: ASSISTANT_ID, body, mentions: members.has(person) ? [person] : [], createdAt: Date.now() });
      await recordIssue(ctx, parent.id, "comment.added", { commentId: id });
    };
    const decision = await ctx.authority.decide({ capability: "issues.create", onBehalfOf: `user:${person}`, resource: { type: "issue", id: parent.id } });
    if (!decision.allowed) {
      await recordIssue(ctx, parent.id, "assistant.refused", { onBehalfOf: person, outcome: decision.outcome, reason: decision.reason, decisionId: decision.decisionId });
      await reply(`I can't file issues for @[${name}](${person}): ${decision.outcome === "deny" ? "they haven't allowed me to" : `the authority is ${decision.outcome}`}. They can allow it in Settings → Assistant.`);
      return;
    }
    const { key } = await createIssue(
      ctx,
      { teamId: parent.teamId, title: input.title, parentId: parent.id, description: `Follow-up from ${issueKey(team, parent)}, requested by @[${name}](${person}).` },
      { history: { onBehalfOf: person, delegationId: decision.delegationId, decisionId: decision.decisionId, executorProof: decision.executorProof, requestedIn: input.commentId } },
    );
    await reply(`Filed ${key} for @[${name}](${person}).`);
  },
});

const Grant = s.object({ id: s.string(), capabilities: s.array(s.string()), expiresAt: s.nullable(s.number()), status: s.string() });

/** What I have allowed the assistant to do for me. Always the caller's own grants. */
export const grants = app.mutation({
  access: "assistant.delegate",
  returns: s.array(Grant),
  handler: async (ctx) => ctx.authority.grants.list(),
});

/** Allow the assistant to file issues for me, for a number of days (default 30). */
export const grant = app.mutation({
  access: "assistant.delegate",
  args: { days: s.optional(s.integer({ minimum: 1, maximum: 365 })) },
  returns: Grant,
  handler: async (ctx, { days }) => {
    if (ctx.auth.requirePrincipal().type !== "user") fail("FORBIDDEN", "Only a person can delegate, and only their own authority.");
    return ctx.authority.grants.grant({ capabilities: [...CAPABILITIES], expiresAt: Date.now() + (days ?? 30) * 86_400_000 });
  },
});

export const revoke = app.mutation({
  access: "assistant.delegate",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await ctx.authority.grants.revoke(id);
  },
});

// Resource policy (_policy.ts), bound to each definition. The agent's run must reach the issue's team.
policy(assistant.function, { targets: { issueId: "issue" } });
policy(grants, {});
policy(grant, {});
policy(revoke, {});
