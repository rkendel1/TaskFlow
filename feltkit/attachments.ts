/**
 * Attachments: AppPort Services Files, through FeltKit's file links. A function checks the issue
 * (the resource policy runs first, on issueId), then issues a link that is the authority for one
 * transfer. Files are workspace-scoped by FeltKit (platform-probes/tests/gaps.test.ts), and each
 * carries its issue in metadata, fixed by the function that issued the upload link.
 */
import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { recordIssue } from "./_domain.js";
import { policy } from "./_policy.js";

const MAX_BYTES = 10 * 1024 * 1024;

export const list = app.query({
  access: "issues.read",
  args: { issueId: s.string() },
  handler: async (ctx, { issueId }) =>
    (await ctx.services.files.list({ metadata: { issueId } }))
      .map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType, owner: f.owner, createdAt: f.createdAt }))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
});

/** A single-use upload link for one file on this issue (PUT the bytes to it). */
export const uploadLink = app.mutation({
  access: "files.write",
  args: { issueId: s.string(), name: s.string({ minLength: 1, maxLength: 200 }), contentType: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, { issueId, name, contentType }) =>
    ctx.services.files.uploadLink({ name, contentType: contentType ?? "application/octet-stream", metadata: { issueId }, maxBytes: MAX_BYTES, expiresInSeconds: 300 }),
});

/** Record an uploaded file in the issue's history (and confirm it belongs to the issue). */
export const attach = app.mutation({
  access: "files.write",
  args: { issueId: s.string(), fileId: s.string() },
  handler: async (ctx, { issueId, fileId }) => {
    const file = await ctx.services.files.get(fileId);
    if (file.metadata?.issueId !== issueId) fail("NOT_FOUND", "No such attachment on this issue.");
    await recordIssue(ctx, issueId, "attachment.added", { fileId, name: file.name, size: file.size });
  },
});

/** A short-lived download link, issued only after the issue was checked. */
export const download = app.mutation({
  access: "issues.read",
  args: { issueId: s.string(), fileId: s.string() },
  handler: async (ctx, { issueId, fileId }) => {
    const file = await ctx.services.files.get(fileId);
    if (file.metadata?.issueId !== issueId) fail("NOT_FOUND", "No such attachment on this issue.");
    return ctx.services.files.link(fileId, { expiresInSeconds: 120, disposition: "attachment" });
  },
});

/**
 * Remove an attachment: its uploader, or a workspace owner/admin. Checked here rather than in
 * _policy.ts because the authorization hook reads the database, not AppPort Services' records
 * (docs/GAP-REGISTER.md TF-GAP-09).
 */
export const remove = app.mutation({
  access: "files.write",
  args: { issueId: s.string(), fileId: s.string() },
  handler: async (ctx, { issueId, fileId }) => {
    const file = await ctx.services.files.get(fileId);
    if (file.metadata?.issueId !== issueId) fail("NOT_FOUND", "No such attachment on this issue.");
    const me = ctx.auth.requirePrincipal();
    const role = ctx.auth.tenant?.role;
    if (file.owner !== me.id && role !== "owner" && role !== "admin") fail("FORBIDDEN", "Only the uploader or a workspace admin can remove an attachment.");
    await ctx.services.files.remove(fileId);
    await recordIssue(ctx, issueId, "attachment.removed", { fileId, name: file.name });
  },
});

// Resource policy (_policy.ts), bound to each definition.
policy(list, { targets: { issueId: "issue" } });
policy(uploadLink, { targets: { issueId: "issue" } });
policy(attach, { targets: { issueId: "issue" } });
policy(download, { targets: { issueId: "issue" } });
policy(remove, { targets: { issueId: "issue" } });
