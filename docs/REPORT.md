# TaskFlow on FeltKit: validation report

Built on the published stack only:
- `npm create feltkit@latest` (create-feltkit 0.3.29);
- `@feltdb/feltkit` 0.3.29, `@feltdb/core` 0.21.0, AppPort 1.x, `@appport/services` 0.17.0.

No platform repository was changed, and nothing unpublished was consumed. Platform limitations are in
[GAP-REGISTER.md](GAP-REGISTER.md); the design is in [DESIGN.md](DESIGN.md).

## 1. Status by capability

| Area | Status | Evidence |
|---|---|---|
| Workspaces: create, invite, accept, roles, switch, leave (FeltKit `auth.tenant` and its React screens) | **Implemented, tested** | test harness plus a Chromium run as two people (invite, accept, work) |
| Workspace isolation on every read and write path | **Implemented, tested** | `foundation.test.ts` (list, get, search, update, comment, delete across workspaces) |
| Cross-workspace reference manipulation | **Implemented, tested** | every reference field; platform gap TF-GAP-02 worked around |
| Teams: private teams, leads, guests limited to their teams, workflow states | **Implemented, tested** | `foundation.test.ts` |
| Ownership: issue deletion (creator or admin), comment edit (author), comment delete (author or moderator) | **Implemented, tested** | `foundation.test.ts` |
| Issue lifecycle: create, assign, priority, status, labels, estimate, due date, project, milestone, cycle, parent, close, reopen, delete | **Implemented, tested** | `foundation.test.ts`, `work.test.ts` |
| Relations (blocks / blocked by), sub-issues, cycle prevention | **Implemented, tested** (relations); cycle prevention implemented, not separately tested | |
| Durable history (audit trail, per-issue `seq`, actor, request id) | **Implemented, tested** | lifecycle test, restart test |
| List and board from one query; filters; sorts; pagination | **Implemented, tested** on 900 seeded issues against a brute-force oracle | `work.test.ts` |
| Search by key and title | **Implemented, tested** | scan-based (TF-GAP-04) |
| Projects, milestones, progress, overdue, project activity | **Implemented, tested** | `work.test.ts` |
| Cycles: progress, points, overlap rule, team boundary | **Implemented, tested** | `work.test.ts` |
| Needs attention (overdue, blocked) | **Implemented, tested** against a brute-force oracle | `work.test.ts` |
| Concurrency: gapless keys; racing edits refused, never lost; stale `expectedVersion` refused | **Implemented, tested** (conflicts measured, asserted to occur) | `work.test.ts` |
| Notifications to multiple people (assign, mention, comment, status), workspace-filtered, none on failure | **Implemented, tested** | `collab.test.ts`; live badge in Chromium (~257 ms) |
| Realtime: live queries over HTTP across people, isolated by workspace | **Implemented, tested** | `collab.test.ts` (~27 ms); Chromium (81 ms, board drag seen by another person) |
| Attachments (upload and download links, workspace- and issue-scoped) | **Implemented, tested** | `collab.test.ts`; Chromium upload and download |
| Agents over MCP and AppPort: search, get, create, update, assign, set status, comment, project summary, attention | **Implemented, tested** over real `/mcp` and `/appport` | `agents.test.ts` |
| Agent denials (role, private team, other workspace, mandatory approval) | **Tested** | `agents.test.ts` |
| Approval: a person approves an agent's proposal; it runs with the agent's authority | **Tested** via the runtime API | **No in-app approvals screen**: TF-GAP-03 |
| Idempotent retries (AppPort key) | **Tested** | `agents.test.ts` |
| Revocation (membership removal, session revocation) | **Tested** | `agents.test.ts`, `collab.test.ts` |
| Restart keeps state (900 issues, 25 full issue details, projects, attention compared) | **Tested** | `work.test.ts` |
| Person-to-agent delegation ("acts for Ada") | **Missing** (platform: TF-GAP-12) | |
| Production deployment | **Partially verified**: `feltkit build` passes. `feltkit deploy`, `start` and hosted targets were not run | |

UI (Chromium, `feltkit dev`):
- **Views:** list and board; issue panel; projects; cycles; inbox; settings; ⌘K search.
- **Keyboard:** C (new issue), / (search), j/k (move), Esc (close).
- **Theme and layout:** light and dark; phone layout with no horizontal overflow (iPhone 13 emulation).
- **Not tested:** no automated browser test is committed (the Playwright scripts were run during development); no accessibility audit beyond labelled controls and focus styles.

## 2. Test results (final run)

| Suite | Tests | Pass | Fail | Skip | Time |
|---|--:|--:|--:|--:|--:|
| `npm test` (TaskFlow: foundation 6, work 9, collab 5, agents 5) | 25 | 25 | 0 | 0 | 22.4 s |
| `npm run test:probes` (platform gap reproductions) | 4 | 4 | 0 | 0 | — |
| `npm run typecheck` | — | pass | | | |
| `feltkit measure --check` | 4 checks | pass | | | |

**Environment.**
- Each test gets its own temporary local FeltDB, so no services are needed.
- Agent, realtime and attachment tests start a real FeltKit HTTP server on a loopback port.
- No model provider is configured; no test depends on one.
- Node 22.23.

## 3. Lines of code (`feltkit measure`)

| Class | Lines | Files | What |
|---|--:|--:|---|
| Domain (`feltkit/`) | 1,580 | 13 | collections, policy, functions; includes the 123-line demo seed |
| Experience (`src/`, `index.html`) | 1,700 | 8 | 1,437 TSX + 247 CSS + 16 HTML |
| Configuration | 93 | 5 | package files, measure declarations |
| Tests | 865 | 5 | plus 90 lines of platform probes |
| Infrastructure (FeltKit's classification) | **0** | 0 | `feltkit measure`: "Infrastructure findings: None" |
| Generated | 98 | 7 | codegen output, unchanged scaffold files |

**Workaround code, counted by hand.**
- Platform gaps:
  - TF-GAP-01: 2 lines;
  - TF-GAP-02: about 10;
  - TF-GAP-05: about 5;
  - TF-GAP-09: 2.
  - About **20 lines** in total, each marked with its gap ID in the source.
- Code shaped by platform limits rather than written to work around a gap:
  - the in-memory filter and sort of `issues:list` (about 50 lines, TF-GAP-04);
  - the generic part of the team resolver in `_policy.ts` (about 60 lines, TF-GAP-11).

These sit inside domain code. They are listed here so the domain count does not hide them.

## 4. Platform leverage

**Used unchanged:**
- Accounts and sign-in.
- Cookie sessions with CSRF.
- Tenancy: workspaces, ranked roles, invitations, switching, live membership.
- FeltKit's React auth and workspace screens.
- Schema-validated collections with a FeltDB state contract.
- Atomic mutations with read fences.
- Per-team sequences with conflict retry.
- The typed audit trail.
- The transactional after-commit outbox.
- AppPort Services: notifications, files with upload and download links, API keys, configuration.
- Live queries with per-workspace invalidation.
- The role policy on every interface, plus the resource `authorize` hook.
- AppPort capabilities, the MCP endpoint, and the agent context with per-caller `allowed` and `invoke`.
- `approval: "required"` with the proposal and approval lifecycle.
- AppPort idempotency.
- Session issue and revocation.
- The activity log with decision ids.
- Test harness (`createTestApp`, tenancy setup, restart).
- `feltkit build` and `feltkit measure`.

**Infrastructure TaskFlow did not have to write**, each of which a stand-alone Linear-style app would own:
- an auth system and session store;
- membership and invitation tables, flows and screens;
- an authorization middleware applied across HTTP, RPC and agent transports;
- a websocket/SSE change feed with per-tenant filtering and query invalidation;
- a transactional outbox and worker;
- a gapless counter service;
- an audit log;
- a notification store;
- file storage with signed links;
- an idempotency store;
- an MCP server and tool schema generation;
- an agent proposal and approval state machine.

No line count is claimed for these: there is no honest baseline to measure against.

**Where the platform fell short** (GAP-REGISTER.md):
- two tenant-isolation defects in core primitives (`unique`, `s.ref`);
- no in-app approval route;
- limited query expressiveness;
- notifications not workspace-scoped;
- no delegation;
- several stale documentation claims.

None forced TaskFlow to build infrastructure. Two of them (TF-GAP-01, -02) would silently weaken isolation in an app that trusted the platform's primitives.

## 5. Not verified

- `feltkit deploy` and the container, hosted (Managed FeltDB), self-hosted, Vercel and Cloudflare targets.
- Live-query latency on a FeltDB server, which the docs say polls once a second.
- Multiple server processes.
- An AppBoundry artifact build. `ctx.afterCommit` and `ctx.db.sequence` need `transactions@1`, and tenancy needs `tenancy@1`; neither was tried.
- E-mail delivery of invitations (Mailerport). In development the link is shown to the inviter.
- Development Studio's approval screen for a workspace app (TF-GAP-03).
- Jobs and schedules inside a workspace (unused).
- Model-driven agent decisions (no model configured).
- Behaviour beyond about 1,200 issues per workspace. List cost is linear in the pushed-down partition.
- Accessibility with assistive technology, and browsers other than Chromium.
