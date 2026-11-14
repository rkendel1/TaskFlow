/**
 * Collaboration: notifications across people and workspaces, live updates over FeltKit's real
 * HTTP change stream, and membership changes taking effect on the next call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { makeTeam, refused, world, type World } from "./helpers.js";

/** Let the after-commit outbox perform staged notifications. */
async function settle(w: World) {
  await w.t.runtime.runServices();
}

test("notifications reach the right people, never the actor, and stay in their workspace", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const grace = w.as("grace", w.acme);
    const { id, key } = await ada.mutation(api.issues.create, { teamId, title: "Payments timeout", assigneeId: "grace" });
    await settle(w);
    let inbox = await grace.query(api.inbox.list, {});
    assert.deepEqual(inbox.map((n) => [n.type, n.data.issueKey]), [["issue.assigned", key]]);
    assert.deepEqual(await ada.query(api.inbox.list, {}), [], "the actor is not notified of their own change");

    await grace.mutation(api.comments.add, { issueId: id, body: "@[Ada](ada) can you look at the retry budget? @[Mallory](mallory)" });
    await grace.mutation(api.issues.setStatus, { issueId: id, status: "completed" });
    await settle(w);
    const adaInbox = await ada.query(api.inbox.list, {});
    assert.deepEqual(adaInbox.map((n) => n.type).sort(), ["issue.mentioned", "issue.status"]);
    // Mallory is not in Acme: a mention of her is dropped, and nothing reaches her.
    assert.deepEqual(await w.as("mallory", w.globex).query(api.inbox.list, {}), []);

    // Grace is in both workspaces: in Globex her inbox shows Globex only.
    const glb = await makeTeam(w, w.globex, "mallory", "GLB");
    await w.as("mallory", w.globex).mutation(api.issues.create, { teamId: glb.teamId, title: "Globex task", assigneeId: "grace" });
    await settle(w);
    assert.deepEqual((await w.as("grace", w.globex).query(api.inbox.list, {})).map((n) => n.title), ["GLB-1 was assigned to you: Globex task"]);
    inbox = await grace.query(api.inbox.list, {});
    assert.ok(inbox.every((n) => n.data.workspaceId === w.acme));

    // Each person marks only their own (AppPort Services enforces recipient-only access).
    await refused(grace.mutation(api.inbox.markRead, { id: adaInbox[0]!.id }), ["FORBIDDEN", "NOT_FOUND", "DENIED"]);
    await ada.mutation(api.inbox.markAllRead, {});
    assert.deepEqual(await ada.query(api.inbox.list, { unread: true }), []);
    assert.equal((await grace.query(api.inbox.list, { unread: true })).length, inbox.length, "Ada's read state is hers alone");
    // Effects run as the caller after commit; a role missing notifications.send fails them in the
    // outbox while the mutation still commits. None may have failed.
    assert.deepEqual((await w.t.runtime.listOutbox({ state: "failed" })).map((r) => (r as { error?: unknown }).error), []);
  } finally {
    await w.t.close();
  }
});

test("a mutation that fails sends no notification", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const { id } = await ada.mutation(api.issues.create, { teamId, title: "x" });
    // Assign to Grace and a bad state in one update: the state check fails after the assignee was staged.
    const other = await makeTeam(w, w.acme, "ada", "DES");
    await refused(ada.mutation(api.issues.update, { issueId: id, assigneeId: "grace", stateId: other.state("started") }), "INVALID_ARGUMENT");
    await settle(w);
    assert.deepEqual(await w.as("grace", w.acme).query(api.inbox.list, {}), []);
    assert.equal((await ada.query(api.issues.get, { issueId: id })).assigneeId, undefined);
  } finally {
    await w.t.close();
  }
});

test("live: a change by one person reaches another's open views over HTTP; other workspaces see nothing", async () => {
  const w = await world();
  const { startServer } = await import("@feltdb/feltkit/server");
  const { createClient } = await import("@feltdb/feltkit/client");
  const server = await startServer({ runtime: w.t.runtime as never, projectDir: process.cwd(), port: 0, host: "127.0.0.1", dashboard: { enabled: false, adminToken: "", dir: null } } as never);
  const signIn = async (id: string, workspace: string) => {
    let token: string | null = null;
    const client = createClient({ url: server.url, tokens: { get: () => token, set: (v: string | null) => { token = v; } } } as never);
    await client.signInAsDevUser(id);
    await client.switchTenant(workspace);
    return client;
  };
  const stops: Array<() => void> = [];
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const glb = await makeTeam(w, w.globex, "mallory", "GLB");
    const adaHttp = await signIn("ada", w.acme);
    const graceHttp = await signIn("grace", w.acme);
    const malloryHttp = await signIn("mallory", w.globex);

    const watch = <T,>(client: Awaited<ReturnType<typeof signIn>>, fn: unknown, args: unknown) => {
      const seen: T[] = [];
      let wake: (() => void) | null = null;
      const errors: unknown[] = [];
      stops.push(client.watchQuery(fn as typeof api.issues.list, args as never, { next: (d) => { seen.push(d as T); wake?.(); }, error: (e) => { errors.push(e); wake?.(); } }));
      const next = async (pred: (d: T) => boolean, ms = 5000): Promise<T> => {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = seen.find(pred);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(seen.at(-1))?.slice(0, 300)}; errors: ${errors.map(String)}`);
          await new Promise<void>((r) => { wake = r; setTimeout(r, 100); });
        }
      };
      return { seen, next };
    };

    type List = { total: number; items: Array<{ title: string; category: string }> };
    const graceBoard = watch<List>(graceHttp, api.issues.list, { teamId });
    const malloryList = watch<List>(malloryHttp, api.issues.list, { teamId: glb.teamId });
    await graceBoard.next((d) => d.total === 0);
    await malloryList.next((d) => d.total === 0);

    const t0 = Date.now();
    const { id } = await adaHttp.mutation(api.issues.create, { teamId, title: "Live one" });
    await graceBoard.next((d) => d.items.some((i) => i.title === "Live one"));
    const insertLatency = Date.now() - t0;
    await adaHttp.mutation(api.issues.setStatus, { issueId: id, status: "started" });
    await graceBoard.next((d) => d.items.some((i) => i.title === "Live one" && i.category === "started"));
    console.log(`live insert reached another client in ${insertLatency} ms`);

    // Mallory's view never contained Acme's issue.
    assert.ok(malloryList.seen.every((d) => d.items.every((i) => i.title !== "Live one")));
  } finally {
    for (const stop of stops) try { stop(); } catch {}
    await server.close();
    await w.t.close();
  }
});

test("removing someone from the workspace ends their access on the next call", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const grace = w.as("grace", w.acme);
    const { id } = await grace.mutation(api.issues.create, { teamId, title: "mine" });
    const owner = await w.t.tenancy!.context(w.acme, "ada");
    await w.t.tenancy!.remove({ ...owner!, principalId: "ada" }, "grace");
    await refused(grace.query(api.issues.get, { issueId: id }), ["FORBIDDEN", "NOT_FOUND"]);
    await refused(grace.mutation(api.issues.update, { issueId: id, title: "still mine?" }), ["FORBIDDEN", "NOT_FOUND"]);
    // Her work stays, attributed to her.
    const issue = await w.as("ada", w.acme).query(api.issues.get, { issueId: id });
    assert.equal(issue.creatorId, "grace");
    // And she can no longer be assigned.
    await refused(w.as("ada", w.acme).mutation(api.issues.assign, { issueId: id, assigneeId: "grace" }), "INVALID_ARGUMENT");
  } finally {
    await w.t.close();
  }
});
