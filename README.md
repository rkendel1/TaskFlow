# TaskFlow

Issue tracking for teams on [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit): workspaces, teams, projects,
milestones, cycles, issues with relations and sub-issues, comments with mentions, attachments, an inbox, list and
board views, and agents that work through the same functions and permissions as people.

It is also a test of whether FeltKit can carry a different class of application without platform changes.
- **Design:** [docs/DESIGN.md](docs/DESIGN.md).
- **Platform gaps:** [docs/GAP-REGISTER.md](docs/GAP-REGISTER.md).
- **Results:** [docs/REPORT.md](docs/REPORT.md).

## Run it

```bash
npm install
```

```bash
npm run dev
```

1. Open the printed App URL. In development you are signed in as Ada.
2. Create a workspace.
3. Open **Settings**, then **Load demo data**: 3 teams, projects, cycles and 360 issues.
4. Switch people from the corner selector (Grace, Linus, Mallory). Invite them from **Settings → Workspace** and accept as them to see collaboration live.

Keyboard: `C` new issue · `⌘K` or `/` search · `j`/`k` move · `Esc` close.

## Test it

```bash
npm test
```

```bash
npm run test:probes
```

```bash
npm run typecheck
```

```bash
npm run measure
```

- `npm test`: 32 tests. Isolation, permissions, lifecycle, 900-issue workspaces, concurrency, notifications, live updates over HTTP, attachments, agents over MCP and AppPort, restart.
- `npm run test:probes`: reproductions of the platform gaps.
- `npm run measure`: what the repository is made of.

## Capture and the assistant

- **Capture** (sidebar → Capture): file an issue from a page, a selection or a share sheet. Drag the
  "Capture to TaskFlow" bookmarklet to your bookmarks bar and click it on any page. Built on FeltKit
  surfaces and invocations: each capture is durable, a retry is a replay, and you can cancel one
  before it runs.
- **Assistant:**
  1. A workspace admin adds it (Settings → Assistant).
  2. You allow it to file issues for you, for 1–90 days.
  3. Comment `@assistant follow up: <title>` on any issue, and it files a sub-issue for you.

  It acts as itself, only for people who allowed it, and within its own role and teams. Each decision
  comes from a private AuthBoundry (`@authboundry/local`) and is recorded in the issue's history.

## Agents

Ten functions are AppPort capabilities and MCP tools:
- `issues.search`, `issues.get`, `issues.create`, `issues.update`, `issues.assign`, `issues.setstatus`;
- `issues.delete` (proposal only for agents);
- `issues.attention`, `comments.add`, `projects.summary`.

An agent gets a session from an operator:

```bash
npx feltkit session create --type agent --id triage-bot --role agent
```

A workspace manager adds it to the workspace with the `agent` role. It then calls `/mcp` with exactly that authority.
Removing it from the workspace, or revoking its session, stops its next call.

## Layout

| Path | What |
|---|---|
| `feltkit/app.ts` | roles, tenancy, services, collections |
| `feltkit/_policy.ts` | the one resource policy (every function registered; default deny) |
| `feltkit/_domain.ts` | shared domain rules |
| `feltkit/*.ts` | functions: workspace, teams, labels, projects, cycles, issues, comments, attachments, inbox, seed |
| `src/` | React UI |
| `tests/` | acceptance tests |
| `platform-probes/` | a minimal app that reproduces FeltKit gaps |
