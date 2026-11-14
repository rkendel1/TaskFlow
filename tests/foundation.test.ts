import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { api } from "../feltkit/_generated/api.js";
import { RULES } from "../feltkit/_policy.js";
import { makeTeam, refused, world } from "./helpers.js";

// `isFunctionDefinition` is declared in app.d.ts but not exported from "@feltdb/feltkit".
const isFunction = (v: unknown) => typeof v === "object" && v !== null && "handler" in v && "kind" in v && "access" in v;

test("every function has a resource rule, and every rule a function (default deny stays honest)", async () => {
  const names: string[] = [];
  for (const file of await readdir(new URL("../feltkit/", import.meta.url))) {
    if (!file.endsWith(".ts") || file.startsWith("_") || file === "app.ts") continue;
    const mod = await import(`../feltkit/${file}`);
    for (const [name, value] of Object.entries(mod)) if (isFunction(value)) names.push(`${file.slice(0, -3)}:${name}`);
  }
  assert.deepEqual(names.filter((n) => !RULES[n]), [], "functions without a rule");
  assert.deepEqual(Object.keys(RULES).filter((n) => !names.includes(n)), [], "rules without a function");
});

test("two workspaces are isolated: lists, gets, searches and writes", async () => {
  const w = await world();
  try {
    const eng = await makeTeam(w, w.acme, "ada", "ENG");
    const ops = await makeTeam(w, w.globex, "mallory", "ENG"); // same key, other workspace: allowed
    const { id } = await w.as("ada", w.acme).mutation(api.issues.create, { teamId: eng.teamId, title: "Acme secret roadmap" });
    await w.as("mallory", w.globex).mutation(api.issues.create, { teamId: ops.teamId, title: "Globex thing" });

    const mallory = w.as("mallory", w.globex);
    assert.deepEqual((await mallory.query(api.issues.list, {})).items.map((i) => i.title), ["Globex thing"]);
    assert.deepEqual(await mallory.query(api.issues.search, { text: "roadmap" }), []);
    await refused(mallory.query(api.issues.get, { issueId: id }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.update, { issueId: id, title: "pwned" }), "NOT_FOUND");
    await refused(mallory.mutation(api.comments.add, { issueId: id, body: "hi" }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.remove, { issueId: id }), "NOT_FOUND");
    // Grace is in both: in Globex she does not see Acme's issue.
    await refused(w.as("grace", w.globex).query(api.issues.get, { issueId: id }), "NOT_FOUND");
    assert.equal((await w.as("grace", w.acme).query(api.issues.get, { issueId: id })).title, "Acme secret roadmap");
    // A workspace is never an argument.
    await refused(mallory.mutation(api.teams.create, { key: "X", name: "x", workspaceId: w.acme } as never), ["FORBIDDEN", "INVALID_ARGUMENT"]);
    // No workspace chosen: nothing.
    await refused(w.t.as({ id: "grace", type: "user", roles: ["person"] }).query(api.issues.list, {}), "FORBIDDEN");
  } finally {
    await w.t.close();
  }
});

test("cross-workspace references are refused on every reference field", async () => {
  const w = await world();
  try {
    const acmeEng = await makeTeam(w, w.acme, "ada", "ENG");
    const globexEng = await makeTeam(w, w.globex, "mallory", "GLB");
    const mallory = w.as("mallory", w.globex);
    const ada = w.as("ada", w.acme);
    const acmeProject = await ada.mutation(api.projects.create, { teamId: acmeEng.teamId, name: "Acme P" });
    const acmeCycle = await ada.mutation(api.cycles.create, { teamId: acmeEng.teamId, startDate: "2026-11-01", endDate: "2026-11-14" });
    const acmeIssue = (await ada.mutation(api.issues.create, { teamId: acmeEng.teamId, title: "a" })).id;
    const mine = (await mallory.mutation(api.issues.create, { teamId: globexEng.teamId, title: "m" })).id;

    await refused(mallory.mutation(api.issues.create, { teamId: acmeEng.teamId, title: "x" }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.create, { teamId: globexEng.teamId, title: "x", projectId: acmeProject }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.update, { issueId: mine, cycleId: acmeCycle }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.update, { issueId: mine, parentId: acmeIssue }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.update, { issueId: mine, stateId: acmeEng.state("completed") }), "NOT_FOUND");
    await refused(mallory.mutation(api.issues.addRelation, { issueId: mine, blockedId: acmeIssue }), "NOT_FOUND");
    // Array references are checked by the handler through the tenant-scoped reader.
    const globexCycle = await mallory.mutation(api.cycles.create, { teamId: globexEng.teamId, startDate: "2026-11-01", endDate: "2026-11-14" });
    await refused(mallory.mutation(api.cycles.addIssues, { cycleId: globexCycle, issueIds: [acmeIssue] }), "NOT_FOUND");
    const acmeLabel = await ada.mutation(api.labels.create, { name: "secret" });
    await refused(mallory.mutation(api.issues.update, { issueId: mine, labelIds: [acmeLabel] }), "INVALID_ARGUMENT");
    // Assignee must be a member of this workspace.
    await refused(mallory.mutation(api.issues.assign, { issueId: mine, assigneeId: "ada" }), "INVALID_ARGUMENT");
    // Nothing in Acme changed.
    const after = await ada.query(api.issues.get, { issueId: acmeIssue });
    assert.deepEqual([after.blocks.length, after.blockedBy.length, after.children.length], [0, 0, 0]);
  } finally {
    await w.t.close();
  }
});

test("team permissions: private teams, guests, team leads", async () => {
  const w = await world();
  try {
    const pub = await makeTeam(w, w.acme, "grace", "PUB");
    const priv = await makeTeam(w, w.acme, "ada", "SEC", { private: true });
    const secret = (await w.as("ada", w.acme).mutation(api.issues.create, { teamId: priv.teamId, title: "Layoff plan" })).id;
    const grace = w.as("grace", w.acme);
    const linus = w.as("linus", w.acme);

    // Grace (member) cannot see the private team or its issues: they do not exist for her.
    assert.deepEqual((await grace.query(api.teams.list)).map((t) => t.key), ["PUB"]);
    await refused(grace.query(api.issues.get, { issueId: secret }), "NOT_FOUND");
    assert.equal((await grace.query(api.issues.search, { text: "layoff" })).length, 0);
    assert.equal((await grace.query(api.issues.list, {})).items.length, 0);
    // Adding her makes it visible; removing her takes it away again on the next call.
    await w.as("ada", w.acme).mutation(api.teams.addMember, { teamId: priv.teamId, userId: "grace" });
    assert.equal((await grace.query(api.issues.get, { issueId: secret })).title, "Layoff plan");
    await w.as("ada", w.acme).mutation(api.teams.removeMember, { teamId: priv.teamId, userId: "grace" });
    await refused(grace.query(api.issues.get, { issueId: secret }), "NOT_FOUND");

    // Linus (guest) sees no team until added, and then only that team; he cannot change status.
    assert.equal((await linus.query(api.teams.list)).length, 0);
    await w.as("grace", w.acme).mutation(api.teams.addMember, { teamId: pub.teamId, userId: "linus" });
    assert.deepEqual((await linus.query(api.teams.list)).map((t) => t.key), ["PUB"]);
    const filed = await linus.mutation(api.issues.create, { teamId: pub.teamId, title: "Guest report" });
    await refused(linus.mutation(api.issues.setStatus, { issueId: filed.id, status: "completed" }), "FORBIDDEN");
    await refused(linus.mutation(api.issues.assign, { issueId: filed.id, assigneeId: "grace" }), "FORBIDDEN");
    await linus.mutation(api.comments.add, { issueId: filed.id, body: "More detail" });

    // Team settings: the lead (grace on PUB) yes; a plain member no; an admin yes.
    await w.as("ada", w.acme).mutation(api.teams.join, { teamId: pub.teamId });
    await w.t.tenancy!.setRole({ ...(await w.t.tenancy!.context(w.acme, "ada"))!, principalId: "ada" }, "grace", "member");
    await grace.mutation(api.teams.update, { teamId: pub.teamId, name: "Public" });
    const linusMember = w.as("linus", w.acme);
    await refused(linusMember.mutation(api.teams.update, { teamId: pub.teamId, name: "x" }), "FORBIDDEN");
    await refused(grace.mutation(api.teams.update, { teamId: priv.teamId, name: "x" }), "NOT_FOUND");
  } finally {
    await w.t.close();
  }
});

test("ownership: creator or admin deletes issues; authors edit comments; moderators remove them", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const grace = w.as("grace", w.acme);
    const ada = w.as("ada", w.acme);
    const adaIssue = (await ada.mutation(api.issues.create, { teamId, title: "Ada's" })).id;
    const graceIssue = (await grace.mutation(api.issues.create, { teamId, title: "Grace's" })).id;

    // Members don't hold issues.delete at all; the creator rule applies to roles that do.
    await refused(grace.mutation(api.issues.remove, { issueId: graceIssue }), "FORBIDDEN");
    await ada.mutation(api.issues.remove, { issueId: graceIssue });
    await refused(ada.query(api.issues.get, { issueId: graceIssue }), "NOT_FOUND");

    const { id: commentId } = await grace.mutation(api.comments.add, { issueId: adaIssue, body: "first" });
    await refused(ada.mutation(api.comments.edit, { commentId, body: "rewritten by admin" }), "FORBIDDEN");
    await grace.mutation(api.comments.edit, { commentId, body: "first (edited)" });
    const { id: adaComment } = await ada.mutation(api.comments.add, { issueId: adaIssue, body: "mine" });
    await refused(grace.mutation(api.comments.remove, { commentId: adaComment }), "FORBIDDEN");
    await ada.mutation(api.comments.remove, { commentId }); // moderator
    const issue = await ada.query(api.issues.get, { issueId: adaIssue });
    assert.deepEqual(issue.comments.map((c) => [c.authorId, c.deleted, c.body]), [["grace", true, ""], ["ada", false, "mine"]]);
    assert.equal(issue.creatorId, "ada");
    // Creator attribution is the session's, never an argument.
    await refused(grace.mutation(api.issues.create, { teamId, title: "x", creatorId: "ada" } as never), ["INVALID_ARGUMENT"]);
  } finally {
    await w.t.close();
  }
});

test("issue lifecycle with durable history", async () => {
  const w = await world();
  try {
    const { teamId, state } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const grace = w.as("grace", w.acme);
    const label = await ada.mutation(api.labels.create, { name: "Bug" });
    const projectId = await ada.mutation(api.projects.create, { teamId, name: "Launch" });
    const milestoneId = await ada.mutation(api.projects.addMilestone, { projectId, name: "Beta" });
    const cycleId = await ada.mutation(api.cycles.create, { teamId, startDate: "2026-11-09", endDate: "2026-11-22" });

    const { id, key } = await ada.mutation(api.issues.create, { teamId, title: "Checkout fails", type: "bug", priority: 2 });
    assert.equal(key, "ENG-1");
    await ada.mutation(api.issues.assign, { issueId: id, assigneeId: "grace" });
    await grace.mutation(api.issues.update, { issueId: id, labelIds: [label], estimate: 3, dueDate: "2026-11-20", projectId, milestoneId, cycleId });
    await grace.mutation(api.issues.setStatus, { issueId: id, status: "In Progress" });
    await grace.mutation(api.comments.add, { issueId: id, body: "Found it: @[Ada](ada) the tax rounding." });
    await grace.mutation(api.issues.close, { issueId: id });
    let issue = await ada.query(api.issues.get, { issueId: id });
    assert.equal(issue.category, "completed");
    assert.ok(issue.completedAt);
    await ada.mutation(api.issues.reopen, { issueId: id });
    issue = await ada.query(api.issues.get, { issueId: id });
    assert.equal(issue.category, "unstarted");
    assert.equal(issue.completedAt, undefined);
    // Moving out of the project drops its milestone.
    await ada.mutation(api.issues.update, { issueId: id, projectId: null });
    issue = await ada.query(api.issues.get, { issueId: id });
    assert.equal(issue.milestoneId, undefined);
    // A state of another team is refused.
    const other = await makeTeam(w, w.acme, "ada", "DES");
    await refused(ada.mutation(api.issues.update, { issueId: id, stateId: other.state("started") }), "INVALID_ARGUMENT");
    await refused(ada.mutation(api.issues.update, { issueId: id, cycleId: await ada.mutation(api.cycles.create, { teamId: other.teamId, startDate: "2026-11-01", endDate: "2026-11-02" }) }), "INVALID_ARGUMENT");

    const types = issue.history.map((h) => h.type);
    assert.deepEqual(types.slice(0, 2), ["issue.created", "issue.assigned"]);
    assert.ok(types.includes("issue.status_changed"));
    assert.ok(types.includes("comment.added"));
    assert.deepEqual(issue.history.map((h) => h.seq), issue.history.map((_, i) => i + 1), "ordered by the database, gapless");
    const status = issue.history.filter((h) => h.type === "issue.status_changed").map((h) => [h.actor, h.data?.toName]);
    assert.deepEqual(status, [["grace", "In Progress"], ["grace", "Done"], ["ada", "Todo"]]);
    void state;

    await w.t.restart();
    const again = await w.as("ada", w.acme).query(api.issues.get, { issueId: id });
    assert.deepEqual(again.history, issue.history);
    assert.equal(again.comments[0]!.body, "Found it: @[Ada](ada) the tax rounding.");
    assert.deepEqual(again.comments[0]!.mentions, ["ada"]);
  } finally {
    await w.t.close();
  }
});
