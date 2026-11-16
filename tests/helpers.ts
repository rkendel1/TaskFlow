/**
 * A world for the tests: two workspaces (Acme, Globex) built with FeltKit's own tenancy store.
 *   Acme:   ada (owner), grace (member), linus (guest), triage-bot (agent)
 *   Globex: mallory (owner), grace (member: one person in two workspaces)
 */
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

export const BOT = { id: "triage-bot", type: "agent" as const, displayName: "Triage bot", roles: [] as string[] };

export interface World {
  t: TestApp;
  acme: string;
  globex: string;
  /** A caller working in a workspace, as a session would. */
  as(who: string | typeof BOT, workspace: string): ReturnType<TestApp["as"]>;
}

export async function world(): Promise<World> {
  const t = await createTestApp();
  const acme = (await t.provisionTenant("Acme", { id: "ada", roles: ["person"], displayName: "Ada" })).id;
  const globex = (await t.provisionTenant("Globex", { id: "mallory", roles: ["person"], displayName: "Mallory" })).id;
  const tenancy = t.tenancy!;
  await tenancy.provision({ tenantId: acme, principal: { id: "grace", type: "user", displayName: "Grace" }, role: "member" }, "test");
  await tenancy.provision({ tenantId: acme, principal: { id: "linus", type: "user", displayName: "Linus" }, role: "guest" }, "test");
  await tenancy.provision({ tenantId: globex, principal: { id: "grace", type: "user", displayName: "Grace" }, role: "member" }, "test");
  // An agent joins the way the platform allows: added by a workspace manager, with a role.
  const owner = await tenancy.context(acme, "ada");
  await tenancy.addPrincipal({ ...owner!, principalId: "ada" }, { id: BOT.id, type: "agent", displayName: BOT.displayName }, "agent");
  const roles: Record<string, string[]> = { ada: ["person", "operator"], grace: ["person"], linus: ["person"], mallory: ["person"] };
  return {
    t,
    acme,
    globex,
    as: (who, workspace) =>
      typeof who === "string" ? t.as({ id: who, type: "user", displayName: who, roles: roles[who] ?? ["person"] }, { tenant: workspace }) : t.as(who, { tenant: workspace }),
  };
}

/** A team with a known shape: returns its id and its states by category. */
export async function makeTeam(w: World, workspace: string, who: string, key: string, opts: { private?: boolean } = {}) {
  const c = w.as(who, workspace);
  const teamId = await c.mutation(api.teams.create, { key, name: `${key} team`, ...(opts.private ? { private: true } : {}) });
  const team = await c.query(api.teams.get, { teamId });
  const state = (category: string) => team.states.find((st: { category: string }) => st.category === category)!.id as string;
  return { teamId, state };
}

/** Assert a call is refused with one of `codes`. */
export async function refused(promise: Promise<unknown>, codes: string[] | string): Promise<string> {
  const want = Array.isArray(codes) ? codes : [codes];
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (!want.includes(code)) throw new Error(`Expected ${want.join("/")}, got ${code}: ${(e as Error).message}`);
    return code;
  }
  throw new Error(`Expected ${want.join("/")}, but the call succeeded`);
}

/** The TaskFlow assistant (an application agent), as a workspace manager adds it. */
export async function addAssistant(w: World, workspace: string, manager = "ada") {
  const ctx = await w.t.tenancy!.context(workspace, manager);
  await w.t.tenancy!.addPrincipal({ ...ctx!, principalId: manager }, { id: "taskflow-assistant", type: "agent", displayName: "TaskFlow assistant" }, "agent");
}
