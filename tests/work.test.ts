/**
 * Work management on a realistic workspace (900 seeded issues, 3 teams, projects, cycles,
 * relations, comments): lists, board, filters, pagination, search, cycles, projects, attention,
 * and concurrency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { makeTeam, refused, world, type World } from "./helpers.js";

const TODAY = "2026-11-14";

async function seeded(): Promise<World> {
  const w = await world();
  const r = await w.as("ada", w.acme).mutation(api.seed.demo, { issuesPerTeam: 300, today: TODAY });
  assert.deepEqual([r.teams, r.issues], [3, 900]);
  return w;
}

type Row = Awaited<ReturnType<ReturnType<World["as"]>["query"]>> & any;

test("pagination returns every matching issue exactly once, for every sort", async () => {
  const w = await seeded();
  try {
    const ada = w.as("ada", w.acme);
    const all = (await ada.query(api.issues.list, { limit: 1000 })) as Row;
    assert.equal(all.total, 900);
    for (const sort of ["manual", "priority", "updated", "created", "due", "key"] as const) {
      const seen: string[] = [];
      for (let offset = 0; ; offset += 37) {
        const page = (await ada.query(api.issues.list, { sort, offset, limit: 37 })) as Row;
        assert.equal(page.total, 900);
        seen.push(...page.items.map((i: { id: string }) => i.id));
        if (offset + 37 >= page.total) break;
      }
      assert.equal(seen.length, 900, sort);
      assert.equal(new Set(seen).size, 900, `${sort}: no duplicates across pages`);
    }
  } finally {
    await w.t.close();
  }
});

test("filters agree with a brute-force reading of the same data", async () => {
  const w = await seeded();
  try {
    const ada = w.as("ada", w.acme);
    const all = ((await ada.query(api.issues.list, { limit: 1000 })) as Row).items as Array<Record<string, any>>;
    const teams = await ada.query(api.teams.list);
    const eng = teams.find((t) => t.key === "ENG")!;
    const projects = await ada.query(api.projects.list, { teamId: eng.id });
    const cycles = await ada.query(api.cycles.list, { teamId: eng.id, today: TODAY });
    const labels = await ada.query(api.labels.list);
    const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();
    const check = async (args: Record<string, unknown>, oracle: (i: Record<string, any>) => boolean) => {
      const got = ((await ada.query(api.issues.list, { ...args, limit: 1000 } as never)) as Row).items;
      const want = all.filter(oracle);
      assert.ok(want.length > 0, `filter ${JSON.stringify(args)} selects something`);
      assert.deepEqual(ids(got), ids(want as Array<{ id: string }>), JSON.stringify(args));
    };
    await check({ teamId: eng.id }, (i) => i.teamId === eng.id);
    await check({ projectId: projects[0]!.id }, (i) => i.projectId === projects[0]!.id);
    await check({ cycleId: cycles[1]!.id }, (i) => i.cycleId === cycles[1]!.id);
    await check({ assigneeId: "grace" }, (i) => i.assigneeId === "grace");
    await check({ assigneeId: "none" }, (i) => !i.assigneeId);
    await check({ priorities: [1, 2] }, (i) => i.priority === 1 || i.priority === 2);
    await check({ categories: ["started"] }, (i) => i.category === "started");
    await check({ labelIds: [labels[0]!.id] }, (i) => i.labelIds.includes(labels[0]!.id));
    await check({ types: ["bug"] }, (i) => i.type === "bug");
    await check({ teamId: eng.id, assigneeId: "grace", categories: ["unstarted", "started"], priorities: [0, 1, 2, 3] }, (i) => i.teamId === eng.id && i.assigneeId === "grace" && ["unstarted", "started"].includes(i.category) && i.priority <= 3);
    await check({ text: "billing" }, (i) => i.title.toLowerCase().includes("billing"));
    await check({ topLevelOnly: true, teamId: eng.id }, (i) => !i.parentId && i.teamId === eng.id);
  } finally {
    await w.t.close();
  }
});

test("board and list read the same state: the board's columns partition the list", async () => {
  const w = await seeded();
  try {
    const ada = w.as("ada", w.acme);
    const eng = (await ada.query(api.teams.list)).find((t) => t.key === "ENG")!;
    const list = ((await ada.query(api.issues.list, { teamId: eng.id, limit: 1000 })) as Row).items as Array<{ id: string; stateId: string }>;
    let columnTotal = 0;
    for (const st of eng.states) {
      const column = ((await ada.query(api.issues.list, { teamId: eng.id, stateIds: [st.id], limit: 1000 })) as Row).items as Array<{ id: string }>;
      assert.deepEqual(column.map((c) => c.id).sort(), list.filter((i) => i.stateId === st.id).map((i) => i.id).sort(), st.name);
      columnTotal += column.length;
    }
    assert.equal(columnTotal, list.length);
    // A drag on the board is a status change everyone's list sees.
    const target = list.find((i) => i.stateId !== eng.states[2]!.id)!;
    await w.as("grace", w.acme).mutation(api.issues.move, { issueId: target.id, stateId: eng.states[2]!.id, sortOrder: 1 });
    const moved = ((await ada.query(api.issues.list, { teamId: eng.id, stateIds: [eng.states[2]!.id], sort: "manual", direction: "asc", limit: 1 })) as Row).items[0];
    assert.equal(moved.id, target.id);
  } finally {
    await w.t.close();
  }
});

test("search by identifier and by title words", async () => {
  const w = await seeded();
  try {
    const grace = w.as("grace", w.acme);
    const [hit] = await grace.query(api.issues.search, { text: "eng-42" });
    assert.equal(hit!.key, "ENG-42");
    assert.deepEqual(await grace.query(api.issues.search, { text: "ENG-99999" }), []);
    const words = await grace.query(api.issues.search, { text: "billing page", limit: 50 });
    assert.ok(words.length > 0);
    assert.ok(words.every((i) => /billing page/i.test(i.title)));
    // Grace is not in the private OPS team: its issues never come back.
    assert.ok(words.every((i) => !i.key.startsWith("OPS-")));
    assert.deepEqual(await grace.query(api.issues.search, { text: "OPS-1" }), []);
  } finally {
    await w.t.close();
  }
});

test("cycles: progress, adding and removing issues, overlap, team boundary", async () => {
  const w = await world();
  try {
    const { teamId, state } = await makeTeam(w, w.acme, "ada", "ENG");
    const other = await makeTeam(w, w.acme, "ada", "DES");
    const ada = w.as("ada", w.acme);
    const cycleId = await ada.mutation(api.cycles.create, { teamId, startDate: "2026-11-09", endDate: "2026-11-22" });
    await refused(ada.mutation(api.cycles.create, { teamId, startDate: "2026-11-20", endDate: "2026-11-30" }), "FAILED_PRECONDITION");
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await ada.mutation(api.issues.create, { teamId, title: `t${i}`, estimate: i + 1 })).id);
    await ada.mutation(api.cycles.addIssues, { cycleId, issueIds: ids });
    await ada.mutation(api.issues.setStatus, { issueId: ids[0]!, status: "completed" });
    await ada.mutation(api.issues.setStatus, { issueId: ids[1]!, status: "started" });
    await ada.mutation(api.issues.setStatus, { issueId: ids[2]!, status: "canceled" });
    await ada.mutation(api.cycles.removeIssues, { cycleId, issueIds: [ids[5]!] });
    const c = await ada.query(api.cycles.get, { cycleId, today: "2026-11-14" });
    assert.equal(c.phase, "active");
    assert.deepEqual(c.progress, { scope: 4, completed: 1, started: 1, points: 1 + 2 + 4 + 5, pointsDone: 1, percent: 25 });
    assert.deepEqual(c.history.map((h) => h.type).filter((t) => t !== "cycle.created").length, 7);
    const foreign = (await ada.mutation(api.issues.create, { teamId: other.teamId, title: "design" })).id;
    await refused(ada.mutation(api.cycles.addIssues, { cycleId, issueIds: [foreign] }), "INVALID_ARGUMENT");
    void state;
  } finally {
    await w.t.close();
  }
});

test("projects: progress per milestone, overdue, history", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const projectId = await ada.mutation(api.projects.create, { teamId, name: "Launch", startDate: "2026-10-01", targetDate: "2026-11-01" });
    await refused(ada.mutation(api.projects.update, { projectId, targetDate: "2026-09-01" }), "INVALID_ARGUMENT");
    const alpha = await ada.mutation(api.projects.addMilestone, { projectId, name: "Alpha" });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await ada.mutation(api.issues.create, { teamId, title: `p${i}`, projectId, ...(i < 2 ? { milestoneId: alpha } : {}) })).id);
    await ada.mutation(api.issues.close, { issueId: ids[0]! });
    await ada.mutation(api.projects.update, { projectId, status: "started" });
    const p = await ada.query(api.projects.summary, { projectId });
    assert.equal(p.progress.total, 4);
    assert.equal(p.progress.completed, 1);
    assert.equal(p.milestones[0]!.progress.percent, 50);
    assert.equal(p.unassignedToMilestone.total, 2);
    assert.equal(p.overdue, true);
    assert.deepEqual(p.history.map((h) => h.type), ["project.created", "project.milestone_added", "project.status_changed"]);
    // Removing the milestone keeps its issues in the project.
    await ada.mutation(api.projects.removeMilestone, { milestoneId: alpha });
    assert.equal((await ada.query(api.projects.summary, { projectId })).unassignedToMilestone.total, 4);
  } finally {
    await w.t.close();
  }
});

test("attention: overdue and blocked work agree with a brute-force reading", async () => {
  const w = await seeded();
  try {
    const ada = w.as("ada", w.acme);
    const all = ((await ada.query(api.issues.list, { limit: 1000 })) as Row).items as Array<Record<string, any>>;
    const open = new Map(all.filter((i) => ["backlog", "unstarted", "started"].includes(i.category)).map((i) => [i.id, i]));
    const { overdue, blocked } = await ada.query(api.issues.attention, { today: TODAY });
    assert.deepEqual(overdue.map((i) => i.id).sort(), [...open.values()].filter((i) => i.dueDate && i.dueDate < TODAY).map((i) => i.id).sort());
    let expectedBlocked = 0;
    for (const i of open.values()) {
      const detail = await ada.query(api.issues.get, { issueId: i.id });
      if (detail.blockedBy.some((b) => open.has(b.id))) expectedBlocked++;
    }
    assert.equal(blocked.length, expectedBlocked);
    assert.ok(overdue.length > 0 && blocked.length > 0, "the realistic dataset exercises both");
  } finally {
    await w.t.close();
  }
});

test("concurrent changes: numbers stay gapless; racing edits never lose a write silently", async () => {
  const w = await world();
  try {
    const { teamId } = await makeTeam(w, w.acme, "ada", "ENG");
    const ada = w.as("ada", w.acme);
    const grace = w.as("grace", w.acme);
    // 25 creates at once in one team: the sequence serializes them; each re-runs instead of failing.
    const made = await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? ada : grace).mutation(api.issues.create, { teamId, title: `c${i}` })));
    assert.deepEqual(made.map((m) => Number(m.key.split("-")[1])).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));

    const issueId = made[0]!.id;
    // Two people edit the same issue at once. Each write either commits or is refused as a
    // retryable CONFLICT; none is lost silently, and the history matches what committed.
    const results = await Promise.allSettled([
      ada.mutation(api.issues.update, { issueId, priority: 1 }),
      grace.mutation(api.issues.update, { issueId, title: "renamed" }),
      ada.mutation(api.issues.assign, { issueId, assigneeId: "grace" }),
      grace.mutation(api.issues.setStatus, { issueId, status: "started" }),
    ]);
    const outcomes = results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code: string }).code));
    assert.ok(outcomes.includes("CONFLICT"), `the edits really raced (measured: ${outcomes})`);
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { retryable?: boolean }).retryable, true);
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, "CONFLICT");
    const issue = await ada.query(api.issues.get, { issueId });
    const committed = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(issue.history.filter((h) => h.type !== "issue.created").length, committed);
    assert.equal(issue.__version, 1 + committed);

    // A stale editor (expectedVersion) is refused rather than overwriting.
    await ada.mutation(api.issues.update, { issueId, title: "v-latest", expectedVersion: issue.__version });
    await refused(grace.mutation(api.issues.update, { issueId, title: "stale", expectedVersion: issue.__version }), "CONFLICT");
    assert.equal((await ada.query(api.issues.get, { issueId })).title, "v-latest");
  } finally {
    await w.t.close();
  }
});

test("a restart keeps a realistic workspace exactly as it was", async () => {
  const w = await seeded();
  try {
    let sample: string[] = [];
    const snapshot = async () => {
      const ada = w.as("ada", w.acme);
      const list = ((await ada.query(api.issues.list, { limit: 1000, sort: "key" })) as Row).items as Array<Record<string, unknown>>;
      if (!sample.length) sample = list.filter((_, i) => i % 37 === 0).map((i) => i.id as string); // 25 issues, chosen once
      return {
        list: list.map((i) => [i.id, i.key, i.stateId, i.assigneeId ?? null, i.__version]),
        details: await Promise.all(sample.map((issueId) => ada.query(api.issues.get, { issueId }))),
        attention: await ada.query(api.issues.attention, { today: TODAY }),
        teams: await ada.query(api.teams.list),
        projects: await ada.query(api.projects.list, {}),
      };
    };
    const before = await snapshot();
    // A write just before the restart must survive it too, and numbering must continue.
    const eng = before.teams.find((t) => t.key === "ENG")!;
    const made = await w.as("grace", w.acme).mutation(api.issues.create, { teamId: eng.id, title: "Written just before restart" });
    await w.t.restart();
    const after = await snapshot();
    assert.deepEqual(after.list.filter((r) => r[0] !== made.id), before.list);
    assert.deepEqual(after.details, before.details);
    assert.deepEqual(after.attention, before.attention);
    assert.deepEqual(after.projects, before.projects);
    assert.equal(made.key, "ENG-301");
    assert.equal((await w.as("ada", w.acme).mutation(api.issues.create, { teamId: eng.id, title: "after" })).key, "ENG-302");
  } finally {
    await w.t.close();
  }
});
