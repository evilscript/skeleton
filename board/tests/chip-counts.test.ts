import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrations = readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
const at = "2026-10-03T12:00:00Z";

function migrate(db: DatabaseSync, through = 11) {
  for (const name of migrations) {
    if (Number(name.slice(0, 4)) <= through)
      db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
}

function withDatabase(fn: (db: DatabaseSync) => void, through = 11) {
  const db = new DatabaseSync(":memory:");
  try { migrate(db, through); fn(db); } finally { db.close(); }
}

function secondProject(db: DatabaseSync) {
  db.prepare("INSERT INTO projects(id,slug,name,created_at) VALUES (2,'other','Other',?)").run(at);
  db.exec("INSERT INTO chips(project_id,name) VALUES (2,'Bug'),(2,'Feature')");
}

function card(db: DatabaseSync, no: number, project: number, chips: string[], removed: string | null = null) {
  db.prepare("INSERT INTO cards(no,project_id,col,title,chips,created_at,updated_at,removed_at) VALUES (?,?,'backlog','test',?,?,?,?)")
    .run(no, project, JSON.stringify(chips), at, at, removed);
}

function counts(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT project_id,name,used FROM chips ORDER BY project_id,name").all()
    .map((row) => [row.project_id + ":" + row.name, row.used]));
}

function checkAgainstCards(db: DatabaseSync) {
  const rows = db.prepare("SELECT project_id,name,used,(SELECT COUNT(*) FROM cards c,json_each(c.chips) j WHERE c.project_id=chips.project_id AND c.removed_at IS NULL AND j.value=chips.name) AS expected FROM chips").all();
  for (const row of rows) assert.equal(row.used, row.expected, row.project_id + ":" + row.name);
}

function rename(db: DatabaseSync, project: number, from: string, to: string) {
  // The deployed pre-0008 Worker renames the chip before rewriting its cards.
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE chips SET name=? WHERE project_id=? AND name=?").run(to, project, from);
    db.prepare("UPDATE cards SET chips=(SELECT json_group_array(CASE WHEN value=? THEN ? ELSE value END) FROM json_each(cards.chips)) WHERE project_id=? AND EXISTS (SELECT 1 FROM json_each(cards.chips) WHERE value=?)")
      .run(from, to, project, from);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("fresh migrations keep the composite chip key and install 0008 to 0013 after deployed migrations", () => {
  assert.deepEqual(migrations.map((name) => name.slice(0, 4)), ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013"]);
  withDatabase((db) => {
    const columns = db.prepare("PRAGMA table_info(chips)").all();
    assert.deepEqual(columns.filter((row) => Number(row.pk) > 0).map((row) => row.name), ["project_id", "name"]);
    secondProject(db);
    card(db, 1, 1, ["Bug"]); card(db, 2, 2, ["Bug", "Feature"]);
    assert.equal(counts(db)["1:Bug"], 1);
    assert.equal(counts(db)["2:Bug"], 1);
    assert.equal(counts(db)["1:Feature"], 0);
    assert.equal(counts(db)["2:Feature"], 1);
    checkAgainstCards(db);
  });
});

test("0008 backfills existing 0007 cards by project, including done but excluding removed", () => {
  withDatabase((db) => {
    secondProject(db);
    card(db, 1, 1, ["Bug", "Feature"]); card(db, 2, 1, ["Bug"]);
    card(db, 3, 2, ["Bug"]); card(db, 4, 2, ["Bug", "Feature"], at);
    db.exec("UPDATE cards SET col='done' WHERE no=2");
    db.exec(readFileSync(new URL("../migrations/0008_quotas_chip_counts.sql", import.meta.url), "utf8"));
    assert.equal(counts(db)["1:Bug"], 2);
    assert.equal(counts(db)["2:Bug"], 1);
    assert.equal(counts(db)["1:Feature"], 1);
    assert.equal(counts(db)["2:Feature"], 0);
    checkAgainstCards(db);
  }, 7);
});

for (const [name, through] of [["0009_priority_assignees.sql", 8], ["0010_todo_column.sql", 9], ["0012_assignee_open.sql", 11]] as const) test(`${name.slice(0, 4)} rebuilds cards without losing the chip-count triggers, the chips trigger or any count`, () => {
  withDatabase((db) => {
    secondProject(db);
    card(db, 1, 1, ["Bug", "Feature"]); card(db, 2, 2, ["Bug"]); card(db, 3, 1, ["Bug"], at);
    const before = counts(db);
    const objects = () => db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('trigger','index') AND name NOT LIKE 'sqlite_auto%' ORDER BY 1,2").all();
    const names = objects();
    db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
    assert.deepEqual(objects(), names);
    assert.deepEqual(counts(db), before);
    checkAgainstCards(db);
    // The triggers still work on the rebuilt table.
    card(db, 4, 1, ["Feature"]);
    assert.equal(counts(db)["1:Feature"], 2);
    db.exec("UPDATE cards SET chips='[\"Bug\"]' WHERE no=4");
    db.exec("DELETE FROM cards WHERE no=1");
    db.exec("UPDATE chips SET name='Defect' WHERE project_id=1 AND name='Bug'");
    checkAgainstCards(db);
  }, through);
});

test("card insert, edits, moves, soft removal, restore and hard deletion leave other projects untouched", () => {
  withDatabase((db) => {
    secondProject(db);
    card(db, 1, 1, ["Bug", "Feature"]); card(db, 2, 2, ["Bug"]);
    const update = db.prepare("UPDATE cards SET chips=? WHERE no=1");
    update.run('["Feature"]');
    assert.equal(counts(db)["1:Bug"], 0); assert.equal(counts(db)["2:Bug"], 1);
    checkAgainstCards(db);
    db.exec("UPDATE cards SET col='done' WHERE no=1"); checkAgainstCards(db);
    db.prepare("UPDATE cards SET removed_at=? WHERE no=1").run(at);
    assert.equal(counts(db)["1:Feature"], 0); checkAgainstCards(db);
    db.exec("UPDATE cards SET removed_at='2026-10-03T13:00:00Z' WHERE no=1"); checkAgainstCards(db);
    update.run('["Bug"]'); checkAgainstCards(db);
    db.exec("UPDATE cards SET removed_at=NULL WHERE no=1");
    assert.equal(counts(db)["1:Bug"], 1); assert.equal(counts(db)["2:Bug"], 1);
    update.run('["Bug"]'); checkAgainstCards(db);
    db.exec("DELETE FROM cards WHERE no=1");
    assert.equal(counts(db)["1:Bug"], 0); assert.equal(counts(db)["2:Bug"], 1);
    card(db, 3, 1, ["Feature"], at); db.exec("DELETE FROM cards WHERE no=3");
    checkAgainstCards(db);
  });
});

test("card project changes subtract the old project and add the new project, also when chips or removal change", () => {
  withDatabase((db) => {
    secondProject(db); card(db, 1, 1, ["Bug"]); card(db, 2, 2, ["Bug"]);
    db.exec("UPDATE cards SET project_id=2 WHERE no=1");
    assert.equal(counts(db)["1:Bug"], 0); assert.equal(counts(db)["2:Bug"], 2); checkAgainstCards(db);
    db.exec("UPDATE cards SET project_id=1,chips='[\"Feature\"]' WHERE no=1");
    assert.equal(counts(db)["1:Feature"], 1); assert.equal(counts(db)["2:Bug"], 1); checkAgainstCards(db);
    db.prepare("UPDATE cards SET project_id=2,removed_at=? WHERE no=1").run(at);
    assert.equal(counts(db)["1:Feature"], 0); assert.equal(counts(db)["2:Feature"], 0); checkAgainstCards(db);
    db.exec("UPDATE cards SET project_id=1 WHERE no=1"); checkAgainstCards(db);
    db.exec("UPDATE cards SET project_id=2,removed_at=NULL WHERE no=1");
    assert.equal(counts(db)["1:Feature"], 0); assert.equal(counts(db)["2:Feature"], 1); checkAgainstCards(db);
  });
});

test("old Worker rename order resets only the renamed project's count before card triggers refill it", () => {
  withDatabase((db) => {
    secondProject(db);
    db.exec("INSERT INTO chips(project_id,name) VALUES (2,'Renamed')");
    card(db, 1, 1, ["Bug"]); card(db, 2, 2, ["Bug", "Renamed"]);
    // A card can already reference the new name before there is a chip row.
    card(db, 3, 1, ["Renamed"]); card(db, 4, 1, ["Bug"], at);
    rename(db, 1, "Bug", "Renamed");
    assert.equal(counts(db)["1:Renamed"], 2);
    assert.equal(counts(db)["2:Bug"], 1); assert.equal(counts(db)["2:Renamed"], 1);
    assert.equal(counts(db)["1:Bug"], undefined); checkAgainstCards(db);
    rename(db, 2, "Bug", "Other");
    assert.equal(counts(db)["2:Other"], 1); assert.equal(counts(db)["1:Renamed"], 2); checkAgainstCards(db);
    // A rollback must undo both the reset and every incremental card update.
    db.exec("BEGIN; UPDATE chips SET name='Temporary' WHERE project_id=1 AND name='Renamed'");
    db.exec("UPDATE cards SET chips='[\"Temporary\"]' WHERE no=1; ROLLBACK");
    assert.equal(counts(db)["1:Renamed"], 2); checkAgainstCards(db);
  });
});

test("0008 carries old hourly reservations and enforces one author quota across projects without double charging", () => {
  withDatabase((db) => {
    secondProject(db);
    const bucket = Math.floor(Date.parse(at) / 3_600_000);
    const key = "comment:developer:" + bucket;
    db.prepare("INSERT INTO rate_limits(key,count,expires_at) VALUES (?,59,?)").run(key, Date.parse(at) / 1000 + 7200);
    db.exec("INSERT INTO rate_limits VALUES ('feedback:unrelated',500,0)");
    db.exec(readFileSync(new URL("../migrations/0008_quotas_chip_counts.sql", import.meta.url), "utf8"));
    const insert = db.prepare("INSERT INTO comments(project_id,card_no,author,body,created_at) VALUES (?,1,?,?,?)");
    assert.equal(db.prepare("SELECT count FROM comment_limits WHERE key=?").get(key)?.count, 59);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comment_limits").get()?.n, 1);
    // Old Worker reserves in rate_limits; 0008 independently charges the row once.
    db.exec("BEGIN");
    db.prepare("UPDATE rate_limits SET count=count+1 WHERE key=?").run(key);
    insert.run(1, "developer", "old worker", at); db.exec("COMMIT");
    assert.equal(db.prepare("SELECT count FROM comment_limits WHERE key=?").get(key)?.count, 60);
    assert.throws(() => insert.run(2, "developer", "same author, other project", at), /comment_rate_limit/);
    insert.run(2, "lead", "another author", at);
    insert.run(2, "developer", "new hour", "2026-10-03T13:00:00Z");
    assert.throws(() => insert.run(1, "owner", "😀".repeat(1025), at), /comment_too_long/);
    assert.equal(db.prepare("SELECT count FROM comment_limits WHERE key=?").get("comment:owner:" + bucket), undefined);
    insert.run(1, "owner", "😀".repeat(1024), at);
    db.exec("BEGIN"); insert.run(2, "owner", "rolled back", at); db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count FROM comment_limits WHERE key=?").get("comment:owner:" + bucket)?.count, 1);
  }, 7);
});

// 0011 adds the status column to the table that is already there. It must fill every card's status from
// its old col, move the todo and later cards to the columns that show them now, recompute the per-column counts,
// and leave every trigger, index and chip count exactly as they were (it doesn't rebuild the table).
test("0011 gives every card a status from its old column, moves todo and later cards, and keeps counts, triggers and indexes", () => {
  withDatabase((db) => {
    secondProject(db);
    const old = [["feedback", "feedback"], ["backlog", "backlog"], ["todo", "todo"], ["progress", "progress"], ["testing", "on_prod_qa"], ["later", "qa_later"], ["done", "done"]] as const;
    let no = 1;
    for (const [col] of old) {
      db.prepare("INSERT INTO cards(no,project_id,col,title,chips,created_at,updated_at) VALUES (?,1,?,?,'[\"Bug\"]',?,?)").run(no++, col, col, at, at);
    }
    // One card of project 2, and a removed card in todo: it keeps its status and isn't counted.
    db.prepare("INSERT INTO cards(no,project_id,col,title,chips,created_at,updated_at) VALUES (20,2,'todo','other','[]',?,?)").run(at, at);
    db.prepare("INSERT INTO cards(no,project_id,col,title,chips,created_at,updated_at,removed_at) VALUES (21,1,'todo','gone','[]',?,?,?)").run(at, at, at);
    // The counts the 0010 Worker keeps: per old column, live cards only.
    db.exec("DELETE FROM column_counts");
    db.exec("INSERT INTO column_counts(project_id,col,n) SELECT project_id,col,COUNT(*) FROM cards WHERE removed_at IS NULL GROUP BY project_id,col");
    const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('trigger','index') AND name NOT LIKE 'sqlite_auto%' ORDER BY 1,2").all();
    const before = objects(), chipsBefore = counts(db);
    db.exec(readFileSync(new URL("../migrations/0011_card_status.sql", import.meta.url), "utf8"));
    assert.deepEqual(objects(), before, "no trigger or index is lost or changed");
    assert.deepEqual(counts(db), chipsBefore);
    checkAgainstCards(db);
    const row = (n: number) => { const r = db.prepare("SELECT col,status FROM cards WHERE no=?").get(n) as { col: string; status: string }; return { col: r.col, status: r.status }; };
    assert.deepEqual(old.map(([col], i) => [col, row(i + 1).status]), old.map(([col, status]) => [col, status]));
    assert.deepEqual(old.map((_, i) => row(i + 1).col), ["feedback", "backlog", "backlog", "progress", "testing", "testing", "done"]);
    assert.deepEqual(row(20), { col: "backlog", status: "todo" });
    assert.deepEqual(row(21), { col: "backlog", status: "todo" });
    // column_counts: live cards per project and stored column, and nothing for todo or later any more.
    const cc = Object.fromEntries(db.prepare("SELECT project_id||':'||col AS k, n FROM column_counts").all().map((r) => [r.k, r.n]));
    assert.deepEqual(cc, { "1:feedback": 1, "1:backlog": 2, "1:progress": 1, "1:testing": 2, "1:done": 1, "2:backlog": 1 });
    for (const r of db.prepare("SELECT project_id,col,n,(SELECT COUNT(*) FROM cards c WHERE c.project_id=column_counts.project_id AND c.col=column_counts.col AND c.removed_at IS NULL) AS expected FROM column_counts").all())
      assert.equal(r.n, r.expected, r.project_id + "/" + r.col);
    // The CHECK is in force, and a card inserted by the 0010 Worker (no status) gets the default.
    assert.throws(() => db.exec("UPDATE cards SET status='waiting' WHERE no=1"));
    db.prepare("INSERT INTO cards(no,project_id,col,title,created_at,updated_at) VALUES (30,1,'backlog','late',?,?)").run(at, at);
    assert.equal(row(30).status, "backlog");
    // The chip triggers still work.
    db.prepare("INSERT INTO cards(no,project_id,col,status,title,chips,created_at,updated_at) VALUES (31,1,'progress','pr_review','t','[\"Bug\"]',?,?)").run(at, at);
    assert.equal(Number(counts(db)["1:Bug"]), Number(chipsBefore["1:Bug"]) + 1);
    checkAgainstCards(db);
  }, 10);
});

test("0011 has no CASE and no trigger body (D1's remote parser)", () => {
  const sql = readFileSync(new URL("../migrations/0011_card_status.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
  assert.ok(!/\bCASE\b/i.test(sql));
  assert.ok(!/\bTRIGGER\b/i.test(sql));
  assert.ok(!/\bDROP\s+TABLE\b/i.test(sql));
});
