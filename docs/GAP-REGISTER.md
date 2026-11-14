# TaskFlow platform gap register

Measured against the published stack on 2026-11-14: `@feltdb/feltkit` 0.3.29 (`@feltdb/core` 0.21.0,
`@appport/services` 0.17.0, `@appport/authorization` 1.1.1, `@appport/server` 1.3.2). No platform
repository was modified.

**Classes**
1. Platform capability exists and works.
2. Exists but is incomplete or unreliable.
3. Missing.
4. Application-specific: stays in TaskFlow.
5. Documentation or discoverability problem.

Each gap was reproduced by running code, not inferred from the API's shape. Reproductions:
- `platform-probes/tests/gaps.test.ts`: `npm run test:probes`. A deliberately unguarded app, asserting current behavior. A failing probe means the platform changed.
- TaskFlow's own tests: `npm test`.

## Summary

| ID | Gap | Class | Owner | Severity | Blocks production? |
|---|---|---|---|---|---|
| TF-GAP-01 | `unique` on a workspace-scoped collection is enforced across all workspaces | 2 | FeltKit (collection options) / FeltDB (index scope) | High | No for TaskFlow (worked around); yes for any tenant app that uses `unique` naively |
| TF-GAP-02 | `s.ref` accepts another workspace's record; the hidden reference then blocks the owner's delete | 2 | FeltKit (tenant scope of reference checks) / FeltDB (restrict-on-delete) | High | No for TaskFlow (worked around); yes for apps that trust `s.ref` |
| TF-GAP-03 | No app-facing way for a workspace member to approve another principal's proposed action | 3 | FeltKit | Medium-High | Yes, for in-product agent approvals |
| TF-GAP-04 | Query API has no `in`, array-contains or multi-field sorted pushdown; search scans (known F23) | 2 | FeltDB | Medium | Not at thousands of issues per team; yes at 100k+ |
| TF-GAP-05 | Notifications are per recipient, not per workspace | 2 | AppPort Services / FeltKit | Medium | No (worked around) |
| TF-GAP-06 | Docs say Files are application-wide; they are workspace-scoped | 5 | FeltKit docs | Low | No |
| TF-GAP-07 | Docs say agent actions run without a workspace; approved actions did reach workspace data | 5 | FeltKit docs | Low | No |
| TF-GAP-08 | UPSTREAM-GAPS A9 (no `NOT_FOUND` denial) is stale | 5 | FeltKit docs | Low | No |
| TF-GAP-09 | The `authorize` hook reads the database only, not service records (files) | 3 | FeltKit | Low | No |
| TF-GAP-10 | An after-commit effect the caller's role cannot perform fails in the outbox, with no warning | 5 / 2 | FeltKit | Medium (developer experience) | No, once known |
| TF-GAP-11 | No primitive for groups inside a workspace (teams, channels) and their access | 4 (candidate 3) | FeltKit | Low-Medium | No |
| TF-GAP-12 | Person-to-agent delegation (on behalf of) is not available; AuthBoundry is not integrated | 3 | FeltKit / AuthBoundry | Medium | Depends on the requirement |
| TF-GAP-13 | `isFunctionDefinition` is declared but not exported | 5 | FeltKit | Low | No |
| TF-GAP-14 | `useAuthRedirect` ignores an invitation link opened in an already-loaded tab | 2 | FeltKit (React) | Low | No |

## Details

### TF-GAP-01: unique constraints span workspaces

- **Reproduction.**
  1. Declare `app.collection("teams", { key }, { tenant: true, unique: [["key"]] })`.
  2. Workspace A inserts `ENG`.
  3. Workspace B inserts `ENG`.
  - Probe: `TF-GAP-01`.
- **Expected.** Uniqueness within a workspace. B gets its own `ENG`.
- **Actual.**
  - B is refused: `CONFLICT … teams_key_unique`.
  - The refusal tells B that some other workspace has a team called `ENG`, an existence oracle across tenants.
  - Naming the tenant field in the constraint is refused at load: `unique constraint names "workspaceId", which the collection does not declare`.
- **Workaround** (`feltkit/teams.ts:39`, 2 lines):
  - No `unique`. `teams:create` reads by key in its transaction.
  - A concurrent duplicate fails at commit through the read fence (tested in the probe app during reconnaissance).
- **Ask.** Scope `unique` to the tenant field on tenant collections (or allow naming it), and never refuse across tenants.

### TF-GAP-02: references cross workspaces

- **Reproduction.**
  1. Workspace B inserts a record whose `s.ref` field holds a workspace A record id.
  2. Workspace A then deletes its record.
  - Probe: `TF-GAP-02`.
- **Expected.** `NOT_FOUND` on B's insert: A's record does not exist in B.
- **Actual.**
  - B's insert is accepted.
  - A can no longer delete its own record: restrict-on-delete, caused by a reference A cannot see.
- **Workaround.** Every reference is re-read through the tenant-scoped reader:
  - the policy hook resolves each id argument (`feltkit/_policy.ts:110`);
  - `checkIssueRefs` (`feltkit/_domain.ts:66`);
  - `cycles:addIssues`.
  - About 10 lines are there only for this gap. The rest also enforces same-team rules TaskFlow needs anyway.
  - Tested on every reference field: `tests/foundation.test.ts`, "cross-workspace references are refused".
- **Ask.** Validate `s.ref` within the writer's tenant for tenant collections.

### TF-GAP-03: no in-app approval of another principal's proposal

- **Reproduction** (exploration recorded in `tests/agents.test.ts` history):
  1. An agent proposes `issues.delete`.
  2. The workspace owner signs in over HTTP and calls `client.approveAction(taskId, actionId)`.
- **Expected.** A route for a person with the authority to approve proposals made in their workspace, so an app can build an approvals inbox.
- **Actual.**
  - `approveAction` covers only the caller's own tasks: `NOT_FOUND: No agent task …`.
  - Approval of others' proposals exists only as `runtime.agent.approve`, the path Studio uses.
  - That path needs the approver *as their workspace session resolves them*, roles including the tenant role. Passed without it, the owner is refused: "user:ada may not perform issues.delete".
  - Whether development Studio supplies the workspace role for tenant apps is **unverified**.
  - Production approval of agent actions is listed in FeltKit's own roadmap as missing.
- **What works** (tested, `tests/agents.test.ts`, "approval"):
  - the agent and an under-privileged member cannot approve;
  - the owner's approval runs the action *as the agent*;
  - an approved deletion of someone else's issue fails at execution under the agent's own authority. Approval never widens the requester's authority.
- **Workaround.** None in TaskFlow. Its UI has no approvals screen.
- **Ask.** An authenticated, app-facing approve/reject route for workspace members holding the action's permission, or a React approvals component.

### TF-GAP-04: query expressiveness

- **Facts.**
  - `db.query` takes `eq`, `neq`, `lt`, `lte`, `gt`, `gte`.
  - There is no `in`, no array membership, and no composite index with sort pushdown.
  - `search` scans the records matching an equality `where`. This is UPSTREAM-GAPS F23, already known.
- **Effect on TaskFlow.** `issues:list` (`feltkit/issues.ts:72-127`):
  - pushes one indexed equality (cycle, project, assignee or team);
  - filters the rest and sorts in memory;
  - pages by offset with a full `total`.
- **Measured.**
  - Listing all 1,200 issues of a seeded workspace: 30 ms.
  - Search: 19 ms.
  - Attention: 75 ms.
  - Completeness is tested against a brute-force oracle (`tests/work.test.ts`).
  - Cost is linear in the pushed-down partition (a team's issues).
- **Workaround.** About 50 lines of in-memory filter and sort. Search drops unreachable teams after the scan (`issues.ts:147`).
- **Ask.** An `in` clause, array-contains on indexed arrays, composite indexes with ordered cursors, and a text index (F23).

### TF-GAP-05: notifications are not workspace-scoped

- **Reproduction.** A person in two workspaces receives a notification sent in A. Listing from a session in B returns it. Probe: `TF-GAP-05`.
- **Expected.** Notifications scoped like `{ tenant }` data, or at least a tenant field the service filters on.
- **Actual.** Notifications are per recipient across workspaces. GUARANTEES.md: "the Services tenant is the application name".
- **Workaround** (`_domain.ts:137`, `inbox.ts:16,35`, about 5 lines). Each notification carries `data.workspaceId`; the inbox filters by the session's workspace. Tested in `tests/collab.test.ts`.
- **Residual risk.** Any other read path that lists notifications without that filter shows other workspaces' titles. The list also has no limit or cursor (FRAME-GAP-08).

### TF-GAP-06: Files are workspace-scoped (documentation is wrong)

- **Docs.** GUARANTEES.md says "Files are application-shared: any principal with `files.read` reads every file".
- **Observed** (probe).
  - A file uploaded in Acme is listed for another Acme member.
  - It is not listed for a member of another workspace.
  - It is not listed for its own uploader working in another workspace.
- TaskFlow relies on the observed behavior, and the probe fails if it changes.
- `tests/collab.test.ts` covers attachments across workspaces.

### TF-GAP-07: agent actions and workspaces (documentation)

- **Docs.** GUARANTEES.md says "Jobs, schedules and agent actions run as their principal without a workspace, so they cannot reach `{ tenant }` collections yet."
- **Observed.**
  - An approved agent action ran as the proposing agent session and read and deleted workspace data: it succeeded on the agent's own issue.
  - TaskFlow's policy refused it on someone else's issue with `FORBIDDEN`, not `NO_TENANT`.
- **Unverified.** Jobs and schedules in a workspace. TaskFlow uses neither.

### TF-GAP-08: stale upstream-gap entry

- UPSTREAM-GAPS A9 says an `AuthorizationDecision` cannot deny with `NOT_FOUND`.
- `@appport/authorization` 1.1.1 has the code ("conceals existence").
- TaskFlow's hook returns it, and `NOT_FOUND` reaches HTTP, AppPort and MCP callers (tests).

### TF-GAP-09: the policy hook cannot see service records

- The `authorize` hook gets a database reader, not `ctx.services`.
- Attachment removal ("uploader or admin") is therefore checked in the handler (`attachments.ts:55`, 2 lines), the one ownership rule outside `_policy.ts`.
- **Ask.** A read-only services view in `AuthorizeRequest`, or a way to declare a file's owning resource.

### TF-GAP-10: silent after-commit failures from missing service permissions

- **Reproduction** (`tests/collab.test.ts`, history). Workspace roles without `notifications.send`:
  - `issues:create` with an assignee committed;
  - the notification effect then failed in the outbox ("runs as the caller");
  - nobody was notified.
- **Expected.** A load-time or first-call warning that a function stages an effect some of its callers cannot perform. The scaffold gives members `notifications.*`, but a tenant app's workspace roles start empty.
- **Actual.** Correct per the contract and inspectable (`feltkit outbox list`), but easy to miss.
- **Mitigation.** TaskFlow grants the permission and asserts the outbox holds no failed effect.

### TF-GAP-11: groups inside a workspace

- Teams (private teams, team leads, guests limited to their teams) are TaskFlow's rules, written once in the `authorize` hook.
- About 60 lines of `_policy.ts` are generic: resolve an argument to a record, the record to a group, check group membership.
- The multiplayer reference app wrote the same shape for channels.
- That makes two apps, which is evidence for a platform primitive (scoped groups and membership in policy). It stays application code until then.

### TF-GAP-12: delegation

- AGENT-OPERATIONS §9: the AuthBoundry adapter (delegations, agent credentials) is not started, and AppPort has no on-behalf-of chain.
- **What TaskFlow can show, and tests:**
  - authority granted by a workspace manager (agent membership with a role);
  - approval-based delegation (a person approves an agent's proposal; it runs under the agent's own authority);
  - revocation of either (membership removal, session revocation: the next call fails).
- **Missing.** "This agent acts for Ada, with at most Ada's authority, until Ada revokes it."

### TF-GAP-13: `isFunctionDefinition` not exported

Declared in `app.d.ts`, absent from the package root. `tests/foundation.test.ts` uses a structural check instead.

### TF-GAP-14: invitation link in an open tab

- `useAuthRedirect` reads the URL once.
- Opening `/#feltkit-invitation=…` in a tab where the app is already loaded is a same-document navigation, so it is ignored until reload.
- Observed in Chromium (Playwright). No automated test in this repository.

## Capabilities that exist and work (class 1)

| Capability | Evidence |
|---|---|
| Workspaces, invitations, membership, roles, switching (`auth.tenant`), React screens | `tests/foundation.test.ts`, `tests/collab.test.ts`; Chromium: invite, accept, work |
| Workspace isolation of reads and writes on `{ tenant }` collections | isolation tests on list, get, search, update, comment and delete |
| Live membership: a removed member or agent loses access on the next call | `collab.test.ts`, `agents.test.ts` |
| `authorize` hook on every interface (HTTP, AppPort, MCP, agent actions), `NOT_FOUND` concealment | foundation and agents tests |
| Atomic mutations, read fences: racing edits give retryable `CONFLICT`, none lost | `work.test.ts` (measured: 1 commit, 3 conflicts) |
| `ctx.db.sequence` with `retry.sequenceConflicts`: gapless per-team keys under concurrency | 25 parallel creates give 1–25 |
| `app.auditTrail` in the change's transaction: actor, `seq`, `requestId` | lifecycle and agent history tests |
| After-commit notifications, never for a failed mutation | `collab.test.ts` |
| Live queries over HTTP, isolated by workspace | about 27 ms (test), 81 ms (browser) |
| Files with single-use upload links and expiring download links, workspace-scoped | `collab.test.ts`, Chromium |
| AppPort capabilities and MCP tools with per-caller `allowed` and `invoke` | `agents.test.ts` |
| `approval: "required"`, approver checks, execution as the proposer | `agents.test.ts` |
| AppPort idempotency keys (a replay returns the first outcome; key reuse is refused) | `agents.test.ts` |
| Session revocation, 401 on the next call | `agents.test.ts` |
| Durable state across restart (900 issues compared field by field) | `work.test.ts` |
| `feltkit build` (53 functions, 10 capabilities, schema contract, bundle scan), `feltkit measure --check` | command output in docs/REPORT.md |
