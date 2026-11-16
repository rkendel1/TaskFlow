/**
 * Capture through FeltKit surfaces and invocations: the envelope contract, durable dispatch,
 * replays, cancellation, workspace visibility, and the team policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { makeTeam, refused, world } from "./helpers.js";

const envelope = (invocationId: string, extra: Record<string, unknown> = {}) => ({
  contract: "feltkit.invocation/1",
  invocationId,
  surface: { id: "capture", version: "1.0.0", device: "Chrome" },
  instruction: "Checkout button overlaps the total on mobile",
  context: [
    { kind: "url", url: "https://shop.example.com/cart", title: "Your cart" },
    { kind: "selection", text: "Total: $41.99", url: "https://shop.example.com/cart" },
  ],
  returnTo: { kind: "app" },
  submittedAt: Date.now(),
  ...extra,
});

test("a capture becomes an issue, once, through the invocation lifecycle", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const grace = w.as("grace", w.acme);
    const receipt = await grace.mutation(api.capture.submit, { teamId, envelope: envelope("capture-0001") });
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.state, "accepted");
    await w.t.runtime.runServices(); // dispatch: the job runs as Grace

    const [mine] = await grace.query(api.capture.list);
    assert.equal(mine!.state, "completed");
    assert.match(mine!.result!.key, /^ENG-1$/);
    const issue = await grace.query(api.issues.get, { issueId: mine!.result!.issueId });
    assert.equal(issue.title, "Checkout button overlaps the total on mobile");
    assert.equal(issue.creatorId, "grace");
    assert.match(issue.description!, /Source: Your cart — https:\/\/shop\.example\.com\/cart/);
    assert.match(issue.description!, /> Total: \$41\.99/);
    assert.deepEqual(issue.history[0]!.data?.captured, { invocation: mine!.id, surface: "capture" });

    // The surface retries the same request: a replay, nothing new.
    const again = await grace.mutation(api.capture.submit, { teamId, envelope: envelope("capture-0001") });
    assert.equal(again.replayed, true);
    await w.t.runtime.runServices();
    assert.equal((await grace.query(api.issues.list, { teamId })).total, 1);
    // The same id with other content is refused.
    await refused(grace.mutation(api.capture.submit, { teamId, envelope: envelope("capture-0001", { instruction: "something else" }) }), ["CONFLICT", "INVALID_ARGUMENT", "FAILED_PRECONDITION"]);
    // The dispatch runs as the person: a role without the job permissions fails it silently in the
    // outbox (TF-GAP-10). None may have failed.
    assert.deepEqual((await w.t.runtime.listOutbox({ state: "failed" })).length, 0);
  } finally {
    await w.t.close();
  }
});

test("the envelope carries data, never identity; undeclared context is refused before anything is stored", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const grace = w.as("grace", w.acme);
    const reason = async (env: unknown) => {
      try {
        await grace.mutation(api.capture.submit, { teamId, envelope: env });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("accepted");
    };
    assert.match(await reason(envelope("capture-000x", { principal: "ada" })), /principal/i);
    assert.match(await reason(envelope("capture-000y", { context: [{ kind: "document", name: "a.txt", mediaType: "text/plain", size: 3, text: "abc" }] })), /document/i);
    assert.match(await reason(envelope("capture-000z", { surface: { id: "chat", version: "1" } })), /surface|chat/i);
    assert.deepEqual(await grace.query(api.capture.list), []);
  } finally {
    await w.t.close();
  }
});

test("captures are private to the person and their workspace; a canceled one files nothing; the team policy applies", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const secret = await makeTeam(w, w.acme, "ada", "SEC", { private: true });
    const grace = w.as("grace", w.acme);
    const receipt = await grace.mutation(api.capture.submit, { teamId, envelope: envelope("capture-0002") });
    // Ada (owner) does not see Grace's capture; Grace in Globex does not see her Acme capture.
    assert.deepEqual(await w.as("ada", w.acme).query(api.capture.list), []);
    assert.deepEqual(await w.as("grace", w.globex).query(api.capture.list), []);
    await refused(w.as("ada", w.acme).mutation(api.capture.cancel, { id: receipt.id }), ["NOT_FOUND", "FORBIDDEN"]);
    // Grace cancels before it runs: nothing is filed.
    await grace.mutation(api.capture.cancel, { id: receipt.id });
    await w.t.runtime.runServices();
    assert.equal((await grace.query(api.capture.list))[0]!.state, "cancelled");
    assert.equal((await w.as("ada", w.acme).query(api.issues.list, { teamId })).total, 0);
    // A private team she is not in does not exist for her; a guest outside the team neither.
    await refused(grace.mutation(api.capture.submit, { teamId: secret.teamId, envelope: envelope("capture-0003") }), "NOT_FOUND");
    await refused(w.as("linus", w.acme).mutation(api.capture.submit, { teamId, envelope: envelope("capture-0004") }), "NOT_FOUND");
  } finally {
    await w.t.close();
  }
});
