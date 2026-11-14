/**
 * Reproductions of the platform gaps in ../../docs/GAP-REGISTER.md, against FeltKit 0.3.29.
 * Each asserts the CURRENT behavior. A failing test here means the platform changed: re-check the
 * gap, and remove TaskFlow's workaround if it was fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

async function twoWorkspaces() {
  const t = await createTestApp();
  const a = (await t.provisionTenant("Acme", { id: "ada", roles: ["person"] })).id;
  const b = (await t.provisionTenant("Globex", { id: "mallory", roles: ["person"] })).id;
  return { t, ada: t.as("ada", { tenant: a }), mallory: t.as("mallory", { tenant: b }), a, b };
}

test("TF-GAP-01: a unique constraint on a workspace-scoped collection spans every workspace", async () => {
  const { t, ada, mallory } = await twoWorkspaces();
  try {
    await ada.mutation(api.probe.addTeam, { key: "ENG" });
    // Expected: Globex may have its own ENG. Actual: refused, which also tells Globex that some
    // other workspace has a team called ENG.
    await assert.rejects(mallory.mutation(api.probe.addTeam, { key: "ENG" }), (e: any) => e.code === "CONFLICT" && /unique/.test(e.message));
  } finally {
    await t.close();
  }
});

test("TF-GAP-02: s.ref accepts a record of another workspace, which then blocks its owner's delete", async () => {
  const { t, ada, mallory } = await twoWorkspaces();
  try {
    const acmeRecord = await ada.mutation(api.probe.addPlain, { key: "acme" });
    // Expected: NOT_FOUND (the record does not exist in Globex). Actual: accepted.
    await mallory.mutation(api.probe.addThing, { plainId: acmeRecord, title: "dangling into Acme" });
    // Consequence: Acme can no longer delete its own record (restrict-on-delete), because of a
    // record it cannot see.
    await assert.rejects(ada.mutation(api.probe.removePlain, { id: acmeRecord }));
  } finally {
    await t.close();
  }
});

test("TF-GAP-05: notifications are per recipient, not per workspace", async () => {
  const t = await createTestApp();
  try {
    const a = (await t.provisionTenant("Acme", { id: "ada", roles: ["person"] })).id;
    const b = (await t.provisionTenant("Personal", { id: "ada", roles: ["person"] })).id;
    await t.as("ada", { tenant: a }).mutation(api.probe.notifyMe, { title: "Acme layoffs list updated" });
    await t.runtime.runServices();
    // Working in another workspace, the service still returns Acme's notification.
    assert.deepEqual(await t.as("ada", { tenant: b }).query(api.probe.myNotifications), ["Acme layoffs list updated"]);
  } finally {
    await t.close();
  }
});

test("files: scoped per workspace (the GUARANTEES text saying \"application-shared\" is out of date)", async () => {
  const t = await createTestApp();
  try {
    const a = (await t.provisionTenant("Acme", { id: "ada", roles: ["person"] })).id;
    const b = (await t.provisionTenant("Globex", { id: "mallory", roles: ["person"] })).id;
    const c = (await t.provisionTenant("Personal", { id: "ada", roles: ["person"] })).id;
    await t.tenancy!.provision({ tenantId: a, principal: { id: "grace", type: "user" }, role: "member" }, "test");
    await t.as("ada", { tenant: a }).mutation(api.probe.upload, { name: "acme-contract.txt" });
    const seen = {
      acmeMember: await t.as({ id: "grace", type: "user", roles: ["person"] }, { tenant: a }).query(api.probe.listFiles),
      otherWorkspace: await t.as("mallory", { tenant: b }).query(api.probe.listFiles),
      uploaderElsewhere: await t.as("ada", { tenant: c }).query(api.probe.listFiles),
    };
    console.log("FILES", JSON.stringify(seen));
    assert.deepEqual(seen, { acmeMember: ["acme-contract.txt"], otherWorkspace: [], uploaderElsewhere: [] });
  } finally {
    await t.close();
  }
});
