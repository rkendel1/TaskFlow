# Platform remediation plan for TaskFlow's findings

**Status: proposal for review. Nothing here has been implemented, filed, or merged.**
- TaskFlow is the frozen baseline at commit `5a56f47`. This document is the only change.
- No platform repository was modified.

## 1. Baselines and method

| Repository | Inspected at | Published |
|---|---|---|
| TaskFlow | `5a56f47` (`claude/wizardly-davinci-dn7iup`) | — |
| feltkit | `main` `6c823b1` (2026-11-13). `packages/sdk` is **0.3.30, unpublished**. Main **does not compile**; see B1 | `@feltdb/feltkit` 0.3.29 (2026-11-13 19:22 UTC) |
| flow_db | `main` `ee2a948` | `@feltdb/core` 0.21.0 |
| appport | `main` `35a57ea` | `@appport/authorization` 1.1.1, `@appport/server` 1.3.2 |
| appport-services | `main` `9f2ca53` | `@appport/services` 0.17.0 |
| authboundry | `main` `b787fc9` (1.17.4) | `@authboundry/core` 1.17.3. `@authboundry/local`: **not on npm** |

How each finding was verified:
1. Reproduced on published 0.3.29, with TaskFlow tests or `platform-probes/`.
2. Root cause located in the owning repository's `main`, by reading the code.
3. Checked against the platform's own register (`feltkit/docs/platform/GAP-REGISTER.md`, "unified register"), open PRs, and remote branches, for existing work.

New probes were run in a scratch directory outside TaskFlow; their code is quoted here so they can be reproduced.

**Existing workstreams found:**
- **Open PRs (all five repos):** one. feltkit #125, "Fix main: restore the brace and the import lost in merge c83977d".
- **Branch without a PR:** feltkit `claude/notifications-pagination` (`9cc9ecb`, 2026-11-14), stacked on #125.
- **Already merged before 0.3.29, so not new work:** `tenancy-followups`, `auth-tenancy`, `scoped-events`.
- **Unrelated despite their names:** flow_db `state-ref-authority` and `feltdb-equality-index-*`. They are older and about other subjects.

## 2. Corrections to TaskFlow's own register

Verification changed five findings. **docs/GAP-REGISTER.md is left as written** (TaskFlow is frozen); this plan supersedes it where they differ.

| ID | TaskFlow said | Verified |
|---|---|---|
| TF-GAP-01 | Per-workspace uniqueness is impossible | **Possible today**, but undocumented. Declare the tenant field in the shape, then name it in `unique`. Probe P-1 (§8): another workspace's `ENG` is accepted; the same workspace's duplicate is `CONFLICT`. The default path is still unsafe. |
| TF-GAP-04 | No `in` or array clauses anywhere | `@feltdb/core` 0.21.0 has `CanonicalQuery` with `in`, `contains`, `startsWith`, `and`/`or`/`not` (`dist/state-contract.d.ts`). It runs **only** through the HTTP client `state.query` against a FeltDB server (`dist/http-client.d.ts:124`). The embedded engine evaluates only `AuthorityQueryRequest` conditions (`dist/embedded-query.d.ts:23`), and FeltKit's `ctx.db.query` exposes only those (`feltkit packages/sdk/src/runtime/data.ts:54-62`). |
| TF-GAP-06 | Docs wrong about files | Behaviour was fixed as unified register **LA-G04**. FeltKit stamps `metadata["feltkit.tenant"]` (`runtime/services.ts:859`, `:1317`). Only GUARANTEES.md:330 is stale. |
| TF-GAP-07 | Docs wrong about agent actions | Fixed as **LA-G02** (`runtime/agent.ts:548`, `:1843-1859`). GUARANTEES.md:349 is stale **for agent actions only**. LA-G01 records that *schedules'* jobs still carry no workspace. |
| TF-GAP-12 | Delegation missing | **Partly published.** 0.3.29 ships `ctx.authority.decide({ capability, onBehalfOf })` against a hosted AuthBoundry (`dist/runtime/context.d.ts:94-206`, GUARANTEES.md:565). The person-facing `ctx.authority.grants` and `authority: { local: true }` are on feltkit main only (#121, after 0.3.29) and need `@authboundry/local`, which is unpublished. TaskFlow did not evaluate `ctx.authority`. |

## 3. Prioritized findings

Priority uses the unified register's scale: P0 security or authorization, P1 durability or correctness, P2 reliability or operations, P3 developer and agent experience. Ranking within a priority weighs, in order: exploitability, data integrity, then the number of applications affected (evidence in the "Apps" column).

| Rank | ID | Finding (verified) | Class | Owner (repository) | Priority | Apps affected (evidence) | Existing work | TaskFlow workaround removable |
|--:|---|---|---|---|---|---|---|---|
| 1 | TF-GAP-02 | `s.ref` on a tenant collection accepts another workspace's record; the hidden reference blocks the owner's delete | Security / tenant integrity; data integrity | FeltKit (`feltkit`) | **P0** | Every tenant app using `s.ref`: TaskFlow; multiplayer uses `{ tenant }` + `s.ref` (by its app.ts) | None. Sibling of unified **GAP-13** (Open, P1) | 6 LOC |
| 2 | TF-GAP-01 | `unique` on a tenant collection spans workspaces by default (existence oracle). A safe declared-field path exists but is undocumented | Security / tenant integrity | FeltKit (`feltkit`) | **P0** | Any tenant app declaring `unique` without the tenant field. TaskFlow avoided it | None | 1 LOC |
| 3 | TF-GAP-05 | Notifications are per recipient across workspaces; listing in one workspace returns another's | Security / tenant integrity (disclosure across a person's workspaces, and after removal) | FeltKit (`feltkit`, services adapter), following the LA-G04 precedent; AppPort Services if scoping moves into the service | **P1** | Every tenant app with notifications: TaskFlow, multiplayer | `claude/notifications-pagination` touches the **same** reader (paging only, no scoping). **Coordinate, don't duplicate** | 9 LOC |
| 4 | TF-GAP-03 | No app-facing route for a workspace member to approve another principal's proposal | Agent-authority limitation | FeltKit (`feltkit`) | **P1** | TaskFlow; TableOS (unified **TA-4**, "partly resolved": only own-task approval exists) | None. Depends on LA-G02 (closed) | 0 (unlocks an approvals screen) |
| 5 | TF-GAP-10 | An after-commit effect the caller's roles can't perform is staged anyway, then fails in the outbox while the mutation commits | Missing platform check (developer safety); not docs-only | FeltKit (`feltkit`) | **P2** | Any app whose roles lack a service permission. TaskFlow hit it | Sibling of TA-1 (anonymous callers; refusal implemented). Same function | 0 (permission stays; silent failure removed) |
| 6 | TF-GAP-12 | Person-to-agent delegation: `decide({ onBehalfOf })` published; grants and local authority unpublished | Agent-authority limitation | FeltKit (publish 0.3.30) + AuthBoundry (publish `@authboundry/local`; confirm 6B-#3 release) | **P2** | TaskFlow (not adopted); PersonalOS-style apps | **Implemented, unpublished** (feltkit #121; authboundry main). AppPort `delegated-authority-requirement.md`: design only | 0 (adoption adds code) |
| 7 | TF-GAP-04 | No `in` / array / boolean filters on the embedded runtime or in `ctx.db.query`; search scans (F23) | Performance / scalability | FeltDB (`flow_db`: embedded parity), then FeltKit (exposure) | **P2** | TaskFlow; frame (FRAME-GAP-05 feed merge); multiplayer (per-channel search loop) | Server-path implementation exists in published FeltDB (`CanonicalQuery`). Embedded parity: none found | about 61 LOC reducible |
| 8 | TF-GAP-09 | `authorize` hook gets `db` only, no read of service records (files) | Missing platform capability | FeltKit (`feltkit`, `authorize.ts`) | P3 | TaskFlow (1 rule) | None | 3 LOC |
| 9 | TF-GAP-07 | GUARANTEES.md:349 says agent actions have no workspace; fixed by LA-G02 | Documentation | FeltKit docs | P3 | All readers | Behaviour done (LA-G02) | 0 |
| 10 | TF-GAP-06 | GUARANTEES.md:330 says files are application-shared; fixed by LA-G04 | Documentation | FeltKit docs | P3 | All readers | Behaviour done (LA-G04) | 0 |
| 11 | TF-GAP-08 | UPSTREAM-GAPS A9 "Open"; NOT_FOUND denials exist (AppPort 1.1.1; FeltKit #62 "FK-GAP-018") | Documentation | FeltKit docs | P3 | All readers | Behaviour done. Unified register §6: "A9 not re-checked" | 0 |
| 12 | TF-GAP-13 | `isFunctionDefinition` declared, not exported from the root | Documentation / discoverability (API surface) | FeltKit (`packages/sdk/src/index.ts`) | P3 | Apps writing policy-coverage tests (TaskFlow) | None | 2 test LOC |
| 13 | TF-GAP-14 | `useAuthRedirect` reads the URL once, so an invitation link opened in a loaded tab is ignored | Documentation / UX, **by design** ("read once, cleared for all", `react/auth.tsx:175`) | FeltKit (`react/auth.tsx`) | P3 | Any app with invitations | None | 0 |
| 14 | TF-GAP-11 | No primitive for groups inside a workspace (teams, channels) | Application-specific (candidate primitive) | TaskFlow now; FeltKit only if decided | — (no remediation proposed) | TaskFlow (teams), multiplayer (channels): 2 apps | None in PLATFORM-PRIMITIVES.md | 50 LOC only if a primitive ships |

## 4. Findings in detail

Each entry gives:
- the evidence: TaskFlow reproduction and platform source;
- the owning repository and the implementation boundary;
- dependencies and existing work;
- the TaskFlow workaround to remove;
- an acceptance test.

Proposals state *what* must hold and *where* it belongs. Where the design is the owner's choice, the alternatives are listed, not chosen.

### Rank 1: TF-GAP-02, cross-workspace references (P0)

**Evidence**
- **Reproduction:** `platform-probes/tests/gaps.test.ts`, "TF-GAP-02". B inserts a `things` record referencing A's `plain` record; A's delete of its own record is then refused.
- **TaskFlow guard:** `tests/foundation.test.ts`, "cross-workspace references are refused on every reference field".
- **Root cause:** references are compiled into FeltDB's contract (`feltkit packages/sdk/src/runtime/state-contract.ts:66`, `field.reference`) and enforced only by FeltDB, which has no tenant concept. FeltKit merely maps FeltDB's violation (`runtime/data.ts:726-728`). No FeltKit write path checks the target's tenant.

**Owner and boundary: FeltKit.** It owns tenancy, so the check belongs in its writer. On insert, replace or patch of a tenant-scoped record, every `s.ref` field whose target collection is tenant-scoped must name a record in the *same* tenant. Otherwise refuse with `NOT_FOUND`, the same answer as `get` (concealment). The read must be fenced so the decision and the commit agree. FeltDB needs no change for this.

**Owner decisions needed**
- References from a tenant collection to a **non**-tenant collection, and the reverse. Related to unified GAP-13.
- Existing cross-tenant references in deployed data: an audit command, or refuse at `migrate`.
- AppBoundry guest/host parity (`tenancy@1`). The artifact path must apply the same rule.

**Dependencies:** B1 (main must compile). Independent of the other findings.

**TaskFlow workaround to remove:** `feltkit/_domain.ts:83-84` (project), `:87-88` (milestone existence; the same-project rule stays), `:97-98` (parent). That is 6 LOC. The rest of `checkIssueRefs` is TaskFlow domain logic and stays.

**Acceptance**
1. Probe "TF-GAP-02" inverted:
   - B's insert referencing A's record is `NOT_FOUND`;
   - nothing is written;
   - A deletes its record;
   - the same on patch and replace.
2. The same scenario through HTTP, AppPort and the artifact test host (`createArtifactTestApp`).
3. A same-workspace reference still works, and still blocks delete (restrict) as before.
4. A concurrent move of the target to another workspace is impossible (tenant field immutable), or refused at commit.
5. TaskFlow, with the six lines removed: `tests/foundation.test.ts` still passes, 25/25 overall.

### Rank 2: TF-GAP-01, `unique` spans workspaces by default (P0)

**Evidence**
- **Reproduction:** probe "TF-GAP-01". `CONFLICT … teams_key_unique` for another workspace.
- **Root cause:**
  - `app.ts:928` validates `unique` fields against the *declared* shape, so an auto-added tenant field cannot be named. The error is "names "workspaceId", which the collection does not declare".
  - `app.ts:947` and `state-contract.ts:84` pass the constraint to FeltDB verbatim, which makes it global.
- **Safe path today:** P-1 (§8). Declare the tenant field in the shape; `unique: [["workspaceId", "key"]]` then behaves per workspace.

**Owner and boundary: FeltKit.** For tenant-scoped collections, a `unique` constraint must be scoped to the tenant.

Alternatives for the owner:
- **(a)** prefix the tenant field automatically;
- **(b)** refuse a `unique` that omits it, with a hint;
- **(c)** allow naming the auto-added field.

Narrowing an existing global constraint to per-tenant only relaxes it, so existing data stays valid. Confirm that `feltkit migrate` classifies the change as additive. Whichever is chosen, an app must not be able to declare a cross-tenant unique constraint on a tenant collection without saying so.

**Dependencies:** B1. Requires AppBoundry guest/host parity for the artifact path (unverified).

**TaskFlow workaround to remove:** `feltkit/teams.ts:41` (1 LOC) plus the comments at `teams.ts:39-40` and `app.ts:71-72`, replaced by `unique` on teams. Independently, the P-1 path could remove it today. That is a TaskFlow change, out of scope here.

**Acceptance**
1. Probe "TF-GAP-01" inverted: B's `ENG` is accepted, and A's duplicate `ENG` is `CONFLICT`.
2. The refusal message never names or implies another workspace.
3. Same results through `createArtifactTestApp`.
4. `feltkit migrate --dry-run` on an app that had the global constraint reports no blocked records.
5. TaskFlow with `unique: [["key"]]` on teams and line 41 removed: 25/25 pass.

### Rank 3: TF-GAP-05, notifications not workspace-scoped (P1)

**Evidence**
- **Reproduction:** probe "TF-GAP-05". A person in A and "Personal" lists A's notification while working in "Personal".
- **Source:** the FeltKit notifications reader passes `recipient` and filters only (`runtime/services.ts`, `s.list(this.#tenantId, { recipient, … })`). Services' tenant is the application name, per GUARANTEES.
- **Precedent:** files were fixed by FeltKit stamping `metadata["feltkit.tenant"]` and filtering (`services.ts:859`, `:1317`, LA-G04).

**Owner and boundary: FeltKit's services adapter.**
- On `send` (direct or after-commit), record the sender's session workspace on the notification. The outbox record already carries `tenantId` (`transactions.ts:255`).
- On `list`, `get`, `markRead` and `dismiss`, show only notifications of the caller's current workspace.
- Notifications sent outside any workspace (account mail) stay visible where FeltKit decides. Owner decision.
- Moving the scope into AppPort Services (a real tenant dimension) is the alternative, with a larger blast radius.

**Dependencies**
- B1.
- **`claude/notifications-pagination` must land first, or the two must be merged deliberately.** It rewrites the same `list` path into cursor pages (`page()`, FRAME-GAP-08a). Scoping must apply to `page()` too.

**TaskFlow workaround to remove:** 9 LOC.
- `feltkit/_domain.ts:129`, `:137` (`data.workspaceId`);
- `feltkit/inbox.ts:13-16`, `:33-35` (filters).

**Acceptance**
1. Probe "TF-GAP-05" inverted: the "Personal" session lists nothing from A.
2. A member removed from A no longer sees A's notifications in any session, and cannot `get` or `markRead` them by id (`NOT_FOUND`).
3. Paging: cursor pages in a workspace never include another workspace's notifications, and none is skipped.
4. Notifications created before the change: behaviour documented and tested (hidden, as LA-G04 does for files, or migrated).
5. TaskFlow with the nine lines removed: `tests/collab.test.ts` passes, including "stay in their workspace".

### Rank 4: TF-GAP-03, no in-app approval of another principal's proposal (P1)

**Evidence**
- **Exploration** recorded in `tests/agents.test.ts`, "approval": `client.approveAction` on the agent's task answers `NOT_FOUND`.
- **Source:**
  - The app route `/api/agent/actions/approve` calls `approveOwn` (`server/index.ts:416`), which requires task ownership (`runtime/agent.ts:928-932`).
  - `approve()` for others' tasks is reachable only from the admin/Studio API (`server/admin.ts:618`, `:1233`).
  - Tasks are already workspace-scoped (`agent.ts:548`, `:1856-1859`).

**Owner and boundary: FeltKit.** An authenticated, app-facing approve/reject route and client method for **proposals in the caller's current workspace**.
- It reuses `approve()`'s existing rules unchanged: the approver is a person who may perform the action, and the action runs as the proposer.
- Hooks or React components for listing the pending proposals.

**Owner decisions needed**
- Which permission lets a member *see* a workspace's pending proposals, e.g. `feltkit.agent.write` plus the action's own permission.
- Whether rejection needs the same permission.
- Interaction with GAP-12 (people's tokens over MCP).

**Dependencies:** B1. LA-G02 (closed) is the basis.

**TaskFlow workaround to remove:** none. TaskFlow has no approvals screen; this unlocks one.

**Acceptance**
1. Over HTTP with a workspace session:
   - the owner approves the agent's `issues.delete` proposal, and it runs as the agent;
   - a member without `issues.delete` is refused, and the action stays `proposed`;
   - the agent itself is refused.
2. A member of another workspace gets `NOT_FOUND` for the task.
3. Approving the deletion of an issue the agent cannot delete fails at execution under the agent's authority. This is TaskFlow's existing assertion, now over HTTP.
4. The activity entry carries `authority.approval.approvedBy`.

### Rank 5: TF-GAP-10, effects staged that the caller cannot perform (P2)

**Evidence**
- **Found by** TaskFlow's notification test; workspace roles lacked `notifications.send`.
- **Source:** `afterCommit.add()` refuses only anonymous callers and disabled services (`runtime/transactions.ts:236-252`). There is no permission check at staging. The effect later fails "as the caller" in the outbox.

**Owner and boundary: FeltKit, in the same function as TA-1.** At staging, check that the caller's resolved permissions cover the effect's service permission (`notifications.send`, `webhooks.emit`, `jobs.enqueue`), using the policy every call already uses. Refuse with a hint that names the permission and the role.

This is a behaviour change: mutations that today commit and silently lose the effect would fail. Owner decision: refuse (fail closed, consistent with TA-1), or warn at load and in readiness. A documentation note alone does not resolve it.

**Dependencies:** B1.

**TaskFlow workaround to remove:** none. `notifications.send` in `feltkit/app.ts:15` is a real permission and stays; the outbox assertion `tests/collab.test.ts:50` stays as a regression.

**Acceptance**
1. With a role lacking `notifications.send`, a mutation staging a notification is refused (or, under the alternative, flagged by readiness), and nothing is committed.
2. With the permission, the mutation is unchanged.
3. No new failed outbox records.
4. TA-1's anonymous refusal is unchanged.

### Rank 6: TF-GAP-12, delegation (P2)

**Evidence**
- **Published:** `ctx.authority.decide({ capability, onBehalfOf })` (`@feltdb/feltkit` 0.3.29 `dist/runtime/context.d.ts:94`, `:177-206`; GUARANTEES.md:565).
- **Unpublished:** `ctx.authority.grants.{grant,list,revoke}` and `authority: { local: true }` (feltkit main `docs/LOCAL-AUTHORITY.md`, #121, merged after the 0.3.29 publish). They require `@authboundry/local`, which returns `npm view` 404.
- **AuthBoundry 6B-#3** (unified register P0: delegator taken from the request body) is fixed on authboundry main (`crates/server/src/control_routes.rs:5674-5682`). Whether that is in published `@authboundry/core` 1.17.3 is **unverified**.
- **AppPort** `docs/architecture/delegated-authority-requirement.md`: "design proposal; not implemented".

**Owner and boundary: no new design work is proposed.** Release work, in order:
1. AuthBoundry: confirm or release the 6B-#3 fix.
2. AuthBoundry: publish `@authboundry/local`.
3. FeltKit: publish 0.3.30 (after B1).
4. TaskFlow, a later and separate change: evaluate `ctx.authority` for "an agent acts for Ada".

**Dependencies:** B1, B2, B3.

**TaskFlow workaround to remove:** none.

**Acceptance** (on published packages)
1. Ada grants `issues.create` to the TaskFlow executor.
2. `decide({ capability: "issues.create", onBehalfOf: "user:ada" })` is allowed.
3. After `revoke`, it is refused on the next call.
4. A grant naming another person as delegator is refused.
5. A person without the capability cannot delegate it.
6. Every decision is recorded with `onBehalfOf`.

### Rank 7: TF-GAP-04, query expressiveness (P2)

**Evidence**
- **TaskFlow:** `feltkit/issues.ts:72-127` (in-memory filter and sort after one pushed equality) and `:147-156` (search post-filter).
- **Measured:** 30 ms for 1,200 issues, with the completeness oracle in `tests/work.test.ts`.
- **Source:** see §2. The published FeltDB server path has `in` and the rest; the embedded engine and FeltKit's `WhereClause` do not.

**Owner and boundary, in order:**
1. **FeltDB:** the embedded runtime evaluates the same operators as `CanonicalQuery` (at least `in` and `contains` on arrays), with index use where an equality or `in` index applies.
2. **FeltKit:** `ctx.db.query`/`find` accept them, keep the tenant predicate, include them in commit read fences, and produce live-query invalidation keys for them (GUARANTEES "Invalidation by predicate").

Text indexing is F23 and is tracked there; it is not duplicated here.

**Dependencies:** FeltDB release, then FeltKit. Separately, B1.

**TaskFlow workaround to remove:** about 61 LOC reducible, not deleted outright.
- `issues.ts:72-127` (53 LOC) keeps the sort and paging but loses most filtering.
- `:147-156` (8 LOC) remains until F23.

**Acceptance**
1. Embedded and server runtimes return identical results for an `in`/`contains`/`and`/`or` query matrix over 10,000 records.
2. Results are complete across cursor pages.
3. A FeltKit mutation that read with `in` gets `CONFLICT` when a newly matching record commits concurrently.
4. A live query with `in` re-runs on a matching insert.
5. TaskFlow's filter oracle (`tests/work.test.ts`) passes after `issues:list` pushes its filters down.

### Rank 8: TF-GAP-09, the policy hook cannot read service records (P3)

**Evidence**
- `AuthorizeRequest` has `db` only (`packages/sdk/src/authorize.ts`; no `services` reference on main).
- TaskFlow checks attachment ownership in the handler (`feltkit/attachments.ts:63-65`).

**Owner and boundary: FeltKit.** Options for the owner:
- **(a)** a read-only services view in `AuthorizeRequest`, which must stay fenced and evidence-free;
- **(b)** files that declare their owning resource, so the hook sees a database record.

Not chosen here.

**TaskFlow workaround to remove:** 3 LOC, moved into `_policy.ts`.

**Acceptance:** a rule "uploader or admin" expressed in the hook refuses a non-uploader with `FORBIDDEN` on every interface. TaskFlow's attachments test passes with the handler check removed.

### Ranks 9–11: TF-GAP-07, -06, -08, documentation (P3)

Behaviour is already correct; only the text is wrong.

| ID | Correct this | Precisely to |
|---|---|---|
| TF-GAP-07 | `docs/GUARANTEES.md:349` | Agent actions carry the task's workspace (LA-G02). **Schedules' jobs** still carry none (LA-G01 residual), so the statement must remain for schedules. |
| TF-GAP-06 | `docs/GUARANTEES.md:330` | Files belong to the workspace they were uploaded in (LA-G04). Files uploaded before carry none and are hidden from every workspace. |
| TF-GAP-08 | `docs/UPSTREAM-GAPS.md` A9 | Closed: `@appport/authorization` 1.1.1 `DenialCode` includes `NOT_FOUND` (published types). FeltKit #62 (FK-GAP-018). |

**Owner:** FeltKit docs; the unified register should record the closures.

**Acceptance:** each documented sentence is backed by a named test. Existing: `tenant-platform.test.ts` G-02 and G-04 (per the unified register), and TaskFlow `tests/agents.test.ts`, `platform-probes` "files". TaskFlow's probe "files: scoped per workspace" keeps asserting the behaviour.

### Rank 12: TF-GAP-13, `isFunctionDefinition` not exported (P3)

**Evidence:** declared in `dist/app.d.ts`; absent from `packages/sdk/src/index.ts` on main.

**Owner:** FeltKit. Export it, or document the supported way to enumerate an app's functions; owner decision.

**TaskFlow workaround to remove:** the structural check in `tests/foundation.test.ts` (2 LOC).

**Acceptance:** `import { isFunctionDefinition } from "@feltdb/feltkit"` works, and TaskFlow's policy-coverage test passes using it.

### Rank 13: TF-GAP-14, invitation link in an open tab (P3)

**Evidence:** `react/auth.tsx:175-199`, "read once, cleared for all". Observed in Chromium (not an automated test).

**Owner:** FeltKit React. Owner decision: keep (document it), or also react to `hashchange` for `feltkit-*` parameters.

**Acceptance (if changed):** a browser test opens `/#feltkit-invitation=…` in a loaded tab and sees `AcceptInvitation` without a reload.

### Rank 14: TF-GAP-11, groups inside a workspace (no remediation proposed)

**Evidence:**
- TaskFlow `feltkit/_policy.ts:110-166`: 50 LOC resolving arguments to records, records to teams, then team membership.
- multiplayer `feltkit/_authz.ts:63-103`: the same shape for channels.

**Disposition:** application-specific today. Two applications are recorded here as evidence for a possible FeltKit primitive. Owner decision whether to design one.

**Acceptance (if built):** TaskFlow's private-team, guest and lead tests pass with the resolver replaced.

## 5. Dependencies and sequencing

```
B1 feltkit #125 (main compiles) ──┬─► TF-GAP-02 ─┐
                                  ├─► TF-GAP-01 ─┤ (both need AppBoundry host parity check)
                                  ├─► notifications-pagination ─► TF-GAP-05
                                  ├─► TF-GAP-03
                                  ├─► TF-GAP-10
                                  ├─► TF-GAP-09, -13, docs (-06, -07, -08)
                                  └─► publish 0.3.30 ─┐
AuthBoundry: confirm 6B-#3 release, publish @authboundry/local ─┴─► TF-GAP-12 acceptance
FeltDB: embedded operator parity ─► FeltKit ctx.db exposure ─► TF-GAP-04
```

| Phase | Work | Gate to the next phase |
|---|---|---|
| 0 | B1: merge feltkit #125 | feltkit `packages/sdk` typechecks and the SDK suite is green |
| 1 (P0) | TF-GAP-02, TF-GAP-01 in FeltKit; AppBoundry parity check | Inverted probes pass on Node and artifact; TaskFlow 25/25 with workarounds removed |
| 2 (P1) | Land notifications-pagination, then TF-GAP-05; TF-GAP-03 | Acceptance in §4; owner decisions on approval visibility and pre-existing notifications |
| 3 (P2) | TF-GAP-10; release B2/B3 and verify TF-GAP-12; FeltDB parity then TF-GAP-04 | Each acceptance in §4 |
| 4 (P3) | Docs (-06, -07, -08), TF-GAP-13, TF-GAP-09, TF-GAP-14 decision | Text backed by named tests |

Phases 1–4 inside FeltKit are independent of each other apart from shared files: `services.ts` for -05 and pagination, `transactions.ts` for -10 and TA-1. They can run in parallel if those overlaps are coordinated.

## 6. Baseline: TaskFlow custom code attributable to these findings

Measured at `5a56f47`, counting non-blank, non-comment lines in the cited ranges. `feltkit measure` reports 0 infrastructure lines; these sit inside domain code.

| Finding | Location | LOC | Removed after fix |
|---|---|--:|---|
| TF-GAP-01 | `feltkit/teams.ts:41` | 1 | Yes (replaced by `unique`) |
| TF-GAP-02 | `feltkit/_domain.ts:83-84`, `:87-88`, `:97-98` | 6 | Yes |
| TF-GAP-05 | `feltkit/_domain.ts:129`, `:137`; `feltkit/inbox.ts:13-16`, `:33-35` | 9 | Yes |
| TF-GAP-09 | `feltkit/attachments.ts:63-65` | 3 | Moved to the policy |
| **Gap workarounds, production** | | **19** | |
| TF-GAP-13 | `tests/foundation.test.ts` (structural `isFunction`) | 2 (test) | Yes |
| TF-GAP-04 | `feltkit/issues.ts:72-127`, `:147-156` | 61 | Reduced, not removed |
| TF-GAP-11 | `feltkit/_policy.ts:110-166` | 50 | Only if a primitive ships |
| TF-GAP-03, -10, -12 | — | 0 | Nothing to remove (missing features or kept permissions) |

## 7. Blockers

| ID | Blocker | Blocks | Evidence |
|---|---|---|---|
| B1 | feltkit `main` does not compile: `src/runtime/runtime.ts(694,29): error TS1005`, and more after it | Every FeltKit remediation and the 0.3.30 release | `tsc -p packages/sdk/tsconfig.json --noEmit` at `6c823b1`. Fix proposed in open PR #125 (not reviewed here) |
| B2 | `@authboundry/local` is not published (npm 404) | TF-GAP-12 (local authority and grants) | `npm view @authboundry/local` |
| B3 | Unknown whether the AuthBoundry 6B-#3 fix is in published 1.17.3 | TF-GAP-12 on hosted AuthBoundry | Shallow clone; release contents not compared |
| B4 | Owner decisions in §4 (approval visibility, refuse vs warn on effects, the `unique` approach, pre-existing cross-tenant references and notifications, groups primitive, redirect behaviour) | The corresponding implementations | — |

## 8. Unverified claims and reproduction code

**Unverified:**
- Whether AppBoundry's guest/host enforces `unique` or `s.ref` within the tenant. TF-GAP-01/02 were reproduced on FeltKit's Node runtime only.
- Whether any deployed application already holds cross-tenant references or relies on global `unique` on a tenant collection.
- Whether development Studio's approve screen supplies the approver's workspace role for tenant apps. Approval succeeded only when the approver was passed as their workspace session resolves them.
- The contents of `claude/notifications-pagination` beyond its services diff; it was not run.
- FeltDB embedded-engine performance for `in` at scale; no implementation exists to measure.
- Whether FeltDB could enforce same-tenant references natively (composite references); not investigated. The plan places the check in FeltKit.
- Multiplayer's affected surface for TF-GAP-02/05 is inferred from its declarations, not reproduced.

**P-1** (TF-GAP-01 safe path, run in scratch, FeltKit 0.3.29). Result: other workspace `ok`, same workspace `CONFLICT`.

```ts
// feltkit/app.ts (probe)
export const teams = app.collection("teams", { workspaceId: s.string(), key: s.string() },
  { tenant: { field: "workspaceId" }, unique: [["workspaceId", "key"]] });
// feltkit/p.ts
export const add = app.mutation({ access: "x.write", args: { key: s.string() },
  handler: (ctx, { key }) => ctx.db.insert(teams, { key, workspaceId: ctx.auth.tenant!.id }) });
// test: A adds "ENG"; B adds "ENG" → ok; A adds "ENG" again → CONFLICT
```

**Re-running the evidence**

From the TaskFlow repository:

```bash
npm test
```

```bash
npm run test:probes
```

From a clone of `rkendel1/feltkit` (shows B1):

```bash
cd packages/sdk && npx tsc -p tsconfig.json --noEmit
```

## 9. Out of scope, by instruction

- No issues filed, PRs opened, merges or releases.
- No platform repository or TaskFlow application code changed.
- The unified platform register (`feltkit/docs/platform/GAP-REGISTER.md`) should absorb these as `TF-` entries. That is a change to the platform repository and is left for its owner.
