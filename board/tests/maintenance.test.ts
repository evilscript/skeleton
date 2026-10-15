import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { COMMENT_ERRORS, commentBodyError } from "../public/board/comment-rules.js";
import { boardUsage, insightPeriod, summarizeInsights } from "../cli/usage.mjs";
import { expiredBackups, outsideRepo } from "../scripts/backup.mjs";
import { database, DEV, LEAD, OTHER, QA } from "./support.ts";

test("simultaneous posts admit exactly 60, keep unique IDs and counts, and isolate authors", async () => {
  const { sqlite, request } = database();
  try {
    const responses = await Promise.all(Array.from({ length: 80 }, () => request("/api/cards/1/comments", "POST", { body: "same text" })));
    assert.equal(responses.filter((r) => r.status === 201).length, 60);
    assert.equal(responses.filter((r) => r.status === 429).length, 20);
    const ids = await Promise.all(responses.filter((r) => r.ok).map(async (r) => (await r.json() as { id: number }).id));
    assert.equal(new Set(ids).size, 60);
    const rejected = responses.find((r) => r.status === 429)!;
    assert.ok(Number(rejected.headers.get("retry-after")) > 0);
    assert.deepEqual(await rejected.json(), { error: "comment_rate_limit", message: COMMENT_ERRORS.comment_rate_limit });
    assert.equal(sqlite.prepare("SELECT count FROM comment_limits WHERE key LIKE ?").get(`comment:${DEV}:%`)?.count, 60);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "another author" }, OTHER)).status, 201);
    assert.equal(sqlite.prepare("SELECT comment_count FROM cards WHERE no=1").get()?.comment_count, 61);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get()?.n, 61);
  } finally { sqlite.close(); }
});

test("invalid UTF-8 bodies use the shared error before consuming quota", async () => {
  const { sqlite, request } = database();
  try {
    const response = await request("/api/cards/1/comments", "POST", { body: "😀".repeat(1025) });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "comment_too_long", message: COMMENT_ERRORS.comment_too_long });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM comment_limits").get()?.n, 0);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "😀".repeat(1024) })).status, 201);
    assert.equal(commentBodyError("a".repeat(4096)), "");
    assert.equal(commentBodyError("\u20ac".repeat(1366)), "comment_too_long");
  } finally { sqlite.close(); }
});

test("failed transactions roll back quota, and a new UTC hour has its own quota", async () => {
  const { sqlite, DB } = database();
  try {
    const insert = DB.prepare(`INSERT INTO comments(card_no,author,body,created_at) VALUES (1,'${LEAD}','test',?)`);
    await assert.rejects(DB.batch([insert.bind("2026-10-02T23:59:59Z"), DB.prepare("INSERT INTO missing VALUES (1)")]));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM comment_limits").get()?.n, 0);
    const count = DB.prepare("UPDATE cards SET comment_count=comment_count+1 WHERE no=1");
    for (let i = 0; i < 60; i++) await DB.batch([insert.bind("2026-10-02T23:59:59Z"), count]);
    await assert.rejects(DB.batch([insert.bind("2026-10-02T23:59:59Z"), count]), /comment_rate_limit/);
    await DB.batch([insert.bind("2026-10-03T00:00:00Z"), count]);
    assert.equal(sqlite.prepare("SELECT comment_count FROM cards WHERE no=1").get()?.comment_count, 61);
  } finally { sqlite.close(); }
});

test("old Worker batches keep the card count accurate after migration", async () => {
  const { sqlite, DB, request } = database();
  try {
    await DB.batch([
      DB.prepare(`INSERT INTO comments(card_no,author,body,created_at) VALUES (1,'${LEAD}','old worker','2026-10-02T23:59:59Z')`),
      DB.prepare("UPDATE cards SET comment_count=comment_count+1 WHERE no=1"),
    ]);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "new worker" })).status, 201);
    assert.equal(sqlite.prepare("SELECT comment_count FROM cards WHERE no=1").get()?.comment_count, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get()?.n, 2);
  } finally { sqlite.close(); }
});

test("chip counts match the old scan after card edits, moves, removal, restore, rename and deletion", async () => {
  const { sqlite, request } = database();
  const expected = () => {
    const rows = sqlite.prepare("SELECT name, used, (SELECT COUNT(*) FROM cards c, json_each(c.chips) j WHERE c.project_id=chips.project_id AND c.removed_at IS NULL AND j.value=chips.name) AS expected FROM chips").all();
    for (const row of rows) assert.equal(row.used, row.expected, row.name as string);
  };
  try {
    assert.equal((await request("/api/cards/1", "PATCH", { chips: ["Bug", "Feature", "new chip"] })).status, 200); expected();
    assert.equal((await request("/api/cards/1", "PATCH", { col: "done" })).status, 200); expected();
    assert.equal((await request("/api/cards/1", "DELETE")).status, 200); expected();
    assert.equal((await request("/api/cards/1/restore", "POST")).status, 200); expected();
    assert.equal((await request("/api/chips/Bug", "PATCH", { name: "Renamed" })).status, 200); expected();
    assert.equal((await request("/api/chips/Feature", "DELETE")).status, 200); expected();
    assert.equal((await request("/api/cards/1", "PATCH", { chips: [] })).status, 200); expected();
    sqlite.exec("UPDATE cards SET chips='[\"Renamed\"]' WHERE no=1; DELETE FROM cards WHERE no=1"); expected();
    const response = await request("/api/chips?counts=1");
    assert.equal(response.status, 200);
    assert.ok((await response.json() as { chips: { used: number }[] }).chips.every((c) => c.used === 0));
  } finally { sqlite.close(); }
});

test("old Worker chip rename batches remain accurate after migration", async () => {
  const { sqlite, DB, request } = database();
  try {
    assert.equal((await request("/api/cards/1", "PATCH", { chips: ["Bug"] })).status, 200);
    await DB.batch([
      DB.prepare("UPDATE chips SET name='OldWorkerRename' WHERE name='Bug'"),
      DB.prepare("UPDATE cards SET chips='[\"OldWorkerRename\"]' WHERE no=1"),
    ]);
    assert.equal(sqlite.prepare("SELECT used FROM chips WHERE name='OldWorkerRename'").get()?.used, 1);
    assert.equal((await request("/api/chips/OldWorkerRename", "PATCH", { name: "NewWorkerRename" })).status, 200);
    assert.equal(sqlite.prepare("SELECT used FROM chips WHERE name='NewWorkerRename'").get()?.used, 1);
  } finally { sqlite.close(); }
});

test("a new card starts in backlog; a status moves it, `col` follows it, and the column counts follow `col`", async () => {
  const { sqlite, request } = database();
  const read = (no: number) => sqlite.prepare("SELECT col,status FROM cards WHERE no=?").get(no) as { col: string; status: string };
  const count = (col: string) => Number(sqlite.prepare("SELECT n FROM column_counts WHERE project_id=1 AND col=?").get(col)?.n ?? 0);
  const patch = async (no: number, body: unknown) => (await request(`/api/cards/${no}`, "PATCH", body)).status;
  try {
    const made = await request("/api/cards", "POST", { title: "Starts in backlog" });
    assert.equal(made.status, 201);
    const no = (await made.json() as { no: number }).no;
    assert.deepEqual({ ...read(no) }, { col: "backlog", status: "backlog" });
    // To do is a status of the Backlog column: the card stays where it is, the counts don't move.
    assert.equal(await patch(no, { status: "todo" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "backlog", status: "todo" });
    assert.equal(count("backlog"), 2); assert.equal(count("todo"), 0);
    const listed = async (query: string) => (await (await request("/api/cards" + query)).json() as { cards: { no: number; status: string; col: string }[] }).cards;
    assert.deepEqual((await listed("?status=todo")).map((c) => c.no), [no]);
    assert.deepEqual((await listed("?col=todo")).map((c) => c.no), [no], "the old todo column is the todo status");
    assert.deepEqual((await listed("?col=backlog")).map((c) => c.no).sort(), [1, no], "the Backlog column shows backlog and todo");
    assert.deepEqual((await listed("?status=todo"))[0], { ...(await listed("?status=todo"))[0], status: "todo", col: "backlog" });
    // In progress holds three statuses; moving between them leaves the counts alone.
    assert.equal(await patch(no, { status: "progress" }), 200);
    assert.equal(count("backlog"), 1); assert.equal(count("progress"), 1);
    for (const status of ["pr_review", "on_main"]) {
      assert.equal(await patch(no, { status }), 200);
      assert.deepEqual({ ...read(no) }, { col: "progress", status });
      assert.equal(count("progress"), 1);
    }
    // Ready for QA holds two.
    assert.equal(await patch(no, { status: "on_prod_qa" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "testing", status: "on_prod_qa" });
    assert.equal(await patch(no, { status: "qa_later" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "testing", status: "qa_later" });
    assert.equal(count("progress"), 0); assert.equal(count("testing"), 1);
    // The old words keep working: a column name means its first status, later means qa_later.
    assert.equal(await patch(no, { col: "progress" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "progress", status: "progress" });
    assert.equal(await patch(no, { col: "testing" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "testing", status: "on_prod_qa" });
    assert.equal(await patch(no, { col: "later" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "testing", status: "qa_later" });
    assert.equal(await patch(no, { col: "todo" }), 200);
    assert.deepEqual({ ...read(no) }, { col: "backlog", status: "todo" });
    // Both together are fine when they agree, an error when they don't; nothing changes on an error.
    assert.equal(await patch(no, { status: "pr_review", col: "progress" }), 200);
    assert.equal(await patch(no, { status: "done", col: "progress" }), 400);
    assert.equal(await patch(no, { status: "waiting" }), 400);
    assert.equal(await patch(no, { status: 3 }), 400);
    assert.equal(await patch(no, { col: "waiting" }), 400);
    assert.deepEqual({ ...read(no) }, { col: "progress", status: "pr_review" });
    // Every change is in the card's activity as a status change.
    const activity = (await (await request(`/api/cards/${no}`)).json() as { activity: { action: string; detail: string }[] }).activity;
    assert.ok(activity.some((a) => a.action === "status" && a.detail === "todo → progress"));
    assert.ok(activity.some((a) => a.action === "status" && a.detail === "progress → pr_review"));
    // The card JSON carries both.
    const one = (await (await request(`/api/cards/${no}`)).json() as { card: { status: string; col: string } }).card;
    assert.deepEqual([one.status, one.col], ["pr_review", "progress"]);
    // Creating takes either, and a conflict is refused.
    const create = async (body: unknown) => request("/api/cards", "POST", body);
    const mk = async (body: unknown) => { const r = await create(body); assert.equal(r.status, 201); return (await r.json() as { no: number }).no; };
    assert.deepEqual({ ...read(await mk({ title: "a", status: "on_main" })) }, { col: "progress", status: "on_main" });
    assert.deepEqual({ ...read(await mk({ title: "b", col: "testing" })) }, { col: "testing", status: "on_prod_qa" });
    assert.deepEqual({ ...read(await mk({ title: "c", col: "later" })) }, { col: "testing", status: "qa_later" });
    assert.deepEqual({ ...read(await mk({ title: "d", status: "todo" })) }, { col: "backlog", status: "todo" });
    assert.equal((await create({ title: "e", status: "todo", col: "done" })).status, 400);
    assert.equal((await create({ title: "f", status: "nope" })).status, 400);
    for (const row of sqlite.prepare("SELECT project_id,col,n,(SELECT COUNT(*) FROM cards c WHERE c.project_id=column_counts.project_id AND c.col=column_counts.col AND c.removed_at IS NULL) AS expected FROM column_counts").all())
      assert.equal(row.n, row.expected, `${row.project_id}/${row.col}`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cards WHERE col IN ('todo','later')").get()?.n, 0, "todo and later are never stored in col");
  } finally { sqlite.close(); }
});

test("a card moved to another layer of its column goes to the top of the column; an explicit sort is kept", async () => {
  const { sqlite, request } = database();
  const sort = (no: number) => Number(sqlite.prepare("SELECT sort FROM cards WHERE no=?").get(no)?.sort);
  try {
    const nos: number[] = [];
    for (const status of ["progress", "pr_review", "progress"]) nos.push((await (await request("/api/cards", "POST", { title: status, status })).json() as { no: number }).no);
    assert.ok(sort(nos[0]) < sort(nos[1]) && sort(nos[1]) < sort(nos[2]));
    await request(`/api/cards/${nos[0]}`, "PATCH", { status: "on_main" });
    assert.ok(sort(nos[0]) > sort(nos[2]), "now the top of In progress");
    await request(`/api/cards/${nos[1]}`, "PATCH", { status: "on_main", sort: 1.5 });
    assert.equal(sort(nos[1]), 1.5);
    // A reorder inside a layer is a sort alone: no status change, no activity line for it.
    await request(`/api/cards/${nos[2]}`, "PATCH", { sort: 99 });
    assert.equal(sort(nos[2]), 99);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM activity WHERE card_no=? AND action='status'").get(nos[2])?.n, 0);
  } finally { sqlite.close(); }
});

test("the card shows its column's first status when a stored status doesn't belong to the stored column", async () => {
  const { sqlite, request } = database();
  try {
    sqlite.exec("UPDATE cards SET col='done' WHERE no=1"); // a hand edit or an old restore: col moved, status stayed backlog
    const card = (await (await request("/api/cards/1")).json() as { card: { status: string; col: string } }).card;
    assert.deepEqual([card.col, card.status], ["done", "done"]);
  } finally { sqlite.close(); }
});

test("card numbers are global: a new project's first card continues the other project's numbering", async () => {
  const { sqlite, request } = database();
  try {
    sqlite.exec("INSERT INTO cards(no,project_id,col,title,chips,created_at,updated_at) VALUES (2000,1,'backlog','high number','[]','2026-10-03T12:00:00Z','2026-10-03T12:00:00Z')");
    assert.equal((await request("/api/projects", "POST", { name: "Second board", key: "second-board" })).status, 201);
    const first = await request("/api/cards", "POST", { title: "First card of the new project", project: "second-board" });
    assert.equal(first.status, 201);
    assert.equal((await first.json() as { no: number }).no, 2001);
    const back = await request("/api/cards", "POST", { title: "Back in the first project" });
    assert.equal((await back.json() as { no: number }).no, 2002);
  } finally { sqlite.close(); }
});

test("project chip APIs, comment feeds and quota remain isolated after main reconciliation", async () => {
  const { sqlite, request, queries } = database();
  try {
    assert.equal((await request("/api/projects", "POST", { name: "Maintenance project", key: "maintenance-project" })).status, 201);
    const created = await request("/api/cards", "POST", { title: "Other project", project: "maintenance-project", chips: ["Bug"] });
    assert.equal(created.status, 201);
    const no = (await created.json() as { no: number }).no;
    assert.equal((await request("/api/cards/1", "PATCH", { chips: ["Bug"] })).status, 200);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "Default project" })).status, 201);
    assert.equal((await request(`/api/cards/${no}/comments`, "POST", { body: "Other project" })).status, 201);
    assert.equal(sqlite.prepare("SELECT project_id FROM comments WHERE card_no=?").get(no)?.project_id, 2);
    for (const [project, card] of [["main", 1], ["maintenance-project", no]] as const) {
      const feed = await (await request(`/api/comments?project=${project}`)).json() as { comments: { cardNo: number }[] };
      assert.deepEqual(feed.comments.map((m) => m.cardNo), [card]);
      const thread = await (await request(`/api/cards/${card}/comments`)).json() as { comments: { cardNo: number }[] };
      assert.deepEqual(thread.comments.map((m) => m.cardNo), [card]);
      const version = await (await request(`/api/version?project=${project}`)).json() as { c: number };
      assert.equal(version.c, card === 1 ? 1 : 2);
    }
    const all = await (await request(`/api/comments?project=all&to=${DEV}`)).json() as { comments: unknown[] };
    assert.equal(all.comments.length, 0); // No addressed comments; no cursor changes.
    const combined = await (await request("/api/comments?project=all")).json() as { comments: unknown[] };
    assert.equal(combined.comments.length, 2);
    assert.equal((await request("/api/chips/Bug?project=maintenance-project", "PATCH", { name: "Other bug" })).status, 200);
    assert.equal(sqlite.prepare("SELECT used FROM chips WHERE project_id=1 AND name='Bug'").get()?.used, 1);
    assert.equal(sqlite.prepare("SELECT used FROM chips WHERE project_id=2 AND name='Other bug'").get()?.used, 1);
    queries.length = 0;
    const chips = await (await request("/api/chips?counts=1&project=maintenance-project")).json() as { chips: { name: string; used: number }[] };
    assert.equal(chips.chips.find((c) => c.name === "Other bug")?.used, 1);
    assert.ok(!queries.some((sql) => /\bcards\b|json_each/i.test(sql)), "Chip statistics must not scan cards");
    // Switching project cannot grant an author a second hourly allowance.
    for (let i = 2; i < 60; i++)
      assert.equal((await request(`/api/cards/${i % 2 ? no : 1}/comments`, "POST", { body: "quota" })).status, 201);
    assert.equal((await request(`/api/cards/${no}/comments`, "POST", { body: "over quota" })).status, 429);
    assert.equal(sqlite.prepare("SELECT SUM(comment_count) AS n FROM cards").get()?.n, 60);
  } finally { sqlite.close(); }
});

test("column counts follow create, move, remove and restore", async () => {
  const { sqlite, request, queries } = database();
  const consistent = () => {
    for (const row of sqlite.prepare("SELECT project_id,col,n,(SELECT COUNT(*) FROM cards c WHERE c.project_id=column_counts.project_id AND c.col=column_counts.col AND c.removed_at IS NULL) AS expected FROM column_counts").all())
      assert.equal(row.n, row.expected, `${row.project_id}/${row.col}`);
  };
  try {
    const create = await request("/api/cards", "POST", { title: "New done card", col: "done", chips: ["Bug"] });
    assert.equal(create.status, 201);
    const no = (await create.json() as { no: number }).no;
    consistent();
    for (const [path, method, body] of [
      [`/api/cards/${no}`, "PATCH", { col: "progress" }],
      [`/api/cards/${no}`, "DELETE", undefined],
      [`/api/cards/${no}`, "DELETE", undefined],
      [`/api/cards/${no}`, "PATCH", { col: "done" }],
      [`/api/cards/${no}/restore`, "POST", undefined],
      [`/api/cards/${no}/restore`, "POST", undefined],
    ] as const) { assert.equal((await request(path, method, body)).status, 200); consistent(); }
    queries.length = 0;
    const list = await (await request("/api/cards?hide=done&version=1&chips=1")).json() as { cards: { no: number }[]; hidden: { count: number }; version: unknown; chips: unknown[] };
    assert.equal(list.hidden.count, 1);
    assert.ok(!list.cards.some((c) => c.no === no));
    assert.ok(list.version && list.chips);
    assert.ok(queries.findIndex((sql) => /MAX\(updated_at\)/.test(sql)) < queries.findIndex((sql) => /substr\(c.description/.test(sql))); // Version is captured before card reads.
    assert.ok(!queries.some((sql) => /COUNT\(\*\)/i.test(sql)), "Refresh must use stored column/chip counts");
    const filePlan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT SUM(kind='screenshot'),MIN(created_at || ' ' || id) FROM files WHERE card_no=1").all();
    assert.ok(filePlan.some((row) => /COVERING INDEX files_card_stats/.test(String(row.detail))));
  } finally { sqlite.close(); }
});

test("usage rounds to today's UTC hourly buckets, sums all queries, and marks truncation", () => {
  for (const [time, period] of [["2026-10-03T00:00:00.000Z", "1m"], ["2026-10-03T01:14:23.000Z", "75m"], ["2026-10-03T23:59:59.999Z", "1440m"]])
    assert.equal(insightPeriod(new Date(time)), period);
  const rows = [{ totalRowsRead: 123, totalRowsWritten: 12 }, { totalRowsRead: 345, totalRowsWritten: 34 }];
  const out = summarizeInsights(rows, new Date("2026-10-03T01:14:23Z"), 2);
  assert.equal(out.rowsRead, 468); assert.equal(out.rowsWritten, 46); assert.equal(out.partial, true);
  assert.throws(() => summarizeInsights([{ totalRowsRead: 1 }], new Date()), /omitted/);
  assert.throws(() => boardUsage(new Date(), () => { throw new Error("secret credential diagnostic"); }), /usage unavailable/);
  let args: readonly string[] = [];
  boardUsage(new Date("2026-10-03T01:14:23Z"), (_file, options) => { args = options; return JSON.stringify(rows); });
  assert.ok(args.includes("10000")); assert.ok(args.includes("75m"));
});

test("backup retention keeps 14 UTC dates and only deletes its own files outside the repo", () => {
  const year = "2030"; // fixture dates are built from a base year so it is plain they are not real events
  const old = `board-${year}-01-01.sql`;
  assert.deepEqual(expiredBackups([old, old + ".json", `board-${year}-01-02.sql`, "other.sql", `board-${year}-01-15.sql.partial`], `${year}-01-15`), [old, old + ".json"]);
  assert.throws(() => outsideRepo("backups"), /absolute/);
  assert.throws(() => outsideRepo(fileURLToPath(new URL("../backups", import.meta.url))), /outside/);
  assert.ok(outsideRepo(join(tmpdir(), "board-backup-test")).endsWith("board-backup-test"));
});

test("the QA agent (a limited key) reads everything, adds notes to cards and can do nothing else", { skip: !QA && "no limited agent in src/agents.ts" }, async () => {
  const { sqlite, request } = database();
  try {
    const as = QA;
    assert.equal((await request("/api/cards", "GET", undefined, as)).status, 200);
    assert.equal((await request("/api/comments?project=all&type=review", "GET", undefined, as)).status, 200);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "QA passed" }, as)).status, 201);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "stuck", type: "blocked", to: LEAD }, as)).status, 201);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "x", type: "decision", to: LEAD }, as)).status, 403);
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "x", type: "assign", to: DEV }, as)).status, 403);
    assert.equal((await request("/api/cards", "POST", { title: "no" }, as)).status, 403);
    assert.equal((await request("/api/cards/1", "PATCH", { col: "done" }, as)).status, 403);
    assert.equal((await request("/api/cards/1", "DELETE", undefined, as)).status, 403);
    assert.equal(sqlite.prepare("SELECT col FROM cards WHERE no=1").get()?.col, "backlog");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM comments WHERE author=?").get(as)?.n, 2);
    // the others are not limited
    assert.equal((await request("/api/cards/1/comments", "POST", { body: "ok", type: "decision", to: DEV }, LEAD)).status, 201);
  } finally { sqlite.close(); }
});

test("GET /api/info is public and gives the project name, the file storage and the language; without a name it says Board", async () => {
  const { sqlite, env } = database();
  try {
    const ask = (e: typeof env) => worker.fetch(new Request("http://localhost/api/info"), e);
    const plain = await ask(env);
    assert.equal(plain.status, 200);
    assert.deepEqual(await plain.json(), { projectName: "Board", files: true, fileStorage: "r2", maxFileBytes: 25 * 1024 * 1024, language: "en", access: "private" });
    const named = await ask({ ...env, PROJECT_NAME: "Example Project", BOARD_LANGUAGE: "zh-CN" });
    assert.deepEqual(await named.json(), { projectName: "Example Project", files: true, fileStorage: "r2", maxFileBytes: 25 * 1024 * 1024, language: "zh-CN", access: "private" });
    // A language that is not a code (a path, a script) is English.
    for (const bad of ["", "../x", "en/../../x", "<b>", "english language", "e"]) {
      assert.equal(((await (await ask({ ...env, BOARD_LANGUAGE: bad })).json()) as { language: string }).language, "en", bad);
    }
  } finally { sqlite.close(); }
});
