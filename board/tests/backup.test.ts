import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backup, verifyRestore } from "../scripts/backup.mjs";

// Fixture dates are built from a base year so it is plain they are not real events.
const year = "2030";
const day = `${year}-01-15`;

function fixtureSql(legacy = false) {
  const files = readdirSync(new URL("../migrations/", import.meta.url)).sort()
    .filter((name) => name.endsWith(".sql") && Number(name.slice(0, 4)) <= (legacy ? 4 : 7));
  const schema = files.map((name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8")).join("\n");
  const oldData = `
    INSERT INTO cards(no,col,title,chips,comment_count,created_at,updated_at)
      VALUES (1,'backlog','first','["Bug"]',1,'${day}T00:00:00Z','${day}T00:00:00Z');
    INSERT INTO comments(card_no,project_id,author,body,created_at)
      VALUES (1,1,'developer','first','${day}T00:00:00Z');
    INSERT INTO files(id,card_no,kind,name,type,size,created_at,created_by)
      VALUES ('file',1,'file','note.txt','text/plain',4,'${day}T00:00:00Z','developer');`;
  if (legacy) return schema + oldData;
  const projectData = `
    INSERT INTO projects(id,slug,name,created_at) VALUES (2,'other','Other','${day}T00:00:00Z');
    INSERT INTO chips(project_id,name,color,sort) VALUES (2,'Bug','#dc2626',1);
    INSERT INTO cards(no,project_id,col,title,chips,comment_count,removed_at,created_at,updated_at) VALUES
      (2,2,'progress','second','["Bug"]',1,NULL,'${day}T00:00:00Z','${day}T00:00:00Z'),
      (3,2,'done','removed','["Bug"]',0,'${day}T00:00:00Z','${day}T00:00:00Z','${day}T00:00:00Z');
    INSERT INTO comments(card_no,project_id,author,body,created_at)
      VALUES (2,2,'lead','second','${day}T00:00:00Z');
    DELETE FROM column_counts;
    INSERT INTO column_counts(project_id,col,n)
      SELECT project_id,col,COUNT(*) FROM cards WHERE removed_at IS NULL GROUP BY project_id,col;
    INSERT INTO column_counts(project_id,col,n) VALUES (2,'done',0);`;
  return schema + oldData + projectData
    + readFileSync(new URL("../migrations/0008_quotas_chip_counts.sql", import.meta.url), "utf8");
}

function argument(args: readonly string[], name: string) {
  const value = args[args.indexOf(name) + 1];
  if (args.indexOf(name) < 0 || !value) throw new Error("Missing fixture argument " + name);
  return value;
}

// Never spawn Wrangler or access Cloudflare: both export and restore are
// injected local fixture operations, including failures and retention runs.
function fixtureRunner(exportedSql: string) {
  const calls: string[][] = [];
  const localPaths: string[] = [];
  const run = (args: string[]) => {
    calls.push([...args]);
    assert.equal(args[0], "d1");
    if (args[1] === "export") writeFileSync(argument(args, "--output"), exportedSql);
    else {
      assert.equal(args[1], "execute");
      assert.ok(args.includes("--local"));
      assert.ok(!args.includes("--remote"));
      const local = argument(args, "--persist-to");
      localPaths.push(local);
      const sqlite = new DatabaseSync(join(local, "fixture.sqlite"));
      try { sqlite.exec(readFileSync(argument(args, "--file"), "utf8")); }
      finally { sqlite.close(); }
    }
    return "[]";
  };
  return { run, calls, localPaths };
}

function withSql(sql: string, body: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "board-backup-test-"));
  const path = join(directory, "fixture.sql");
  try { writeFileSync(path, sql); body(path); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("restore validates independent chip and column counts for equal names in different projects", () => {
  withSql(fixtureSql(), (path) => {
    const { run, localPaths } = fixtureRunner("");
    assert.deepEqual({ ...verifyRestore(path, run) }, { cards: 3, comments: 2, files: 1, chips: 3 });
    assert.ok(localPaths.every((local) => !existsSync(local)));
  });
});

test("restore still verifies an older single-project export without incremental statistics", () => {
  withSql(fixtureSql(true), (path) => {
    const { run } = fixtureRunner("");
    assert.deepEqual({ ...verifyRestore(path, run) }, { cards: 1, comments: 1, files: 1, chips: 2 });
  });
});

test("restore rejects a comment assigned to a different project than its card", () => {
  withSql(fixtureSql() + "UPDATE comments SET project_id=1 WHERE card_no=2;", (path) => {
    const { run, localPaths } = fixtureRunner("");
    assert.throws(() => verifyRestore(path, run), /comments do not belong/);
    assert.ok(localPaths.every((local) => !existsSync(local)));
  });
});

test("restore rejects damaged or missing incremental statistics", () => {
  for (const [sql, error] of [
    ["UPDATE chips SET used=2 WHERE project_id=1 AND name='Bug';", /chip counts/],
    ["UPDATE column_counts SET n=2 WHERE project_id=1 AND col='backlog';", /column counts/],
    ["DELETE FROM column_counts WHERE project_id=2 AND col='progress';", /column counts/],
  ] as const) {
    withSql(fixtureSql() + sql, (path) => {
      assert.throws(() => verifyRestore(path, fixtureRunner("").run), error);
    });
  }
});

test("failed verification keeps historical backups and clears only the partial export and lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "board-backup-failure-"));
  try {
    const historic = `board-${year}-01-01.sql`;
    writeFileSync(join(directory, historic), "old SQL");
    writeFileSync(join(directory, historic + ".json"), "old manifest");
    const { run } = fixtureRunner(fixtureSql() + "UPDATE chips SET used=99 WHERE name='Bug';");
    assert.throws(() => backup({ directory, date: day, run }), /chip counts/);
    assert.deepEqual(readdirSync(directory).sort(), [historic, historic + ".json"]);
    assert.equal(readFileSync(join(directory, historic), "utf8"), "old SQL");
    assert.equal(readFileSync(join(directory, historic + ".json"), "utf8"), "old manifest");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("verified copies alone permit retention cleanup and the same UTC date never exports twice", () => {
  const directory = mkdtempSync(join(tmpdir(), "board-backup-success-"));
  try {
    const expired = `board-${year}-01-01.sql`, keep = `board-${year}-01-02.sql`;
    for (const name of [expired, expired + ".json", keep, "other.sql"]) writeFileSync(join(directory, name), name);
    const { run, calls } = fixtureRunner(fixtureSql());
    const first = backup({ directory, date: day, run });
    const second = backup({ directory, date: day, run });
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual({ ...first.localRestore }, { cards: 3, comments: 2, files: 1, chips: 3 });
    assert.equal(calls.filter((args) => args[1] === "export").length, 1);
    assert.deepEqual(readdirSync(directory).sort(), [keep, `board-${day}.sql`, `board-${day}.sql.json`, "other.sql"]);
    const manifest = JSON.parse(readFileSync(first.file + ".json", "utf8"));
    assert.equal(manifest.sha256, first.sha256);
    assert.equal(manifest.bytes, readFileSync(first.file).length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
