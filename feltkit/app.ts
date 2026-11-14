/**
 * TaskFlow: workspaces, teams, projects, cycles and issues.
 *
 * Accounts, sessions, workspaces, membership, invitations and data isolation are FeltKit's
 * (`auth.tenant`, `{ tenant }` collections). Per-record rules (private teams, team leads, ownership)
 * live in one authorization hook, `./_policy.ts`. See docs/DESIGN.md.
 */
import { feltkit, s } from "@feltdb/feltkit";
import { authorize } from "./_policy.js";

/** Read access every workspace role needs. */
const READ = ["workspace.read", "issues.read", "projects.read"];
/** What a contributor (member) can do in the teams they can reach. */
const CONTRIBUTE = [...READ, "issues.create", "issues.update", "comments.write", "projects.write", "cycles.write", "labels.write", "teams.write"];
/** Inbox: a principal reads and marks only its own notifications (AppPort Services enforces it). */
const INBOX = ["notifications.read", "notifications.update"];

export const app = feltkit({
  name: "taskflow",
  description: "Issue tracking for teams: workspaces, teams, projects, cycles, issues.",
  roles: {
    // Every account, before it is in a workspace: no workspace permission.
    person: [...INBOX, "feltkit.agent.*"],
    // Workspace roles (auth.tenant.roles), highest first.
    owner: [...CONTRIBUTE, "issues.delete", "comments.moderate", "workspace.manage", "tenant.*"],
    admin: [...CONTRIBUTE, "issues.delete", "comments.moderate", "workspace.manage", "tenant.members.manage"],
    member: CONTRIBUTE,
    // Agents read, file, update and comment. They may delete only through an approved proposal
    // (issues:remove is approval: "required"). They cannot manage teams, members or settings.
    agent: [...READ, "issues.create", "issues.update", "comments.write", "issues.delete", ...INBOX, "feltkit.agent.*"],
    // Guests reach only the teams they are added to (_policy.ts); they read, file and comment.
    guest: [...READ, "issues.create", "comments.write"],
    // Environment administration (Studio → Services, models, credentials). Development: Ada.
    operator: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  auth: {
    accounts: { roles: ["person"] },
    tenant: { name: "workspace", roles: ["owner", "admin", "member", "agent", "guest"] },
  },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["person", "operator"] },
      { id: "grace", name: "Grace Hopper", roles: ["person"] },
      { id: "linus", name: "Linus Torvalds", roles: ["person"] },
    ],
  },
  // Resolved at call time: _policy.ts reads this module's collections, so either may load first.
  authorize: (request) => authorize(request),
  services: {
    notifications: { types: ["issue.assigned", "issue.mentioned", "issue.commented", "issue.status"] },
    configuration: true,
    apiKeys: { roles: ["agent"] },
    jobs: true,
    intelligence: true,
  },
});

const WS = { tenant: { field: "workspaceId" } } as const;
const date = () => s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const STATE_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export const PRIORITIES = [0, 1, 2, 3, 4] as const; // none, urgent, high, medium, low (Linear's order)
export const ISSUE_TYPES = ["issue", "bug", "feature", "task"] as const;
export const PROJECT_STATUSES = ["planned", "started", "paused", "completed", "canceled"] as const;

// `key` is unique per workspace. FeltKit's `unique` is enforced across workspaces (docs/GAP-REGISTER.md
// TF-GAP-01), so teams:create checks it in its transaction instead.
export const teams = app.collection(
  "teams",
  {
    key: s.string({ pattern: "^[A-Z][A-Z0-9]{1,4}$" }),
    name: s.string({ minLength: 1, maxLength: 60 }),
    description: s.optional(s.string({ maxLength: 500 })),
    private: s.boolean(),
    createdBy: s.string(),
    createdAt: s.number(),
  },
  { ...WS, indexes: [{ fields: ["key"] }] },
);

export const teamMembers = app.collection(
  "teamMembers",
  { teamId: s.ref(teams), userId: s.string(), role: s.enum(["lead", "member"]), addedBy: s.string(), addedAt: s.number() },
  { ...WS, indexes: [{ fields: ["userId"] }] },
);

export const workflowStates = app.collection(
  "workflowStates",
  {
    teamId: s.ref(teams),
    name: s.string({ minLength: 1, maxLength: 40 }),
    category: s.enum(STATE_CATEGORIES),
    position: s.number(),
    color: s.string({ maxLength: 20 }),
  },
  WS,
);

export const labels = app.collection(
  "labels",
  { name: s.string({ minLength: 1, maxLength: 40 }), color: s.string({ maxLength: 20 }), teamId: s.optional(s.ref(teams)) },
  WS,
);

export const projects = app.collection(
  "projects",
  {
    name: s.string({ minLength: 1, maxLength: 80 }),
    description: s.optional(s.string({ maxLength: 4000 })),
    status: s.enum(PROJECT_STATUSES),
    teamId: s.ref(teams),
    leadId: s.optional(s.string()),
    startDate: s.optional(date()),
    targetDate: s.optional(date()),
    createdBy: s.string(),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  WS,
);

export const milestones = app.collection(
  "milestones",
  { projectId: s.ref(projects), name: s.string({ minLength: 1, maxLength: 80 }), targetDate: s.optional(date()), position: s.number() },
  WS,
);

export const cycles = app.collection(
  "cycles",
  { teamId: s.ref(teams), number: s.integer(), name: s.optional(s.string({ maxLength: 60 })), startDate: date(), endDate: date(), createdBy: s.string() },
  WS,
);

export const issues = app.collection(
  "issues",
  {
    teamId: s.ref(teams),
    number: s.integer(),
    title: s.string({ minLength: 1, maxLength: 200 }),
    description: s.optional(s.string({ maxLength: 20000 })),
    stateId: s.ref(workflowStates),
    priority: s.integer({ minimum: 0, maximum: 4 }),
    type: s.enum(ISSUE_TYPES),
    assigneeId: s.optional(s.string()),
    creatorId: s.string(),
    labelIds: s.array(s.string()),
    estimate: s.optional(s.number({ minimum: 0, maximum: 100 })),
    dueDate: s.optional(date()),
    projectId: s.optional(s.ref(projects)),
    milestoneId: s.optional(s.ref(milestones)),
    cycleId: s.optional(s.ref(cycles)),
    parentId: s.optional(s.string()),
    sortOrder: s.number(),
    createdAt: s.number(),
    updatedAt: s.number(),
    completedAt: s.optional(s.number()),
    canceledAt: s.optional(s.number()),
  },
  {
    ...WS,
    search: ["title"],
    indexes: [{ fields: ["stateId"] }, { fields: ["assigneeId"] }, { fields: ["parentId"] }, { fields: ["number"] }],
  },
);

export const issueRelations = app.collection(
  "issueRelations",
  { issueId: s.ref(issues), blockedId: s.ref(issues), createdBy: s.string(), createdAt: s.number() },
  WS,
);

export const comments = app.collection(
  "comments",
  {
    issueId: s.ref(issues),
    authorId: s.string(),
    body: s.string({ maxLength: 10000 }),
    mentions: s.array(s.string()),
    createdAt: s.number(),
    editedAt: s.optional(s.number()),
    deletedAt: s.optional(s.number()),
  },
  WS,
);

export const workspaceSettings = app.collection(
  "workspaceSettings",
  { estimates: s.enum(["none", "points", "tshirt"]), defaultTeamId: s.optional(s.string()), updatedBy: s.string(), updatedAt: s.number() },
  WS,
);

/** Field-change history: written in the same transaction as the change it describes. */
export const activity = app.auditTrail("activity", { subjects: ["issue", "project", "cycle", "team"] as const, ...WS });
