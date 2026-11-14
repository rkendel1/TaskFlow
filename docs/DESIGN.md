# TaskFlow design (Stage A)

TaskFlow is a multi-workspace issue tracker built on the published FeltKit 0.3.29
(`@feltdb/core` 0.21.0, `@appport/services` 0.17.0). This document fixes the domain model,
the authorization model and the query patterns before any screen is built. Everything here was
checked against the installed package's types and docs, and the riskiest assumptions were run in
a probe app (results in §6).

## 1. What the platform provides, and what TaskFlow keeps

| Need | Owner | Mechanism |
|---|---|---|
| Accounts, sign-in, sessions, CSRF | FeltKit | `auth.accounts`, cookie sessions |
| Workspaces, membership, roles, invitations, switching | FeltKit | `auth.tenant` (`/api/tenants/*`, `TenantSwitcher`, `TenantSettings`) |
| Workspace data isolation | FeltKit | `{ tenant: { field: "workspaceId" } }` on every collection |
| Role → permission per call, every interface | FeltKit / AppPort | `roles`, `access` |
| Per-record rules (team access, ownership) | FeltKit mechanism, TaskFlow rules | one `feltkit({ authorize })` hook (`feltkit/_policy.ts`) |
| Atomic writes, conflict detection | FeltDB via FeltKit | mutation = one transaction, read fences |
| Issue numbers `ENG-42` | FeltKit | `ctx.db.sequence("issue:<teamId>")` (gapless, commit-ordered) |
| Activity history | FeltKit | `app.auditTrail("activity", …)`, written in the change's transaction |
| Notifications | AppPort Services | `ctx.afterCommit.notifications.send` (only if the mutation commits) |
| Live updates | FeltKit | live queries (`useQueryState`), predicate invalidation |
| Search | FeltKit | `ctx.db.search` (scan; FeltDB has no text index, UPSTREAM-GAPS F23) |
| Agent access | FeltKit / AppPort | functions published as AppPort capabilities; `/appport`, `/mcp`; agent principals as workspace members |
| Human approval of agent proposals | FeltKit | `approval: "required"` + agent tasks |
| Evidence | FeltKit | activity log (decision ids, writes), audit trail with `requestId` |

TaskFlow owns: the domain model, team semantics (private teams, team leads, guests limited to
their teams), workflow rules (states and categories, closing/reopening, cycle and project
consistency), the views, and the screens. It owns no session, membership, transport, queue,
notification store, audit store or authorization engine.

## 2. Domain model

All collections are workspace-scoped (`workspaceId`, set by FeltKit from the session).
References are ids. Nothing authoritative is copied: an issue's key (`ENG-42`) is computed from
`team.key` and `issue.number` at read time; member names come from `ctx.tenancy.members()`.

| Collection | Fields | Indexes (= live-query keys) |
|---|---|---|
| `teams` | `key` (2–5 caps, unique per workspace — app-enforced, see GAP-01), `name`, `description?`, `private`, `createdBy`, `createdAt` | `key` |
| `teamMembers` | `teamId`, `userId`, `role: lead\|member`, `addedBy`, `addedAt` | `teamId`, `userId` |
| `workflowStates` | `teamId`, `name`, `category: backlog\|unstarted\|started\|completed\|canceled`, `position`, `color` | `teamId` |
| `labels` | `name`, `color`, `teamId?` (workspace-wide when absent) | `teamId` |
| `projects` | `name`, `description?`, `status: planned\|started\|paused\|completed\|canceled`, `teamId`, `leadId?`, `startDate?`, `targetDate?`, `createdBy`, `createdAt`, `updatedAt` | `teamId` |
| `milestones` | `projectId`, `name`, `targetDate?`, `position` | `projectId` |
| `cycles` | `teamId`, `number` (sequence per team), `name?`, `startDate`, `endDate`, `createdBy` | `teamId` |
| `issues` | `teamId`, `number`, `title`, `description?`, `stateId`, `priority 0–4`, `type: issue\|bug\|feature\|task`, `assigneeId?`, `creatorId`, `labelIds[]`, `estimate?`, `dueDate?` (YYYY-MM-DD), `projectId?`, `milestoneId?`, `cycleId?`, `parentId?`, `sortOrder`, `createdAt`, `updatedAt`, `completedAt?`, `canceledAt?` | `teamId`, `stateId`, `assigneeId`, `projectId`, `cycleId`, `parentId` |
| `issueRelations` | `issueId` blocks `blockedId`, `createdBy`, `createdAt` | `issueId`, `blockedId` |
| `comments` | `issueId`, `authorId`, `body`, `mentions[]`, `createdAt`, `editedAt?`, `deletedAt?` | `issueId` |
| `workspaceSettings` | `issueEstimates: none\|points\|tshirt`, `defaultTeamId?` | — |
| `activity` | `app.auditTrail`: `subjectType` (issue, project, cycle, team), `subjectId`, `type`, `actor`, `at`, `seq`, `requestId`, `data` (field, from, to) | platform |

Workspace name, members, roles, invitations: platform records, read through `ctx.tenancy` and
`/api/tenants/*`. Notifications: AppPort Services records, `data.workspaceId` set so the inbox
shows the current workspace's.

## 3. Authorization

Two layers, both platform mechanisms:

1. **Roles** (`feltkit({ roles })`, checked before arguments). Workspace roles, highest first:
   `owner`, `admin`, `member`, `agent`, `guest`. Accounts hold `person` (no workspace
   permission). Permissions: `workspace.read`, `workspace.manage`, `teams.create`,
   `teams.manage`, `issues.read`, `issues.create`, `issues.update`, `issues.delete`,
   `comments.write`, `comments.moderate`, `projects.read`, `projects.write`, `cycles.write`,
   `labels.write`. Guests read and comment and create; agents read, create, update and
   comment, and may only *propose* deletion.
2. **Resource policy** (one `authorize` hook, `feltkit/_policy.ts`). Every function is
   registered with how its target is found (`teamId`, `issueId`, `projectId`, `cycleId`,
   `commentId`, …). An unregistered function is refused (default deny, with a test that every
   exported function is registered). For each target the hook:
   - resolves it through the call's tenant-scoped reader; unknown and not-visible are both
     `NOT_FOUND`;
   - resolves its team; a private team, or any team for a guest, requires team membership
     (owners and admins see every team);
   - applies the function's ownership rule: team settings and team membership need the team
     lead or `teams.manage`; deleting an issue needs its creator or `issues.delete` at admin
     rank; editing a comment needs its author; deleting one needs its author or
     `comments.moderate`.

   The hook's reads are fenced at commit and part of live read sets, so a membership removed
   mid-call fails the mutation, and a watching client loses access on the next run.

Handlers enforce domain consistency (a cycle must belong to the issue's team, a state must
belong to the issue's team, an assignee must be a workspace member) because those are rules
about the data, not about the caller.

## 4. Query patterns (from the views)

| View | Query | Read path |
|---|---|---|
| Sidebar | `workspace:overview` | teams + my team memberships + counts |
| My issues / team issues / project / cycle list and board | `issues:list` (one query for list and board) | one indexed equality (`cycleId` > `projectId` > `assigneeId` > `teamId`) pushed into `find`; remaining filters and the sort in memory; offset pages with `total` so nothing is silently cut |
| Issue panel | `issues:get` | issue, sub-issues, relations, comments, activity history |
| Search / ⌘K | `issues:search` | identifier (`ENG-42`) → team key + number lookup; otherwise `ctx.db.search` over title |
| Project overview | `projects:summary` | issues by project, milestones, progress by state category |
| Cycle view | `cycles:get` | issues by cycle, scope/completed/started counts |
| Attention | `issues:attention` | overdue (due < today, open) and blocked (an open blocker) |
| Inbox | `inbox:list` | notifications service, filtered to the current workspace |

`issues:list` reads every issue matching its pushed-down equality, then pages. That is linear in
the team/project/cycle/assignee size (thousands, not millions) and complete. A cursor over a
multi-field in-memory sort would need an `in` clause and composite indexes FeltDB's query API
does not offer.

## 5. Agent capabilities

Published functions (same handlers, same `access`, same `authorize` hook as the screens):
`issues.search`, `issues.get`, `issues.create`, `issues.update`, `issues.assign`,
`issues.setstatus`, `comments.add`, `projects.summary`, `issues.attention`, and
`issues.delete` (`approval: "required"` for non-person callers).

An agent is a principal (`type: "agent"`) holding a workspace membership with role `agent`,
added by a workspace manager. Removing the membership, or revoking its session, ends its
authority on the next call. Discovery grants nothing.

## 6. Probe results (scratch app, FeltKit 0.3.29)

| Probe | Result |
|---|---|
| `unique` on a tenant collection | **Global across workspaces** (GAP-01). A `unique` naming the tenant field is refused at load. |
| `s.ref` to another workspace's record | **Accepted** (GAP-02). Every reference is checked by TaskFlow through the tenant-scoped reader. |
| Calls without a workspace | Refused (`FORBIDDEN`) |
| `ctx.db.sequence` per team, 8 concurrent | 1–8, gapless |
| `app.auditTrail` with `tenant` | Works; records actor, `seq`, `requestId` |
| `ctx.db.search` | Works (scan) |
| Agent principal added with `addPrincipal(…, "agent")` | Reads its workspace; refused in another |
| Restart | Data intact |

## 7. Plan

- **B Foundation**: app config, collections, policy hook, workspace bootstrap, teams, states,
  labels, projects, issues (create/get/update), navigation shell.
- **C Work management**: list/board, filters, search, cycles, milestones, comments, activity.
- **D Collaboration**: notifications, live updates, multi-user tests.
- **E Agents**: capabilities, agent membership, revocation, approval, evidence.
- **F Acceptance**: realistic dataset tests, gap register, measurements, report.
