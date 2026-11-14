/**
 * Agents operate TaskFlow through FeltKit's real transports (MCP at /mcp, AppPort at /appport,
 * the HTTP function API) with an operator-issued agent session. Same functions, same roles, same
 * resource policy as people. No agent-only backend exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { BOT, makeTeam, refused, world } from "./helpers.js";

async function harness() {
  const w = await world();
  const { startServer } = await import("@feltdb/feltkit/server");
  const { createClient } = await import("@feltdb/feltkit/client");
  const server = await startServer({ runtime: w.t.runtime as never, projectDir: process.cwd(), port: 0, host: "127.0.0.1", dashboard: { enabled: false, adminToken: "", dir: null } } as never);
  /** What `feltkit session create --type agent --id triage-bot` issues, working in a workspace. */
  const agentSession = (tenantId: string) => w.t.runtime.issueSession({ id: BOT.id, type: "agent", displayName: BOT.displayName, roles: [] }, { kind: "cli", via: "cli" as never, tenantId });
  let rpc = 0;
  const mcp = async (token: string, method: string, params?: unknown) => {
    const r = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, ...(params ? { params } : {}) }) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  /** A tool call: { ok, value } or { ok: false, code }. */
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp(token, "tools/call", { name, arguments: args });
    if (r.status !== 200) return { ok: false as const, code: `HTTP_${r.status}`, value: null };
    const result = r.body?.result;
    if (result?.isError) return { ok: false as const, code: result._meta?.["dev.appport/error"]?.code as string, value: result };
    const text = result.content?.[0]?.text;
    let value: any;
    try { value = JSON.parse(text); } catch { value = result.structuredContent ?? text; }
    return { ok: true as const, code: null, value };
  };
  const appport = async (token: string, capability: string, input: unknown, idempotencyKey?: string) => {
    const r = await fetch(`${server.url}/appport`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `r-${++rpc}`, capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }) });
    return (await r.json()) as any;
  };
  const bearerClient = (token: string) => createClient({ url: server.url, session: "bearer", tokens: { get: () => token, set: () => undefined } } as never);
  const personClient = async (id: string, workspace: string) => {
    let token: string | null = null;
    const c = createClient({ url: server.url, tokens: { get: () => token, set: (v: string | null) => { token = v; } } } as never);
    await c.signInAsDevUser(id);
    await c.switchTenant(workspace);
    return c;
  };
  return { w, server, agentSession, mcp, tool, appport, bearerClient, personClient, close: async () => { await server.close(); await w.t.close(); } };
}

test("an authorized agent does useful work over MCP, with the same rules and evidence as people", async () => {
  const h = await harness();
  const { w } = h;
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const projectId = await ada.mutation(api.projects.create, { teamId, name: "Launch" });
    const old = (await ada.mutation(api.issues.create, { teamId, title: "Login loop on Safari", dueDate: "2026-01-01", projectId })).id;
    const { token } = await h.agentSession(w.acme);

    // Discovery: every published capability, with what this agent may do and how.
    const context = (await h.tool(token, "feltkit_context")).value;
    const mine = Object.fromEntries(context.tools.filter((t: any) => t.source !== "services").map((t: any) => [t.name, `${t.allowed}/${t.invoke}`]));
    assert.deepEqual(mine, {
      "comments.add": "true/direct", "issues.assign": "true/direct", "issues.attention": "true/direct", "issues.create": "true/direct",
      "issues.delete": "true/propose", "issues.get": "true/direct", "issues.search": "true/direct", "issues.setstatus": "true/direct",
      "issues.update": "true/direct", "projects.summary": "true/direct",
    });

    const found = await h.tool(token, "issues_search", { text: "safari" });
    assert.deepEqual(found.value.map((i: any) => i.key), ["ENG-1"]);
    const filed = await h.tool(token, "issues_create", { teamId, title: "Investigate Safari cookie policy", priority: 2, type: "bug", projectId });
    assert.equal(filed.value.key, "ENG-2");
    assert.ok((await h.tool(token, "issues_update", { issueId: filed.value.id, parentId: old, estimate: 3 })).ok);
    assert.ok((await h.tool(token, "issues_assign", { issueId: old, assigneeId: "grace" })).ok);
    assert.equal((await h.tool(token, "issues_setstatus", { issueId: old, status: "In Progress" })).value.category, "started");
    assert.ok((await h.tool(token, "comments_add", { issueId: old, body: "Linked ENG-2. @[Grace](grace) over to you." })).ok);
    const attention = (await h.tool(token, "issues_attention", { today: "2026-11-14" })).value;
    assert.deepEqual(attention.overdue.map((i: any) => i.key), ["ENG-1"]);
    const summary = (await h.tool(token, "projects_summary", { projectId })).value;
    assert.equal(summary.progress.total, 2);
    const detail = (await h.tool(token, "issues_get", { issueId: old })).value;
    assert.deepEqual(detail.children.map((c: any) => c.key), ["ENG-2"]);

    // Evidence: the business history names the agent; FeltKit's activity log names the transport,
    // principal and authorization decision for every call.
    const agentEntries = detail.history.filter((x: any) => x.actor === BOT.id);
    assert.deepEqual([...new Set(agentEntries.map((x: any) => x.actorType))], ["agent"]);
    assert.deepEqual(agentEntries.map((x: any) => x.type), ["issue.assigned", "issue.status_changed", "comment.added"]);
    const created = (await w.t.runtime.activity.list({ name: "issues:create", limit: 10 })).find((e: any) => e.principal?.id === BOT.id) as any;
    assert.equal(created.outcome, "success");
    assert.ok(JSON.stringify(created).includes("mcp"), "the activity entry records the MCP transport");
    assert.ok(JSON.stringify(created).match(/dec_/), "and an authorization decision id");
    // Grace was notified by the agent's assignment and mention, like any other actor's.
    await w.t.runtime.runServices();
    const inbox = await w.as("grace", w.acme).query(api.inbox.list, {});
    assert.deepEqual(inbox.map((n) => n.type).sort(), ["issue.assigned", "issue.mentioned", "issue.status"]); // she is the assignee by the time it moves
    assert.ok(inbox.every((n) => n.data.actor === BOT.id));
  } finally {
    await h.close();
  }
});

test("an agent cannot exceed its role or its workspace on any interface", async () => {
  const h = await harness();
  const { w } = h;
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const secret = await makeTeam(w, w.acme, "ada", "SEC", { private: true });
    const hidden = (await w.as("ada", w.acme).mutation(api.issues.create, { teamId: secret.teamId, title: "Board minutes" })).id;
    const victim = (await w.as("ada", w.acme).mutation(api.issues.create, { teamId, title: "Keep me" })).id;
    const glb = await makeTeam(w, w.globex, "mallory", "GLB");
    const globexIssue = (await w.as("mallory", w.globex).mutation(api.issues.create, { teamId: glb.teamId, title: "Globex" })).id;
    const { token } = await h.agentSession(w.acme);

    // Mandatory approval: discoverable and allowed by role, but never direct.
    const del = await h.tool(token, "issues_delete", { issueId: victim });
    assert.equal(del.code, "FORBIDDEN");
    assert.equal(del.value._meta["dev.appport/error"].details.approval, "required");
    const viaAppPort = await h.appport(token, "issues.delete", { issueId: victim });
    assert.equal(viaAppPort.ok, false);
    assert.equal(viaAppPort.error.code, "FORBIDDEN");
    // Functions that are not capabilities are still functions: the role decides, on HTTP too.
    const http = h.bearerClient(token);
    await refused(http.mutation(api.teams.update, { teamId, name: "renamed by bot" }), "FORBIDDEN");
    await refused(http.mutation(api.workspace.updateSettings, { estimates: "none" }), "FORBIDDEN");
    await refused(http.mutation(api.issues.remove, { issueId: victim }), "FORBIDDEN");
    await refused(http.mutation(api.seed.demo, {}), "FORBIDDEN");
    // Private team: does not exist for the agent.
    assert.equal((await h.tool(token, "issues_get", { issueId: hidden })).code, "NOT_FOUND");
    assert.equal((await h.tool(token, "issues_search", { text: "minutes" })).value.length, 0);
    // Another workspace: its records do not exist here, and the agent cannot work there at all.
    assert.equal((await h.tool(token, "issues_get", { issueId: globexIssue })).code, "NOT_FOUND");
    assert.equal((await h.tool(token, "issues_update", { issueId: globexIssue, title: "x" })).code, "NOT_FOUND");
    let globexToken: string | null = null;
    try {
      globexToken = (await h.agentSession(w.globex)).token;
    } catch {
      globexToken = null; // refused at issue: equally acceptable
    }
    if (globexToken) assert.notEqual((await h.tool(globexToken, "issues_search", { text: "globex" })).ok, true, "not a member of Globex");
    assert.equal((await w.as("ada", w.acme).query(api.issues.get, { issueId: victim })).title, "Keep me");
  } finally {
    await h.close();
  }
});

test("approval: a person approves an agent's proposal, and it runs with the agent's own authority", async () => {
  const h = await harness();
  const { w } = h;
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const session = await h.agentSession(w.acme);
    const agent = session.principal;
    const own = (await h.tool(session.token, "issues_create", { teamId, title: "Duplicate of ENG-1" })).value.id;
    const adas = (await w.as("ada", w.acme).mutation(api.issues.create, { teamId, title: "Ada's issue" })).id;
    const ada = (await (await h.personClient("ada", w.acme)).session()).principal as never;
    const grace = (await (await h.personClient("grace", w.acme)).session()).principal as never;
    const runtime = w.t.runtime;

    const task = (await runtime.agent.createTask({ objective: "Clean up duplicates", principal: agent })) as any;
    const taskId = task.task.task_id as string;
    const propose = async (issueId: string) => ((await runtime.agent.propose(taskId, { capability: "issues.delete", input: { issueId }, reason: "duplicate" } as never, agent)) as any).pending.at(-1).actionId as string;

    // 1. Deleting its own issue: neither the agent nor a member without issues.delete may approve.
    const a1 = await propose(own);
    await refused(runtime.agent.approve(taskId, a1, agent), "FORBIDDEN");
    await refused(runtime.agent.approve(taskId, a1, grace), "FORBIDDEN");
    assert.equal((await w.as("ada", w.acme).query(api.issues.get, { issueId: own })).title, "Duplicate of ENG-1", "nothing ran");
    const done = (await runtime.agent.approve(taskId, a1, ada)) as any;
    assert.equal(done.actions.find((a: any) => a.actionId === a1).state, "succeeded");
    await refused(w.as("ada", w.acme).query(api.issues.get, { issueId: own }), "NOT_FOUND");
    const ran = (await runtime.activity.list({ name: "issues:remove", limit: 20 })).find((e: any) => e.outcome === "success") as any;
    assert.equal(ran.principal.id, BOT.id, "it ran as the proposer");
    assert.equal(ran.authority.approval.approvedBy, "user:ada");

    // 2. Deleting Ada's issue: the owner approves, but the agent is neither its creator nor an admin,
    //    so the policy refuses it at execution. Approval never widens the proposer's authority.
    const a2 = await propose(adas);
    const after = (await runtime.agent.approve(taskId, a2, ada)) as any;
    const action = after.actions.find((a: any) => a.actionId === a2);
    assert.equal(action.state, "failed");
    assert.equal(action.outcome.error.code, "FORBIDDEN");
    assert.equal((await w.as("ada", w.acme).query(api.issues.get, { issueId: adas })).title, "Ada's issue");
  } finally {
    await h.close();
  }
});

test("idempotent retries over AppPort: the same key runs once; a different request under it is refused", async () => {
  const h = await harness();
  const { w } = h;
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const { token } = await h.agentSession(w.acme);
    const first = await h.appport(token, "issues.create", { teamId, title: "Nightly backup failed" }, "alert-7731");
    const retry = await h.appport(token, "issues.create", { teamId, title: "Nightly backup failed" }, "alert-7731");
    assert.equal(first.ok, true);
    assert.deepEqual(retry.output, first.output, "the retry returns the first outcome");
    assert.equal((await w.as("ada", w.acme).query(api.issues.list, {})).total, 1, "and created nothing");
    const reused = await h.appport(token, "issues.create", { teamId, title: "Something else" }, "alert-7731");
    assert.equal(reused.ok, false);
    assert.match(JSON.stringify(reused.error), /IDEMPOTENCY_KEY_REUSED|reuse/i);
  } finally {
    await h.close();
  }
});

test("revocation: removing the agent's membership, or its session, stops the very next call", async () => {
  const h = await harness();
  const { w } = h;
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const { token } = await h.agentSession(w.acme);
    assert.ok((await h.tool(token, "issues_create", { teamId, title: "before" })).ok);

    // A workspace manager removes the agent: its session is still valid, but it has no workspace authority.
    const owner = await w.t.tenancy!.context(w.acme, "ada");
    await w.t.tenancy!.remove({ ...owner!, principalId: "ada" }, BOT.id);
    const afterRemoval = await h.tool(token, "issues_create", { teamId, title: "after removal" });
    assert.equal(afterRemoval.ok, false);
    assert.ok(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED", "FAILED_PRECONDITION"].includes(afterRemoval.code!), afterRemoval.code!);

    // Re-added, it works again; then its session is revoked: 401 on the next request.
    await w.t.tenancy!.addPrincipal({ ...owner!, principalId: "ada" }, { id: BOT.id, type: "agent" }, "agent");
    const fresh = await h.agentSession(w.acme);
    assert.ok((await h.tool(fresh.token, "issues_search", { text: "before" })).ok);
    await w.t.runtime.sessions.revokePrincipal(BOT.id);
    assert.equal((await h.mcp(fresh.token, "tools/call", { name: "issues_search", arguments: { text: "before" } })).status, 401);
    assert.deepEqual((await w.as("ada", w.acme).query(api.issues.list, {})).items.map((i) => i.title), ["before"]);
  } finally {
    await h.close();
  }
});

