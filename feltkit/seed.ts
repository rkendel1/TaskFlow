/**
 * Demo data for a new workspace: teams, workflows, labels, projects with milestones, cycles,
 * several hundred issues with relations and comments. It writes through the same collections and
 * rules as everything else (numbers from the team sequence, history in the audit trail), in one
 * transaction, and only into an empty workspace. Deterministic: the same seed gives the same data.
 */
import { fail, s } from "@feltdb/feltkit";
import { activity, app, comments, cycles, issueRelations, issues, labels, milestones, projects, teamMembers, teams, workflowStates } from "./app.js";
import { DEFAULT_STATES, type Category } from "./_domain.js";
import { policy } from "./_policy.js";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ["Fix", "Add", "Improve", "Refactor", "Investigate", "Remove", "Document", "Migrate", "Speed up", "Redesign", "Validate", "Support"];
const THINGS = ["login redirect", "billing page", "CSV export", "search index", "webhook retries", "onboarding flow", "dark mode", "rate limiter", "audit log", "API pagination", "invite emails", "mobile layout", "session timeout", "error boundary", "file uploads", "notification settings", "SSO callback", "report builder", "keyboard shortcuts", "deploy pipeline", "cache invalidation", "timezone handling", "permissions matrix", "project templates"];
const DETAILS = ["on Safari", "for large workspaces", "behind the feature flag", "in the admin console", "for guests", "after sign-up", "under load", "for archived teams", "in the public API", "on slow networks"];
const COMMENTS = ["I can reproduce this on staging.", "Draft PR is up, needs review.", "Blocked until the migration lands.", "Customer reported this again today.", "Moved to next cycle; scope was too large.", "Added a test that covers the edge case.", "Looks good to me.", "Can we split this into two issues?"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);

export const demo = app.mutation({
  access: "workspace.manage",
  args: { issuesPerTeam: s.optional(s.integer({ minimum: 1, maximum: 400 })), seed: s.optional(s.integer()), today: s.optional(s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) },
  returns: s.object({ teams: s.integer(), issues: s.integer(), comments: s.integer() }),
  handler: async (ctx, { issuesPerTeam, seed, today }) => {
    if ((await ctx.db.find(teams, {}, { limit: 1 })).length) fail("FAILED_PRECONDITION", "Demo data goes only into an empty workspace.");
    const random = rng(seed ?? 42);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    const me = ctx.auth.requirePrincipal().id;
    const people = (await ctx.tenancy.members()).filter((m) => m.type === "user" && m.role !== "guest").map((m) => m.principalId);
    const now = Date.now();
    const base = today ? new Date(`${today}T00:00:00Z`) : new Date(iso(new Date(now)) + "T00:00:00Z");
    const perTeam = issuesPerTeam ?? 120;

    const workspaceLabels = [];
    for (const [name, color] of [["Bug", "#ef4444"], ["Feature", "#8b5cf6"], ["Improvement", "#3b82f6"], ["Customer", "#f59e0b"], ["Tech debt", "#64748b"]] as const) {
      workspaceLabels.push(await ctx.db.insert(labels, { name, color }));
    }

    let issueCount = 0, commentCount = 0;
    const teamSpecs = [
      { key: "ENG", name: "Engineering", private: false },
      { key: "DES", name: "Design", private: false },
      { key: "OPS", name: "Operations", private: true },
    ];
    for (const spec of teamSpecs) {
      const teamId = await ctx.db.insert(teams, { ...spec, createdBy: me, createdAt: now });
      await activity.record(ctx, { subject: "team", id: teamId, type: "team.created", data: { key: spec.key, name: spec.name } });
      const lead = spec.private ? me : (people[teamSpecs.indexOf(spec) % Math.max(people.length, 1)] ?? me);
      const roster = spec.private ? [me] : people;
      for (const userId of new Set([lead, ...roster])) {
        await ctx.db.insert(teamMembers, { teamId, userId, role: userId === lead ? "lead" : "member", addedBy: me, addedAt: now });
      }
      const states: Array<{ id: string; category: Category }> = [];
      for (const [position, st] of DEFAULT_STATES.entries()) states.push({ id: await ctx.db.insert(workflowStates, { teamId, ...st, position }), category: st.category });
      const teamLabel = await ctx.db.insert(labels, { name: `${spec.key.toLowerCase()}-internal`, color: "#14b8a6", teamId });

      const projectIds: Array<{ id: string; milestones: string[] }> = [];
      for (const [n, name] of [`${spec.name} platform v2`, `${spec.name} reliability`].entries()) {
        const id = await ctx.db.insert(projects, {
          teamId, name, status: n === 0 ? "started" : "planned", leadId: lead,
          startDate: iso(addDays(base, -30 + n * 20)), targetDate: iso(addDays(base, n === 0 ? -3 : 60)),
          description: `${name}: the work the ${spec.name} team committed to this quarter.`,
          createdBy: me, createdAt: now, updatedAt: now,
        });
        await activity.record(ctx, { subject: "project", id, type: "project.created", data: { name } });
        const ms = [];
        for (const [position, mName] of ["Alpha", "Beta", "GA"].entries()) ms.push(await ctx.db.insert(milestones, { projectId: id, name: mName, targetDate: iso(addDays(base, -10 + position * 20 + n * 15)), position }));
        projectIds.push({ id, milestones: ms });
      }

      const cycleIds: string[] = [];
      for (const offset of [-2, -1, 0, 1]) {
        const number = await ctx.db.sequence(`cycle:${teamId}`);
        const startDate = iso(addDays(base, offset * 14 - 3));
        const id = await ctx.db.insert(cycles, { teamId, number, startDate, endDate: iso(addDays(base, offset * 14 + 10)), createdBy: me });
        await activity.record(ctx, { subject: "cycle", id, type: "cycle.created", data: { number } });
        cycleIds.push(id);
      }

      const created: string[] = [];
      for (let k = 0; k < perTeam; k++) {
        const roll = random();
        const category: Category = roll < 0.18 ? "backlog" : roll < 0.45 ? "unstarted" : roll < 0.68 ? "started" : roll < 0.93 ? "completed" : "canceled";
        const candidates = states.filter((st) => st.category === category);
        const state = pick(candidates);
        const project = random() < 0.55 ? pick(projectIds) : undefined;
        const cycleIndex = category === "backlog" ? -1 : Math.floor(random() * cycleIds.length);
        const createdAt = now - Math.floor(random() * 60) * 86_400_000 - k * 1000;
        const due = random() < 0.35 ? iso(addDays(base, Math.floor(random() * 40) - 15)) : undefined;
        const number = await ctx.db.sequence(`issue:${teamId}`);
        const title = `${pick(VERBS)} ${pick(THINGS)} ${pick(DETAILS)}`;
        const id = await ctx.db.insert(issues, {
          teamId, number, title,
          ...(random() < 0.5 ? { description: `Steps to reproduce, context and acceptance criteria for “${title}”.` } : {}),
          stateId: state.id,
          priority: Math.floor(random() * 5),
          type: pick(["issue", "bug", "feature", "task"] as const),
          ...(people.length && random() < 0.8 ? { assigneeId: pick(spec.private ? [me] : people) } : {}),
          creatorId: pick(spec.private ? [me] : people.length ? people : [me]),
          labelIds: [...new Set([...(random() < 0.6 ? [pick(workspaceLabels)] : []), ...(random() < 0.15 ? [teamLabel] : [])])],
          ...(random() < 0.6 ? { estimate: pick([1, 2, 3, 5, 8]) } : {}),
          ...(due ? { dueDate: due } : {}),
          ...(project ? { projectId: project.id, ...(random() < 0.6 ? { milestoneId: pick(project.milestones) } : {}) } : {}),
          ...(cycleIndex >= 0 ? { cycleId: cycleIds[cycleIndex]! } : {}),
          ...(created.length > 5 && random() < 0.12 ? { parentId: pick(created) } : {}),
          sortOrder: createdAt,
          createdAt,
          updatedAt: createdAt,
          ...(category === "completed" ? { completedAt: createdAt + 86_400_000 } : {}),
          ...(category === "canceled" ? { canceledAt: createdAt + 86_400_000 } : {}),
        });
        await activity.record(ctx, { subject: "issue", id, type: "issue.created", data: { key: `${spec.key}-${number}`, title, seeded: true } });
        if (created.length > 3 && random() < 0.08) {
          const blocker = pick(created);
          await ctx.db.insert(issueRelations, { issueId: blocker, blockedId: id, createdBy: me, createdAt });
        }
        const n = random() < 0.4 ? Math.floor(random() * 3) + 1 : 0;
        for (let c = 0; c < n; c++) {
          await ctx.db.insert(comments, { issueId: id, authorId: pick(people.length ? people : [me]), body: pick(COMMENTS), mentions: [], createdAt: createdAt + (c + 1) * 3_600_000 });
          commentCount++;
        }
        created.push(id);
        issueCount++;
      }
    }
    return { teams: teamSpecs.length, issues: issueCount, comments: commentCount };
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(demo, {});
