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

## Public demo deployment

This starter deploys as a public demo: visitors skip sign-in and land in the app, with demo data loaded. Every
FeltKit starter does it the same way, with FeltKit's own Fly.io deployment.

### Deploy the demo to Fly.io

```bash
npm run deploy:demo
```

```bash
npx feltkit fly deploy
```

`deploy:demo` builds and verifies FeltKit's normal Fly.io artifact (`npx feltkit deploy --target fly`, in
`.feltkit/deploy`), then `scripts/demo-artifact.mjs` changes only how the container starts. `npx feltkit fly deploy`
deploys it exactly as it would a production build: it creates the Fly app and its volume the first time.

- The demo is its own Fly app, **`taskflow-demo`** (https://taskflow-demo.fly.dev), never the production app `taskflow`. To
  name it differently, set `"feltkitDemo": { "flyApp": "<name>" }` in `package.json` (or `DEMO_FLY_APP`).
- The container runs `scripts/demo-server.mjs`: the app in FeltKit's **development** environment, so its dev users
  are offered and the app signs each visitor in as the first one. Once the server is up it loads the demo data
  through the app's own functions (`scripts/demo-seed.ts`: the *Acme* workspace with Ada, Grace, Linus and Mallory, and 360 issues). Data and FeltKit's development files are on the Fly volume, so a redeploy
  keeps them and loads nothing twice.
- To publish a change, run both commands again.

Try the same thing locally:

```bash
npm run build
```

```bash
npm run start:demo
```

| Variable | Effect |
|---|---|
| `PORT` / `HOST` | where it listens (default: FeltKit's port from 3000, `0.0.0.0`) |
| `FELTKIT_STATE_DIR` | where the demo data lives (the Fly image sets `/data/state`) |
| `DEMO_SEED=0` | serve without loading demo data |

**Demo only.** Every visitor acts as a dev user, with that user's roles (including admin and operator roles), on
one shared copy of the data, and development mode relaxes production safeguards. Never give a demo deployment real
provider keys, credentials or customer data. For production, use `npx feltkit deploy --target fly` without
`scripts/demo-artifact.mjs`.

### Make your own FeltKit app a demo

The same four pieces work in any FeltKit app:

1. **Dev users** are who visitors become. Declare them in `feltkit/app.ts`; the first is the default, so give it
   the roles a visitor should have. FeltKit offers them only in development, never in production.

   ```ts
   dev: { users: [{ id: "ada", name: "Ada Lovelace", roles: ["admin"] }, { id: "grace", name: "Grace Hopper", roles: ["member"] }] },
   ```

2. **Sign visitors in.** Before the app shows its sign-in screen, sign in as the first dev user when the server
   offers dev users. In production the list is empty, so this does nothing there.

   ```tsx
   import { useEffect, useRef } from "react";
   import { useSession } from "@feltdb/feltkit/react";

   export function useDevSignIn() {
     const { session, signInAsDevUser } = useSession();
     const tried = useRef(false);
     useEffect(() => {
       if (session && !session.principal && session.devUsers.length && !tried.current) {
         tried.current = true;
         void signInAsDevUser(session.devUsers[0]!.id);
       }
     }, [session, signInAsDevUser]);
   }
   ```

   TaskFlow does this in `src/App.tsx`.

3. **Demo data** in `scripts/demo-seed.ts`: sign in as a dev user and call your app's own functions over HTTP, the
   way a person would. Make each step safe to repeat; it runs on every start. In a multi-tenant app, create the
   tenant for the dev user visitors become (`scripts/demo-seed.ts` here creates Ada's workspace and invites the other dev users).

   ```ts
   import { createClient } from "@feltdb/feltkit/client";
   import { api } from "../feltkit/_generated/api.js";

   let token: string | null = null;
   const ada = createClient({ url: process.argv[2], session: "bearer", tokens: { get: () => token, set: (t) => void (token = t) }, context: false });
   await ada.signInAsDevUser("ada");
   // Your app's own seed function, which refuses once its data is there.
   await ada.mutation(api.demo.seed, {}).catch((e) => { if (e.code !== "FAILED_PRECONDITION") throw e; });
   ```

4. **The launcher and the Fly step**: copy `scripts/demo-server.mjs` and `scripts/demo-artifact.mjs` from this
   repository unchanged (every starter has the same files), and add the scripts:

   ```json
   "start:demo": "node scripts/demo-server.mjs",
   "deploy:demo": "feltkit deploy --target fly && node scripts/demo-artifact.mjs"
   ```

   If the seed needs other files at runtime, list them: `"feltkitDemo": { "include": ["scripts/seed.ts"] }`.

Then deploy as above: `npm run deploy:demo`, then `npx feltkit fly deploy`.
