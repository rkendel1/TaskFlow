/**
 * Demo data for a public demo deployment (scripts/demo-server.mjs runs it once the server is up).
 * It goes through the application's own functions over HTTP, signed in as development users,
 * exactly as a person clicking the app's own "load demo data" control would. Re-running it is a no-op.
 *
 *   node --import tsx scripts/demo-seed.ts [http://127.0.0.1:3000]
 */
import { createClient } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.js";

const url = process.argv[2] ?? "http://127.0.0.1:3000";

/** A client signed in as one of the app's declared dev users (development environment only). */
async function as(devUser: string) {
  let token: string | null = null;
  const client = createClient({ url, session: "bearer", tokens: { get: () => token, set: (t) => void (token = t) }, context: false });
  await client.signInAsDevUser(devUser);
  return client;
}

/** Run one step; a refusal with one of `done` means the data is already there. */
async function step(name: string, run: () => Promise<unknown>, done: string[] = []) {
  try {
    console.log(`[demo] ${name}:`, JSON.stringify(await run()) ?? "ok");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && done.includes(code)) console.log(`[demo] ${name}: already done.`);
    else throw e;
  }
}

// Ada's workspace, with the other dev users as members, and the app's demo data in it
// (Settings → "Load demo data"). The app signs a visitor in as Ada, so this is what they see.
const ada = await as("ada");
if (!(await ada.tenants()).tenants.length) {
  await step("workspace", () => ada.createTenant("Acme"));
  // People join the way teammates do: Ada invites, each accepts the invitation link.
  for (const id of ["grace", "linus", "mallory"]) {
    const person = await as(id);
    await step(`member ${id}`, async () => {
      const { link } = await ada.invite({ email: `${id}@taskflow.example`, role: "member" });
      const token = new URL(link, url).searchParams.get("invitation") ?? new URL(link, url).hash.split("=").pop()!;
      return person.acceptInvitation(token);
    });
  }
}
await step("teams, projects, cycles and issues", () => ada.mutation(api.seed.demo, {}), ["FAILED_PRECONDITION"]);
