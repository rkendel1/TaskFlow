import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useFeltKit, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Avatar, LabelChip, PRIORITIES, StatusIcon, TYPES, ago, describe, href, useHotkeys, useRun, useWorkspace } from "./lib";

type Detail = NonNullable<ReturnType<typeof useQueryState<typeof api.issues.get>>["data"]>;

export function IssuePanel({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const result = useQueryState(api.issues.get, { issueId });
  useHotkeys({ escape: onClose }, [onClose]);
  return (
    <aside className="panel" aria-label="Issue">
      <div className="panel-bar">
        <span className="muted">{result.data?.key ?? ""}</span>
        <button className="icon-button" onClick={onClose} aria-label="Close (Esc)">✕</button>
      </div>
      {result.error ? (
        <div className="empty-state"><p>{describe(result.error)}</p></div>
      ) : !result.data ? (
        <div className="skeleton-list" aria-busy="true"><div className="skeleton-row" /><div className="skeleton-row" /></div>
      ) : (
        <IssueDetail issue={result.data} onDeleted={onClose} />
      )}
    </aside>
  );
}

function IssueDetail({ issue, onDeleted }: { issue: Detail; onDeleted: () => void }) {
  const ws = useWorkspace();
  const run = useRun();
  const update = useMutation(api.issues.update);
  const remove = useMutation(api.issues.remove);
  const team = ws.team(issue.teamId);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  useEffect(() => setTitle(issue.title), [issue.title]);
  useEffect(() => setDescription(issue.description ?? ""), [issue.description]);

  // Every edit names the version it was made against: a concurrent change is refused, not overwritten.
  const save = (changes: Record<string, unknown>) => run(update({ issueId: issue.id, expectedVersion: issue.__version, ...changes } as never));
  const canDelete = ws.overview.workspace.role === "owner" || ws.overview.workspace.role === "admin";

  return (
    <div className="detail">
      <div className="detail-main">
        <input
          className="detail-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== issue.title && void save({ title: title.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Title"
        />
        <textarea
          className="detail-description"
          value={description}
          placeholder="Add a description…"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== (issue.description ?? "") && void save({ description: description.trim() || null })}
          aria-label="Description"
          rows={Math.min(14, Math.max(3, description.split("\n").length + 1))}
        />
        {issue.parent && <p className="muted small">Sub-issue of <a href={href(window.location.hash.slice(1).split("?")[0]!, { issue: issue.parent.id })}>{issue.parent.key} {issue.parent.title}</a></p>}
        <Related title="Sub-issues" items={issue.children} />
        <Relations issue={issue} />
        <Attachments issueId={issue.id} />
        <Thread issue={issue} />
      </div>
      <div className="detail-side">
        <Field label="Status">
          <select value={issue.stateId} onChange={(e) => save({ stateId: e.target.value })} aria-label="Status">
            {team?.states.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={issue.priority} onChange={(e) => save({ priority: Number(e.target.value) })} aria-label="Priority">
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Assignee">
          <select value={issue.assigneeId ?? ""} onChange={(e) => save({ assigneeId: e.target.value || null })} aria-label="Assignee">
            <option value="">Unassigned</option>
            {ws.members.filter((m) => m.role !== "guest" || m.id === issue.assigneeId).map((m) => <option key={m.id} value={m.id}>{m.name}{m.type === "agent" ? " (agent)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={issue.type} onChange={(e) => save({ type: e.target.value })} aria-label="Type">
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Labels">
          <LabelPicker teamId={issue.teamId} value={issue.labelIds} onChange={(labelIds) => save({ labelIds })} />
        </Field>
        <Field label="Estimate">
          <input type="number" min={0} max={100} defaultValue={issue.estimate ?? ""} key={`e${issue.__version}`} onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== (issue.estimate ?? null)) void save({ estimate: v }); }} aria-label="Estimate" />
        </Field>
        <Field label="Due date">
          <input type="date" value={issue.dueDate ?? ""} onChange={(e) => save({ dueDate: e.target.value || null })} aria-label="Due date" />
        </Field>
        <ProjectFields issue={issue} save={save} />
        <CycleField issue={issue} save={save} />
        <Field label="Created by"><span className="field-value"><Avatar id={issue.creatorId} size={18} /> {ws.member(issue.creatorId)?.name ?? issue.creatorId}</span></Field>
        <Field label="Updated"><span className="field-value muted">{ago(issue.updatedAt)}</span></Field>
        {canDelete && (
          <button className="danger-link" onClick={async () => { if (confirm(`Delete ${issue.key}? Its comments go with it; its history stays.`)) { if (await run(remove({ issueId: issue.id }), `${issue.key} deleted`)) onDeleted(); } }}>
            Delete issue
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}</label>;
}

function LabelPicker({ teamId, value, onChange }: { teamId: string; value: string[]; onChange: (v: string[]) => void }) {
  const ws = useWorkspace();
  const options = ws.labels.filter((l) => !l.teamId || l.teamId === teamId);
  const set = new Set(value);
  return (
    <details className="filter label-picker">
      <summary>{value.length ? value.map((l) => <LabelChip key={l} id={l} />) : <span className="muted">Add labels</span>}</summary>
      <div className="filter-menu">
        {options.map((l) => (
          <label key={l.id}><input type="checkbox" checked={set.has(l.id)} onChange={(e) => { const n = new Set(set); if (e.target.checked) n.add(l.id); else n.delete(l.id); onChange([...n]); }} /> <span className="label-dot" style={{ background: l.color }} /> {l.name}</label>
        ))}
      </div>
    </details>
  );
}

function ProjectFields({ issue, save }: { issue: Detail; save: (c: Record<string, unknown>) => unknown }) {
  const projects = useQueryState(api.projects.list, {});
  const summary = useQueryState(api.projects.summary, issue.projectId ? { projectId: issue.projectId } : "skip");
  return (
    <>
      <Field label="Project">
        <select value={issue.projectId ?? ""} onChange={(e) => save({ projectId: e.target.value || null })} aria-label="Project">
          <option value="">No project</option>
          {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      {issue.projectId && (
        <Field label="Milestone">
          <select value={issue.milestoneId ?? ""} onChange={(e) => save({ milestoneId: e.target.value || null })} aria-label="Milestone">
            <option value="">No milestone</option>
            {summary.data?.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      )}
    </>
  );
}

function CycleField({ issue, save }: { issue: Detail; save: (c: Record<string, unknown>) => unknown }) {
  const cycles = useQueryState(api.cycles.list, { teamId: issue.teamId });
  return (
    <Field label="Cycle">
      <select value={issue.cycleId ?? ""} onChange={(e) => save({ cycleId: e.target.value || null })} aria-label="Cycle">
        <option value="">No cycle</option>
        {cycles.data?.filter((c) => c.phase !== "completed" || c.id === issue.cycleId).map((c) => <option key={c.id} value={c.id}>Cycle {c.number}{c.phase === "active" ? " (current)" : ""}</option>)}
      </select>
    </Field>
  );
}

function Related({ title, items, onRemove }: { title: string; items: Detail["children"]; onRemove?: (id: string) => void }) {
  if (!items.length) return null;
  const base = window.location.hash.slice(1).split("?")[0]!;
  return (
    <div className="related">
      <h3>{title}</h3>
      {items.map((i) => (
        <div key={i.id} className="related-row">
          <StatusIcon category={i.category} />
          <a href={href(base, { issue: i.id })}><span className="issue-key">{i.key}</span> {i.title}</a>
          {onRemove && <button className="link small" onClick={() => onRemove(i.id)} aria-label={`Remove relation to ${i.key}`}>Remove</button>}
        </div>
      ))}
    </div>
  );
}

function Relations({ issue }: { issue: Detail }) {
  const run = useRun();
  const add = useMutation(api.issues.addRelation);
  const removeRel = useMutation(api.issues.removeRelation);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<"blocks" | "blockedBy">("blocks");
  const found = useQueryState(api.issues.search, key.trim().length >= 3 ? { text: key.trim(), limit: 5 } : "skip");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const target = found.data?.find((i) => i.id !== issue.id);
    if (!target) return;
    await run(mode === "blocks" ? add({ issueId: issue.id, blockedId: target.id }) : add({ issueId: target.id, blockedId: issue.id }));
    setKey("");
  };
  return (
    <>
      <Related title="Blocks" items={issue.blocks} onRemove={(id) => void run(removeRel({ issueId: issue.id, blockedId: id }))} />
      <Related title="Blocked by" items={issue.blockedBy} onRemove={(id) => void run(removeRel({ issueId: id, blockedId: issue.id }))} />
      <form className="relation-form" onSubmit={submit}>
        <select value={mode} onChange={(e) => setMode(e.target.value as never)} aria-label="Relation">
          <option value="blocks">Blocks</option>
          <option value="blockedBy">Blocked by</option>
        </select>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Issue key or title" aria-label="Related issue" list={`rel-${issue.id}`} />
        <datalist id={`rel-${issue.id}`}>{found.data?.filter((i) => i.id !== issue.id).map((i) => <option key={i.id} value={i.key}>{i.title}</option>)}</datalist>
        <button disabled={!found.data?.some((i) => i.id !== issue.id)}>Add</button>
      </form>
    </>
  );
}

/** Files on the issue: uploaded and downloaded through single-use / short-lived FeltKit file links. */
function Attachments({ issueId }: { issueId: string }) {
  const client = useFeltKit();
  const files = useQueryState(api.attachments.list, { issueId });
  const uploadLink = useMutation(api.attachments.uploadLink);
  const attach = useMutation(api.attachments.attach);
  const download = useMutation(api.attachments.download);
  const remove = useMutation(api.attachments.remove);
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const link = await run(uploadLink({ issueId, name: file.name, contentType: file.type || "application/octet-stream" }));
      if (!link) return;
      const stored = await run(client.uploadFile(link as never, new Uint8Array(await file.arrayBuffer()), { name: file.name, contentType: file.type || "application/octet-stream" }));
      if (stored) await run(attach({ issueId, fileId: stored.id }));
    } finally {
      setBusy(false);
    }
  };
  const open = async (fileId: string) => {
    const link = await run(download({ issueId, fileId }));
    if (link) window.open(client.fileUrl(link as never), "_blank", "noopener");
  };
  return (
    <div className="related">
      <h3>Attachments</h3>
      {files.data?.map((f) => (
        <div key={f.id} className="related-row">
          <span>📎</span>
          <button className="link" onClick={() => void open(f.id)}>{f.name}</button>
          <span className="muted small">{Math.max(1, Math.round(f.size / 1024))} KB</span>
          <button className="link small" onClick={() => void run(remove({ issueId, fileId: f.id }))} aria-label={`Remove ${f.name}`}>Remove</button>
        </div>
      ))}
      <label className="small muted upload">
        {busy ? "Uploading…" : "Attach a file (up to 10 MB)"}
        <input type="file" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      </label>
    </div>
  );
}

/** Comments and the change history, interleaved by time. */
function Thread({ issue }: { issue: Detail }) {
  const ws = useWorkspace();
  const run = useRun();
  const addComment = useMutation(api.comments.add);
  const editComment = useMutation(api.comments.edit);
  const removeComment = useMutation(api.comments.remove);
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const me = ws.overview.me.id;
  const moderator = ws.overview.workspace.role === "owner" || ws.overview.workspace.role === "admin";
  const entries = useMemo(() => {
    const items: Array<{ at: number; kind: "comment"; c: Detail["comments"][number] } | { at: number; kind: "event"; e: Detail["history"][number] }> = [];
    for (const c of issue.comments) items.push({ at: c.createdAt, kind: "comment", c });
    for (const e of issue.history) if (!e.type.startsWith("comment.")) items.push({ at: e.at, kind: "event", e });
    return items.sort((a, b) => a.at - b.at);
  }, [issue.comments, issue.history]);
  const mention = (id: string) => {
    const m = ws.member(id);
    if (m) setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}@[${m.name}](${m.id}) `);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    if (await run(addComment({ issueId: issue.id, body }))) setBody("");
  };
  return (
    <div className="thread">
      <h3>Activity</h3>
      <ol className="timeline">
        {entries.map((x) =>
          x.kind === "event" ? (
            <li key={`e${x.e.seq}`} className="event"><Avatar id={x.e.actor} size={16} /> <span>{eventText(x.e, ws)}</span> <span className="muted">{ago(x.at)}</span></li>
          ) : (
            <li key={x.c.id} className="comment">
              <div className="comment-head"><Avatar id={x.c.authorId} size={20} /> <strong>{ws.member(x.c.authorId)?.name ?? x.c.authorId}</strong> <span className="muted">{ago(x.c.createdAt)}{x.c.editedAt ? " (edited)" : ""}</span>
                {!x.c.deleted && x.c.authorId === me && <button className="link small" onClick={() => setEditing(x.c.id)}>Edit</button>}
                {!x.c.deleted && (x.c.authorId === me || moderator) && <button className="link small" onClick={() => void run(removeComment({ commentId: x.c.id }))}>Delete</button>}
              </div>
              {x.c.deleted ? <p className="muted">Comment deleted.</p> : editing === x.c.id ? (
                <form onSubmit={async (e) => { e.preventDefault(); const text = new FormData(e.currentTarget).get("body") as string; if (await run(editComment({ commentId: x.c.id, body: text }))) setEditing(null); }}>
                  <textarea name="body" defaultValue={x.c.body} rows={3} aria-label="Edit comment" />
                  <button>Save</button> <button type="button" className="link" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : <p className="comment-body">{renderMentions(x.c.body, ws)}</p>}
            </li>
          ),
        )}
      </ol>
      <form className="comment-form" onSubmit={submit}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a comment…" rows={3} aria-label="Comment" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e as never); }} />
        <div className="comment-actions">
          <select value="" onChange={(e) => e.target.value && mention(e.target.value)} aria-label="Mention someone">
            <option value="">@ Mention…</option>
            {ws.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button disabled={!body.trim()}>Comment</button>
        </div>
      </form>
    </div>
  );
}

function renderMentions(body: string, ws: ReturnType<typeof useWorkspace>) {
  const parts = body.split(/(@\[[^\]]+\]\([^)]+\))/g);
  return parts.map((p, i) => {
    const m = /^@\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
    return m ? <span key={i} className="mention">@{ws.member(m[2])?.name ?? m[1]}</span> : <span key={i}>{p}</span>;
  });
}

function eventText(e: Detail["history"][number], ws: ReturnType<typeof useWorkspace>): string {
  const who = ws.member(e.actor)?.name ?? e.actor;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const name = (id: unknown) => (typeof id === "string" ? ws.member(id)?.name ?? id : "nobody");
  switch (e.type) {
    case "issue.created": return `${who} created the issue`;
    case "issue.assigned": return d.to ? `${who} assigned it to ${name(d.to)}` : `${who} unassigned it`;
    case "issue.status_changed": return `${who} moved it from ${d.fromName ?? "?"} to ${d.toName}`;
    case "issue.relation_added": return `${who} added a relation`;
    case "issue.relation_removed": return `${who} removed a relation`;
    case "issue.deleted": return `${who} deleted the issue`;
    case "attachment.added": return `${who} attached ${d.name}`;
    case "attachment.removed": return `${who} removed ${d.name}`;
    case "issue.updated": {
      const field = String(d.field ?? "");
      if (field === "priority") return `${who} set priority to ${PRIORITIES[Number(d.to)]?.label ?? d.to}`;
      if (field === "labelIds") return `${who} changed labels`;
      if (field === "description") return `${who} edited the description`;
      if (field === "title") return `${who} renamed it to “${d.to}”`;
      if (field === "dueDate") return d.to ? `${who} set the due date to ${d.to}` : `${who} removed the due date`;
      return `${who} changed ${field.replace(/Id$/, "")}`;
    }
    default: return `${who}: ${e.type}`;
  }
}

