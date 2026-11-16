/**
 * Issues: the lifecycle, the list/board query, search, relations, and the agent capabilities.
 * Who may touch which issue is decided by _policy.ts before any handler here runs.
 */
import { fail, s, type MutationCtx, type QueryCtx, type Schema } from "@feltdb/feltkit";
import { activity, app, comments, issueRelations, issues, teams, workflowStates, ISSUE_TYPES, STATE_CATEGORIES } from "./app.js";
import { checkIssueRefs, DONE, issueKey, must, notify, OPEN, reachableTeams, recordIssue, requireMember, teamStates, today, type Category, type Issue, type State, type Team } from "./_domain.js";
import { ISSUE_REFS, policy } from "./_policy.js";

const date = () => s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const IssueView = s.doc(issues).extend({ key: s.string(), category: s.enum(STATE_CATEGORIES) });

type Ctx = QueryCtx | MutationCtx;

/** Teams (and their states) visible to the caller, loaded once per call. */
async function catalog(ctx: Ctx) {
  const teamList = await reachableTeams(ctx);
  const teamsById = new Map(teamList.map((t) => [t.id, t] as const));
  const states = new Map<string, State>();
  for (const team of teamList) for (const st of await teamStates(ctx, team.id)) states.set(st.id, st);
  return { teamsById, states };
}

function view(issue: Issue, team: Team, state: State | undefined) {
  return { ...issue, key: issueKey(team, issue), category: (state?.category ?? "backlog") as Category };
}

async function viewOne(ctx: Ctx, issue: Issue) {
  const team = must(await ctx.db.get(teams, issue.teamId), "team") as Team;
  const state = (await ctx.db.get(workflowStates, issue.stateId)) as State | null;
  return view(issue, team, state ?? undefined);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const SORTS = ["manual", "priority", "updated", "created", "due", "key"] as const;

/**
 * The one query behind every list and board: the same records, the same filters, so the two views
 * cannot disagree. One indexed equality is pushed into FeltDB (cycle, project, assignee or team);
 * the rest is filtered and sorted here, and the result is paged by offset with the full `total`, so
 * no matching issue is silently left out.
 */
export const list = app.query({
  access: "issues.read",
  args: {
    teamId: s.optional(s.string()),
    projectId: s.optional(s.string()),
    cycleId: s.optional(s.string()),
    /** A person's id, "me", or "none" for unassigned. */
    assigneeId: s.optional(s.string()),
    creatorId: s.optional(s.string()),
    stateIds: s.optional(s.array(s.string())),
    categories: s.optional(s.array(s.enum(STATE_CATEGORIES))),
    priorities: s.optional(s.array(s.integer({ minimum: 0, maximum: 4 }))),
    /** Issues carrying any of these labels. */
    labelIds: s.optional(s.array(s.string())),
    types: s.optional(s.array(s.enum(ISSUE_TYPES))),
    text: s.optional(s.string({ maxLength: 200 })),
    topLevelOnly: s.optional(s.boolean()),
    sort: s.optional(s.enum(SORTS)),
    direction: s.optional(s.enum(["asc", "desc"])),
    offset: s.optional(s.integer({ minimum: 0 })),
    limit: s.optional(s.integer({ minimum: 1, maximum: 1000 })),
  },
  handler: async (ctx, a) => {
    const me = ctx.auth.requirePrincipal().id;
    const { teamsById, states } = await catalog(ctx);
    const assignee = a.assigneeId === "me" ? me : a.assigneeId;

    let candidates: Issue[];
    if (a.cycleId) candidates = (await ctx.db.find(issues, { cycleId: a.cycleId })) as Issue[];
    else if (a.projectId) candidates = (await ctx.db.find(issues, { projectId: a.projectId })) as Issue[];
    else if (assignee && assignee !== "none") candidates = (await ctx.db.find(issues, { assigneeId: assignee })) as Issue[];
    else if (a.teamId) candidates = (await ctx.db.find(issues, { teamId: a.teamId })) as Issue[];
    else candidates = (await ctx.db.find(issues, {})) as Issue[];

    const stateIds = a.stateIds ? new Set(a.stateIds) : null;
    const categories = a.categories ? new Set<string>(a.categories) : null;
    const priorities = a.priorities ? new Set<number>(a.priorities) : null;
    const types = a.types ? new Set<string>(a.types) : null;
    const labelIds = a.labelIds?.length ? new Set(a.labelIds) : null;
    const text = a.text?.trim().toLowerCase();

    const rows: Array<ReturnType<typeof view>> = [];
    for (const issue of candidates) {
      const team = teamsById.get(issue.teamId);
      if (!team) continue; // a team the caller cannot reach
      if (a.teamId && issue.teamId !== a.teamId) continue;
      if (a.projectId && issue.projectId !== a.projectId) continue;
      if (a.cycleId && issue.cycleId !== a.cycleId) continue;
      if (assignee === "none" ? issue.assigneeId : assignee && issue.assigneeId !== assignee) continue;
      if (a.creatorId && issue.creatorId !== a.creatorId) continue;
      const state = states.get(issue.stateId);
      if (stateIds && !stateIds.has(issue.stateId)) continue;
      if (categories && !categories.has(state?.category ?? "")) continue;
      if (priorities && !priorities.has(issue.priority)) continue;
      if (types && !types.has(issue.type)) continue;
      if (labelIds && !issue.labelIds.some((l) => labelIds.has(l))) continue;
      if (a.topLevelOnly && issue.parentId) continue;
      const v = view(issue, team, state);
      if (text && !v.title.toLowerCase().includes(text) && !v.key.toLowerCase().includes(text)) continue;
      rows.push(v);
    }

    const sort = a.sort ?? "manual";
    const dir = a.direction === "asc" ? 1 : a.direction === "desc" ? -1 : sort === "updated" || sort === "created" ? -1 : 1;
    const value = (r: (typeof rows)[number]): number | string => {
      switch (sort) {
        case "priority": return r.priority === 0 ? 5 : r.priority; // "no priority" last
        case "updated": return r.updatedAt;
        case "created": return r.createdAt;
        case "due": return r.dueDate ?? "9999-99-99";
        case "key": return `${r.key.split("-")[0]}-${String(r.number).padStart(9, "0")}`;
        case "manual": return r.sortOrder;
      }
    };
    rows.sort((x, y) => {
      const vx = value(x), vy = value(y);
      if (vx < vy) return -dir;
      if (vx > vy) return dir;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; // total order: stable pages
    });
    const offset = a.offset ?? 0;
    const limit = a.limit ?? 200;
    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
  },
});

/** Search by identifier (ENG-42) or by words in the title. */
export const search = app.query({
  access: "issues.read",
  args: { text: s.string({ minLength: 1, maxLength: 200 }), limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.array(IssueView),
  capability: { name: "issues.search", description: "Find issues by identifier (e.g. ENG-42) or by words in the title, newest first." },
  handler: async (ctx, { text, limit }) => {
    const { teamsById, states } = await catalog(ctx);
    const max = limit ?? 20;
    const key = /^\s*([A-Za-z][A-Za-z0-9]{1,4})-(\d+)\s*$/.exec(text);
    if (key) {
      const team = [...teamsById.values()].find((t) => t.key === key[1]!.toUpperCase());
      if (!team) return [];
      const found = (await ctx.db.find(issues, { number: Number(key[2]) })) as Issue[];
      return found.filter((i) => i.teamId === team.id).map((i) => view(i, team, states.get(i.stateId)));
    }
    // FeltDB has no text index (UPSTREAM-GAPS F23): search scans. It has no "team in [...]" clause,
    // so issues of unreachable teams are dropped after the scan; ask for more to fill the page.
    const found = (await ctx.db.search(issues, { text, limit: 100 })) as Issue[];
    const out = [];
    for (const i of found) {
      const team = teamsById.get(i.teamId);
      if (team) out.push(view(i, team, states.get(i.stateId)));
      if (out.length >= max) break;
    }
    return out;
  },
});

const Related = s.object({ id: s.string(), key: s.string(), title: s.string(), category: s.enum(STATE_CATEGORIES) });

/** An issue with everything its panel shows. */
export const get = app.query({
  access: "issues.read",
  args: { issueId: s.string() },
  returns: IssueView.extend({
    teamKey: s.string(),
    stateName: s.string(),
    parent: s.nullable(Related),
    children: s.array(Related),
    blocks: s.array(Related),
    blockedBy: s.array(Related),
    comments: s.array(s.object({ id: s.string(), authorId: s.string(), body: s.string(), mentions: s.array(s.string()), createdAt: s.number(), editedAt: s.optional(s.number()), deleted: s.boolean() })),
    history: s.array(s.object({ type: s.string(), actor: s.string(), actorType: s.string(), at: s.number(), seq: s.number(), data: s.optional(s.record(s.unknown())) })),
  }),
  capability: { name: "issues.get", description: "An issue with its status, assignee, relations, sub-issues, comments and change history." },
  handler: async (ctx, { issueId }) => {
    const issue = must(await ctx.db.get(issues, issueId), "issue") as Issue;
    const { teamsById, states } = await catalog(ctx);
    const related = async (id: string) => {
      const r = (await ctx.db.get(issues, id)) as Issue | null;
      const team = r && teamsById.get(r.teamId);
      return r && team ? { id: r.id, key: issueKey(team, r), title: r.title, category: (states.get(r.stateId)?.category ?? "backlog") as Category } : null;
    };
    const present = <T,>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);
    const team = must(teamsById.get(issue.teamId), "team");
    const state = states.get(issue.stateId);
    const children = (await ctx.db.find(issues, { parentId: issueId })) as Issue[];
    const blocks = await ctx.db.find(issueRelations, { issueId });
    const blockedBy = await ctx.db.find(issueRelations, { blockedId: issueId });
    const thread = await ctx.db.find(comments, { issueId }, { orderBy: [{ field: "createdAt", direction: "asc" }] });
    const history = await activity.history(ctx, "issue", issueId, { limit: 200 });
    return {
      ...view(issue, team, state),
      teamKey: team.key,
      stateName: state?.name ?? "",
      parent: issue.parentId ? await related(issue.parentId) : null,
      children: present(await Promise.all(children.map((c) => related(c.id)))),
      blocks: present(await Promise.all(blocks.map((r) => related(r.blockedId)))),
      blockedBy: present(await Promise.all(blockedBy.map((r) => related(r.issueId)))),
      comments: thread.map((c) => ({ id: c.id, authorId: c.authorId, body: c.deletedAt ? "" : c.body, mentions: c.deletedAt ? [] : c.mentions, createdAt: c.createdAt, ...(c.editedAt ? { editedAt: c.editedAt } : {}), deleted: Boolean(c.deletedAt) })),
      history: history.map((h) => ({ type: h.type, actor: h.actor, actorType: h.actorType, at: h.at, seq: h.seq, ...(h.data ? { data: h.data } : {}) })),
    };
  },
});

/** Work that needs attention: open issues past their due date, and open issues blocked by open issues. */
export const attention = app.query({
  access: "issues.read",
  args: { teamId: s.optional(s.string()), today: s.optional(date()) },
  returns: s.object({ overdue: s.array(IssueView), blocked: s.array(IssueView.extend({ blockedBy: s.array(s.string()) })) }),
  capability: { name: "issues.attention", description: "Open issues that are overdue (due date before today) or blocked by another open issue." },
  handler: async (ctx, { teamId, today: day }) => {
    const { teamsById, states } = await catalog(ctx);
    const now = day ?? today();
    // Every open issue the caller can reach: a blocker may be in another team.
    const open = new Map<string, ReturnType<typeof view>>();
    for (const i of (await ctx.db.find(issues, {})) as Issue[]) {
      const team = teamsById.get(i.teamId);
      const st = states.get(i.stateId);
      if (team && st && OPEN.has(st.category)) open.set(i.id, view(i, team, st));
    }
    const inScope = [...open.values()].filter((i) => !teamId || i.teamId === teamId);
    const overdue = inScope.filter((i) => i.dueDate && i.dueDate < now).sort((x, y) => (x.dueDate! < y.dueDate! ? -1 : x.dueDate! > y.dueDate! ? 1 : 0));
    const blocked = [];
    for (const i of inScope) {
      const blockers = (await ctx.db.find(issueRelations, { blockedId: i.id })).map((r) => open.get(r.issueId)).filter((b) => b !== undefined);
      if (blockers.length) blocked.push({ ...i, blockedBy: blockers.map((b) => b.key) });
    }
    return { overdue, blocked };
  },
});

// ---------------------------------------------------------------------------------------------
// Changing: every path goes through applyChanges, so the rules exist once.
// ---------------------------------------------------------------------------------------------

type Changes = Partial<{
  title: string;
  description: string | null;
  stateId: string;
  priority: number;
  type: (typeof ISSUE_TYPES)[number];
  assigneeId: string | null;
  labelIds: string[];
  estimate: number | null;
  dueDate: string | null;
  projectId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  parentId: string | null;
  sortOrder: number;
}>;

const TRACKED: ReadonlyArray<keyof Changes> = ["title", "description", "stateId", "priority", "type", "assigneeId", "labelIds", "estimate", "dueDate", "projectId", "milestoneId", "cycleId", "parentId"];

async function applyChanges(ctx: MutationCtx, issueId: string, changes: Changes, expectedVersion?: number) {
  const issue = must(await ctx.db.get(issues, issueId), "issue") as Issue;
  // Optimistic concurrency for people editing a stale copy: the read fence already refuses a
  // write that raced this one; this refuses a change made against an older version they saw.
  if (expectedVersion !== undefined && issue.__version !== expectedVersion) {
    fail("CONFLICT", `${issueId} changed since you loaded it (version ${issue.__version}, you had ${expectedVersion}). Reload and try again.`);
  }
  const team = must(await ctx.db.get(teams, issue.teamId), "team") as Team;
  const next = { ...issue } as Record<string, unknown>;
  const changed: Array<keyof Changes> = [];
  for (const field of Object.keys(changes) as Array<keyof Changes>) {
    const to = changes[field];
    if (to === undefined) continue;
    const from = (issue as Record<string, unknown>)[field];
    const normalized = to === null ? undefined : to;
    if (JSON.stringify(from ?? null) === JSON.stringify(normalized ?? null)) continue;
    next[field] = normalized;
    changed.push(field);
  }
  if (!changed.length) return issue;
  // A milestone belongs to a project: leaving the project leaves its milestone.
  if (changed.includes("projectId") && next.milestoneId && !changed.includes("milestoneId")) {
    next.milestoneId = undefined;
    changed.push("milestoneId");
  }
  if (changes.assigneeId) await requireMember(ctx, changes.assigneeId);
  await checkIssueRefs(ctx, issue.teamId, {
    stateId: changed.includes("stateId") ? (next.stateId as string) : undefined,
    projectId: next.projectId as string | undefined,
    milestoneId: changed.includes("milestoneId") || changed.includes("projectId") ? (next.milestoneId as string | undefined) : undefined,
    cycleId: changed.includes("cycleId") ? (next.cycleId as string | undefined) : undefined,
    parentId: changed.includes("parentId") ? (next.parentId as string | undefined) : undefined,
    labelIds: changed.includes("labelIds") ? (next.labelIds as string[]) : undefined,
    selfId: issueId,
  });

  const now = Date.now();
  let fromState: State | null = null;
  let toState: State | null = null;
  if (changed.includes("stateId")) {
    fromState = (await ctx.db.get(workflowStates, issue.stateId)) as State | null;
    toState = must(await ctx.db.get(workflowStates, next.stateId as string), "state") as State;
    next.completedAt = toState.category === "completed" ? now : undefined;
    next.canceledAt = toState.category === "canceled" ? now : undefined;
  }
  const { id: _id, __version: _v, workspaceId: _w, ...stored } = next as Issue & { workspaceId?: string };
  const saved = (await ctx.db.replace(issues, issueId, { ...stored, updatedAt: now } as never)) as Issue;

  const key = issueKey(team, issue);
  for (const field of changed) {
    if (!TRACKED.includes(field)) continue;
    const from = (issue as Record<string, unknown>)[field] ?? null;
    const to = next[field] ?? null;
    if (field === "stateId") {
      await recordIssue(ctx, issueId, "issue.status_changed", { field, from, to, fromName: fromState?.name ?? null, toName: toState!.name, toCategory: toState!.category });
    } else if (field === "assigneeId") {
      await recordIssue(ctx, issueId, "issue.assigned", { field, from, to });
    } else if (field === "description") {
      await recordIssue(ctx, issueId, "issue.updated", { field }); // the text itself is in the issue; the trail notes the edit
    } else {
      await recordIssue(ctx, issueId, "issue.updated", { field, from, to });
    }
  }
  if (changed.includes("assigneeId") && saved.assigneeId) {
    notify(ctx, [saved.assigneeId], { type: "issue.assigned", title: `${key} was assigned to you: ${saved.title}`, issueId, issueKey: key });
  }
  if (toState && fromState?.category !== toState.category) {
    notify(ctx, [saved.creatorId, saved.assigneeId], { type: "issue.status", title: `${key} moved to ${toState.name}: ${saved.title}`, issueId, issueKey: key });
  }
  return saved;
}

const nullable = <V,>(schema: Schema<V>) => s.optional(s.nullable(schema));

const EDITABLE = {
  title: s.optional(s.string({ minLength: 1, maxLength: 200 })),
  description: nullable(s.string({ maxLength: 20000 })),
  stateId: s.optional(s.string()),
  priority: s.optional(s.integer({ minimum: 0, maximum: 4 })),
  type: s.optional(s.enum(ISSUE_TYPES)),
  assigneeId: nullable(s.string()),
  labelIds: s.optional(s.array(s.string())),
  estimate: nullable(s.number({ minimum: 0, maximum: 100 })),
  dueDate: nullable(date()),
  projectId: nullable(s.string()),
  milestoneId: nullable(s.string()),
  cycleId: nullable(s.string()),
  parentId: nullable(s.string()),
};

export const create = app.mutation({
  access: "issues.create",
  args: {
    teamId: s.string(),
    title: s.string({ minLength: 1, maxLength: 200 }),
    description: s.optional(s.string({ maxLength: 20000 })),
    stateId: s.optional(s.string()),
    priority: s.optional(s.integer({ minimum: 0, maximum: 4 })),
    type: s.optional(s.enum(ISSUE_TYPES)),
    assigneeId: s.optional(s.string()),
    labelIds: s.optional(s.array(s.string())),
    estimate: s.optional(s.number({ minimum: 0, maximum: 100 })),
    dueDate: s.optional(date()),
    projectId: s.optional(s.string()),
    milestoneId: s.optional(s.string()),
    cycleId: s.optional(s.string()),
    parentId: s.optional(s.string()),
  },
  returns: s.object({ id: s.string(), key: s.string() }),
  capability: { name: "issues.create", description: "File an issue in a team. Status defaults to the team's first unstarted status." },
  // Issue numbers come from one sequence per team: concurrent creates in a team re-run instead of failing.
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, a) => {
    const me = ctx.auth.requirePrincipal().id;
    const team = must(await ctx.db.get(teams, a.teamId), "team") as Team;
    const states = await teamStates(ctx, team.id);
    const state = a.stateId ? states.find((st) => st.id === a.stateId) : states.find((st) => st.category === "unstarted") ?? states[0];
    if (!state) fail("INVALID_ARGUMENT", a.stateId ? "That status belongs to another team." : "The team has no statuses.");
    if (a.assigneeId) await requireMember(ctx, a.assigneeId);
    await checkIssueRefs(ctx, team.id, { projectId: a.projectId, milestoneId: a.milestoneId, cycleId: a.cycleId, parentId: a.parentId, labelIds: a.labelIds });
    const number = await ctx.db.sequence(`issue:${team.id}`);
    const now = Date.now();
    const id = await ctx.db.insert(issues, {
      teamId: team.id,
      number,
      title: a.title.trim(),
      ...(a.description?.trim() ? { description: a.description.trim() } : {}),
      stateId: state.id,
      priority: a.priority ?? 0,
      type: a.type ?? "issue",
      ...(a.assigneeId ? { assigneeId: a.assigneeId } : {}),
      creatorId: me,
      labelIds: a.labelIds ?? [],
      ...(a.estimate !== undefined ? { estimate: a.estimate } : {}),
      ...(a.dueDate ? { dueDate: a.dueDate } : {}),
      ...(a.projectId ? { projectId: a.projectId } : {}),
      ...(a.milestoneId ? { milestoneId: a.milestoneId } : {}),
      ...(a.cycleId ? { cycleId: a.cycleId } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
      ...(state.category === "completed" ? { completedAt: now } : {}),
      ...(state.category === "canceled" ? { canceledAt: now } : {}),
    });
    const key = issueKey(team, { number });
    await recordIssue(ctx, id, "issue.created", { key, title: a.title.trim(), state: state.name });
    if (a.assigneeId) notify(ctx, [a.assigneeId], { type: "issue.assigned", title: `${key} was assigned to you: ${a.title.trim()}`, issueId: id, issueKey: key });
    return { id, key };
  },
});

export const update = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), expectedVersion: s.optional(s.integer()), ...EDITABLE },
  returns: IssueView,
  capability: { name: "issues.update", description: "Change an issue's fields. null clears an optional field. expectedVersion refuses the change if the issue changed since you read it." },
  handler: async (ctx, { issueId, expectedVersion, ...changes }) => viewOne(ctx, await applyChanges(ctx, issueId, changes as Changes, expectedVersion)),
});

export const assign = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), assigneeId: s.nullable(s.string()) },
  returns: IssueView,
  capability: { name: "issues.assign", description: "Assign an issue to a workspace member, or unassign it with null." },
  handler: async (ctx, { issueId, assigneeId }) => viewOne(ctx, await applyChanges(ctx, issueId, { assigneeId })),
});

/** By status id, by status name ("In Review"), or by category ("completed"). */
async function resolveState(ctx: MutationCtx, teamId: string, status: string): Promise<State> {
  const states = await teamStates(ctx, teamId);
  const wanted = status.trim().toLowerCase();
  const state = states.find((st) => st.id === status) ?? states.find((st) => st.name.toLowerCase() === wanted) ?? states.find((st) => st.category === wanted);
  if (!state) fail("INVALID_ARGUMENT", `The team has no status "${status}". It has: ${states.map((st) => st.name).join(", ")}.`);
  return state;
}

export const setStatus = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), status: s.string({ minLength: 1, maxLength: 60 }) },
  returns: IssueView,
  capability: { name: "issues.setstatus", description: "Move an issue to a status of its team, by status name (e.g. \"In Review\"), category (backlog, unstarted, started, completed, canceled) or id." },
  handler: async (ctx, { issueId, status }) => {
    const issue = must(await ctx.db.get(issues, issueId), "issue");
    const state = await resolveState(ctx, issue.teamId, status);
    return viewOne(ctx, await applyChanges(ctx, issueId, { stateId: state.id }));
  },
});

export const close = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), canceled: s.optional(s.boolean()) },
  handler: async (ctx, { issueId, canceled }) => {
    const issue = must(await ctx.db.get(issues, issueId), "issue");
    const state = await resolveState(ctx, issue.teamId, canceled ? "canceled" : "completed");
    await applyChanges(ctx, issueId, { stateId: state.id });
  },
});

export const reopen = app.mutation({
  access: "issues.update",
  args: { issueId: s.string() },
  handler: async (ctx, { issueId }) => {
    const issue = must(await ctx.db.get(issues, issueId), "issue");
    const current = must(await ctx.db.get(workflowStates, issue.stateId), "state");
    if (!DONE.has(current.category)) return;
    const state = await resolveState(ctx, issue.teamId, "unstarted");
    await applyChanges(ctx, issueId, { stateId: state.id });
  },
});

/** A board drag: a status (column) and a position within it. */
export const move = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), stateId: s.string(), sortOrder: s.optional(s.number()), expectedVersion: s.optional(s.integer()) },
  handler: async (ctx, { issueId, stateId, sortOrder, expectedVersion }) => {
    await applyChanges(ctx, issueId, { stateId, ...(sortOrder !== undefined ? { sortOrder } : {}) }, expectedVersion);
  },
});

export const addRelation = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), blockedId: s.string() },
  handler: async (ctx, { issueId, blockedId }) => {
    if (issueId === blockedId) fail("INVALID_ARGUMENT", "An issue cannot block itself.");
    if ((await ctx.db.find(issueRelations, { issueId, blockedId })).length) return;
    if ((await ctx.db.find(issueRelations, { issueId: blockedId, blockedId: issueId })).length) fail("FAILED_PRECONDITION", "Those issues already block each other the other way round.");
    await ctx.db.insert(issueRelations, { issueId, blockedId, createdBy: ctx.auth.requirePrincipal().id, createdAt: Date.now() });
    await recordIssue(ctx, issueId, "issue.relation_added", { blocks: blockedId });
    await recordIssue(ctx, blockedId, "issue.relation_added", { blockedBy: issueId });
  },
});

export const removeRelation = app.mutation({
  access: "issues.update",
  args: { issueId: s.string(), blockedId: s.string() },
  handler: async (ctx, { issueId, blockedId }) => {
    for (const r of await ctx.db.find(issueRelations, { issueId, blockedId })) await ctx.db.delete(issueRelations, r.id);
    await recordIssue(ctx, issueId, "issue.relation_removed", { blocks: blockedId });
    await recordIssue(ctx, blockedId, "issue.relation_removed", { blockedBy: issueId });
  },
});

/**
 * Delete an issue, its comments and relations, in one transaction. Its change history stays (the
 * audit trail is append-only) with an `issue.deleted` entry. Agents can only propose this: a person
 * who may delete it approves, and it runs with the proposer's own authority.
 */
export const remove = app.mutation({
  access: "issues.delete",
  approval: "required",
  args: { issueId: s.string() },
  returns: s.object({ id: s.string(), key: s.string() }),
  capability: { name: "issues.delete", description: "Delete an issue with its comments and relations. Agents must propose this; a person approves it." },
  handler: async (ctx, { issueId }) => {
    const issue = must(await ctx.db.get(issues, issueId), "issue") as Issue;
    const team = must(await ctx.db.get(teams, issue.teamId), "team") as Team;
    for (const c of await ctx.db.find(comments, { issueId })) await ctx.db.delete(comments, c.id);
    for (const r of await ctx.db.find(issueRelations, { issueId })) await ctx.db.delete(issueRelations, r.id);
    for (const r of await ctx.db.find(issueRelations, { blockedId: issueId })) await ctx.db.delete(issueRelations, r.id);
    for (const child of await ctx.db.find(issues, { parentId: issueId })) await ctx.db.patch(issues, child.id, { parentId: undefined, updatedAt: Date.now() });
    await ctx.db.delete(issues, issueId);
    const key = issueKey(team, issue);
    await recordIssue(ctx, issueId, "issue.deleted", { key, title: issue.title });
    return { id: issueId, key };
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(list, { targets: { teamId: "team", projectId: "project", cycleId: "cycle" } });
policy(search, {});
policy(get, { targets: { issueId: "issue" } });
policy(create, { targets: ISSUE_REFS });
policy(update, { targets: { issueId: "issue", ...ISSUE_REFS } });
policy(assign, { targets: { issueId: "issue" } });
policy(setStatus, { targets: { issueId: "issue" } });
policy(close, { targets: { issueId: "issue" } });
policy(reopen, { targets: { issueId: "issue" } });
policy(move, { targets: { issueId: "issue", stateId: "state" } });
policy(addRelation, { targets: { issueId: "issue", blockedId: "issue" } });
policy(removeRelation, { targets: { issueId: "issue", blockedId: "issue" } });
policy(remove, { targets: { issueId: "issue" }, require: "issueCreatorOrAdmin" });
policy(attention, { targets: { teamId: "team" } });
