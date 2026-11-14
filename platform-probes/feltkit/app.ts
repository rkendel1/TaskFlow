/**
 * A deliberately unguarded tenant app: it trusts the platform for everything, so each test shows
 * what FeltKit 0.3.29 itself does. TaskFlow guards each of these in application code.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "probes",
  roles: {
    person: ["notifications.read", "files.read"],
    owner: ["things.*", "tenant.*", "notifications.send", "files.write"],
    member: ["things.*", "notifications.send", "files.write"],
  },
  auth: { accounts: { roles: ["person"] }, tenant: { roles: ["owner", "member"] } },
  dev: { users: [{ id: "ada", roles: ["person"] }, { id: "mallory", roles: ["person"] }] },
  services: { notifications: true, files: true },
});

const WS = { tenant: { field: "workspaceId" } } as const;
/** TF-GAP-01: `unique: [["key"]]` on a workspace-scoped collection. */
export const teams = app.collection("teams", { key: s.string() }, { ...WS, unique: [["key"]] });
export const plain = app.collection("plain", { key: s.string() }, WS);
/** TF-GAP-02: an `s.ref` from one workspace's record to another's. */
export const things = app.collection("things", { plainId: s.ref(plain), title: s.string() }, WS);
