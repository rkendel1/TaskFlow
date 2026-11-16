/**
 * Capture: an issue filed from wherever the person is. FeltKit accepts the `feltkit.invocation/1`
 * envelope against the `capture` surface (app.ts), commits the invocation with its dispatch, and runs
 * `capture:file` once, as the person, recovering it after a crash. TaskFlow turns the request into
 * an issue and reports the issue as the invocation's result.
 */
import { s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { createIssue } from "./_issues.js";
import { policy } from "./_policy.js";

type Context = { kind: "url"; url: string; title?: string } | { kind: "selection"; text: string; url?: string; title?: string } | { kind: "text"; text: string };

/** Title from what the person said, else what they captured. */
function titleOf(instruction: string, context: readonly Context[]): string {
  const said = instruction.trim().split("\n")[0]!.trim();
  if (said) return said.slice(0, 200);
  for (const c of context) {
    if ("title" in c && c.title?.trim()) return c.title.trim().slice(0, 200);
    if (c.kind === "selection" || c.kind === "text") return c.text.trim().split("\n")[0]!.slice(0, 120) || "Captured";
    if (c.kind === "url") return `Captured from ${new URL(c.url).host}`;
  }
  return "Captured";
}

/** The issue's description: the request, then each captured item, then where it came from. */
function descriptionOf(instruction: string, context: readonly Context[], surface: string): string {
  const parts: string[] = [];
  if (instruction.trim()) parts.push(instruction.trim());
  for (const c of context) {
    if (c.kind === "url") parts.push(`Source: ${c.title ? `${c.title} — ` : ""}${c.url}`);
    if (c.kind === "selection") parts.push(`${c.text.split("\n").map((l) => `> ${l}`).join("\n")}${c.url ? `\n— ${c.title ? `${c.title}, ` : ""}${c.url}` : ""}`);
    if (c.kind === "text") parts.push(c.text);
  }
  parts.push(`(Captured through ${surface}.)`);
  return parts.join("\n\n").slice(0, 20000);
}

const Receipt = s.object({ id: s.string(), invocationId: s.string(), state: s.string(), replayed: s.boolean() });

/** Accept a capture into a team. Refused before anything is stored if the envelope is malformed. */
export const submit = app.mutation({
  access: "issues.create",
  args: { teamId: s.string(), envelope: s.unknown() },
  returns: Receipt,
  handler: async (ctx, { teamId, envelope }) => {
    const receipt = await ctx.invocations.accept({ surface: "capture", envelope, dispatch: { job: "capture.file", payload: { teamId } } });
    return { id: receipt.id, invocationId: receipt.invocationId, state: receipt.state, replayed: receipt.replayed };
  },
});

/** The dispatched work (job "capture.file"), run as the person who captured it. */
export const file = app.mutation({
  access: "issues.create",
  args: { invocation: s.string(), teamId: s.string() },
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { invocation, teamId }) => {
    const run = await ctx.invocations.start(invocation);
    if (!run.proceed) return; // cancelled, already done, or running elsewhere
    const record = await ctx.invocations.get(invocation);
    const context = record.invocation.context as unknown as Context[];
    const { id, key } = await createIssue(
      ctx,
      { teamId, title: titleOf(record.invocation.instruction, context), description: descriptionOf(record.invocation.instruction, context, record.surface) },
      { history: { captured: { invocation, surface: record.surface } } },
    );
    await ctx.invocations.transition(invocation, "completed", { claim: run.claim!, result: { issueId: id, key } });
  },
});

/** My captures in this workspace, newest first, with what became of each. */
export const list = app.query({
  access: "issues.read",
  handler: async (ctx) => {
    const workspace = ctx.auth.tenant?.id;
    return (await ctx.invocations.list({ surface: "capture", limit: 50 }))
      .filter((i) => i.tenantId === workspace)
      .map((i) => ({
        id: i.id,
        state: i.state,
        instruction: i.invocation.instruction,
        context: i.invocation.context.map((c) => ({ kind: c.kind, ...("url" in c && c.url ? { url: c.url } : {}), ...("title" in c && c.title ? { title: c.title } : {}) })),
        receivedAt: i.history[0]?.at ?? 0,
        result: (i.outcome?.result ?? null) as { issueId: string; key: string } | null,
        error: i.outcome?.error ?? null,
      }))
      .sort((x, y) => y.receivedAt - x.receivedAt);
  },
});

export const cancel = app.mutation({
  access: "issues.create",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await ctx.invocations.cancel(id, { reason: "Canceled by the person" });
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(submit, { targets: { teamId: "team" } });
policy(file, { targets: { teamId: "team" } });
policy(list, {});
policy(cancel, {});
