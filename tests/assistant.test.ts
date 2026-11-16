/**
 * Delegation: a person lets the TaskFlow assistant file issues for them (FeltKit `authority.local`,
 * a private AuthBoundry). The assistant acts as itself, only for people who allowed it, only within
 * its own workspace role and the team policy, and every decision is recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { addAssistant, BOT, makeTeam, refused, world } from "./helpers.js";

/**
 * Wait for after-commit work, the assistant's run included. Its first decision starts the private
 * AuthBoundry (about a second), so poll until nothing is pending or performing.
 */
async function settle(w: Awaited<ReturnType<typeof world>>, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    await w.t.runtime.runServices();
    const open = (await w.t.runtime.listOutbox({})).filter((o) => o.state === "pending" || o.state === "performing");
    if (!open.length) return;
    if (Date.now() - started > timeoutMs) throw new Error(`after-commit work still open: ${open.map((o) => o.state).join(", ")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("the assistant files a follow-up only for someone who allowed it, and stops when they revoke", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const grace = w.as("grace", w.acme);
    const { id: parentId } = await ada.mutation(api.issues.create, { teamId, title: "Release 2.0" });

    // Not a member of the workspace yet: nothing is queued, and the caller is told.
    assert.equal((await ada.mutation(api.comments.add, { issueId: parentId, body: "@assistant follow up: Write the migration guide" })).assistant, "not-in-workspace");
    await addAssistant(w, w.acme);

    // A member, but Ada has not delegated: it answers, and files nothing.
    assert.equal((await ada.mutation(api.comments.add, { issueId: parentId, body: "@assistant follow up: Write the migration guide" })).assistant, "asked");
    await settle(w);
    let parent = await ada.query(api.issues.get, { issueId: parentId });
    assert.equal(parent.children.length, 0);
    assert.match(parent.comments.at(-1)!.body, /can't file issues for @\[.*\]\(ada\)/);
    assert.equal(parent.comments.at(-1)!.authorId, "taskflow-assistant");
    assert.equal(parent.history.filter((h) => h.type === "assistant.refused").at(-1)!.data?.outcome, "deny");

    // Ada allows it for 7 days: the next request is filed, for her, by the assistant.
    const g = await ada.mutation(api.assistant.grant, { days: 7 });
    assert.deepEqual(g.capabilities, ["issues.create"]);
    assert.ok(g.expiresAt! > Date.now() + 6 * 86_400_000);
    await ada.mutation(api.comments.add, { issueId: parentId, body: "Next: @assistant follow up: Write the migration guide" });
    await settle(w);
    parent = await ada.query(api.issues.get, { issueId: parentId });
    assert.deepEqual(parent.children.map((c) => c.title), ["Write the migration guide"]);
    const child = await ada.query(api.issues.get, { issueId: parent.children[0]!.id });
    assert.equal(child.creatorId, "taskflow-assistant", "it acted as itself");
    const created = child.history[0]!;
    assert.equal(created.actor, "taskflow-assistant");
    assert.equal(created.actorType, "agent");
    assert.equal(created.data?.onBehalfOf, "ada");
    assert.ok(created.data?.delegationId, "the delegation that allowed it is on record");
    assert.match(parent.comments.at(-1)!.body, /^Filed ENG-\d+ for @\[/);

    // Ada's grant is hers: Grace's request is refused, and Grace does not see Ada's grant.
    assert.deepEqual(await grace.mutation(api.assistant.grants, {}), []);
    await grace.mutation(api.comments.add, { issueId: parentId, body: "@assistant follow up: Grace's idea" });
    await settle(w);
    parent = await ada.query(api.issues.get, { issueId: parentId });
    assert.equal(parent.children.length, 1);
    assert.match(parent.comments.at(-1)!.body, /\(grace\)/);

    // Revoked: the next request is refused.
    await ada.mutation(api.assistant.revoke, { id: g.id });
    await ada.mutation(api.comments.add, { issueId: parentId, body: "@assistant follow up: One more" });
    await settle(w);
    parent = await ada.query(api.issues.get, { issueId: parentId });
    assert.equal(parent.children.length, 1);
    assert.equal(parent.history.filter((h) => h.type === "assistant.refused").length, 3);
    assert.deepEqual((await w.t.runtime.listOutbox({ state: "failed" })).length, 0);
  } finally {
    await w.t.close();
  }
});

test("a delegation never exceeds the assistant's own reach, and only people delegate", async () => {
  const w = await world();
  try {
    const secret = await makeTeam(w, w.acme, "ada", "SEC", { private: true });
    const ada = w.as("ada", w.acme);
    await addAssistant(w, w.acme);
    await ada.mutation(api.assistant.grant, {});
    const { id: hidden } = await ada.mutation(api.issues.create, { teamId: secret.teamId, title: "Board prep" });
    // Ada may file in her private team, and has delegated; the assistant is not on that team.
    // Ada may file in her private team, and has delegated; the assistant is not on that team, so
    // nothing is queued and Ada is told why.
    assert.equal((await ada.mutation(api.comments.add, { issueId: hidden, body: "@assistant follow up: Book the room" })).assistant, "not-on-team");
    await settle(w);
    const parent = await ada.query(api.issues.get, { issueId: hidden });
    assert.equal(parent.children.length, 0, "the assistant's own reach bounds it, whatever Ada allowed");
    // Put it on the team and the same request is filed.
    await ada.mutation(api.teams.addMember, { teamId: secret.teamId, userId: "taskflow-assistant" });
    assert.equal((await ada.mutation(api.comments.add, { issueId: hidden, body: "@assistant follow up: Book the room" })).assistant, "asked");
    await settle(w);
    assert.deepEqual((await ada.query(api.issues.get, { issueId: hidden })).children.map((c) => c.title), ["Book the room"]);
    assert.equal(parent.comments.filter((c) => c.authorId === "taskflow-assistant").length, 0);
    // An agent cannot delegate (it has no assistant.delegate permission, and is not a person).
    await refused(w.as(BOT, w.acme).mutation(api.assistant.grant, {}), "FORBIDDEN");
  } finally {
    await w.t.close();
  }
});
