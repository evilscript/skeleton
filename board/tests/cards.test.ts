import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COLUMN_KEYS, columnOf, PROJECT_LAYOUTS, projectStatuses, STATUS_SLUGS, STATUSES, statusFromWord, statusesOf, statusLabelFor, VIEW_COLUMNS, viewColumnOf, viewStatusesFor } from "../public/board/statuses.js";
import { AGENT_LIST, AGENT_NAMES, OWNER_ASSIGNEE } from "../src/agents.ts";
import { ASSIGNEES, assigneeValue, commentFields, InputError, PRIORITIES, priorityValue } from "../src/validation.ts";

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof InputError ? e.code : String(e); }
  return "";
};

test("a card can go to any agent in src/agents.ts or to the owner, or nobody", () => {
  for (const a of AGENT_NAMES) assert.equal(assigneeValue(a), a);
  assert.equal(assigneeValue(OWNER_ASSIGNEE.name), OWNER_ASSIGNEE.name);
  assert.equal(assigneeValue(null), null);
  assert.equal(assigneeValue(""), null);
  assert.equal(code(() => assigneeValue("nobody-by-that-name")), "invalid_assignee");
  assert.equal(code(() => assigneeValue(AGENT_NAMES[0].toUpperCase())), "invalid_assignee", "names are case sensitive");
  assert.equal(code(() => assigneeValue(1)), "invalid_assignee");
});

test("a priority is minor, major, critical or blocker, or none", () => {
  for (const p of ["minor", "major", "critical", "blocker"]) assert.equal(priorityValue(p), p);
  assert.equal(priorityValue(null), null);
  assert.equal(priorityValue(""), null);
  assert.equal(code(() => priorityValue("urgent")), "invalid_priority");
  assert.equal(code(() => priorityValue("Major")), "invalid_priority");
  assert.equal(code(() => priorityValue(3)), "invalid_priority");
});

test("every agent can be sent a comment, the owner too, and the list is sound", () => {
  for (const name of AGENT_NAMES) assert.equal(commentFields({ body: "please look", to: name }).to, name);
  assert.equal(commentFields({ body: "please look", to: "owner" }).to, "owner");
  assert.equal(commentFields({ body: "please look", to: OWNER_ASSIGNEE.name }).to, OWNER_ASSIGNEE.name);
  assert.equal(code(() => commentFields({ body: "please look", to: "nobody-by-that-name" })), "invalid_to");
  // Names are the identity (a key-store account, an environment variable value): plain, unique, not the owner's.
  assert.equal(new Set(AGENT_NAMES).size, AGENT_NAMES.length);
  for (const { name, label } of AGENT_LIST) { assert.match(name, /^[a-z][a-z0-9-]*$/); assert.ok(label.length > 0); }
  assert.ok(!AGENT_NAMES.includes(OWNER_ASSIGNEE.name) && !AGENT_NAMES.includes("owner"));
  assert.deepEqual([...ASSIGNEES], [...AGENT_NAMES, OWNER_ASSIGNEE.name]);
});

// The database refuses what the Worker doesn't know about: the lists must
// match the CHECKs in the migrations that made them.
test("the cards table's CHECKs list the same assignees, priorities, statuses and columns", () => {
  const sql = (file: string) => readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8");
  const list = (text: string, column: string) => text.match(new RegExp(`${column} TEXT (?:NOT NULL )?(?:DEFAULT '\\w+'\\s+)?CHECK \\(${column} IN \\(([^)]*)\\)\\)`))?.[1].replace(/'/g, "").split(",");
  // Since 0012 the database has no CHECK on the assignee: src/agents.ts is the rule, so a new developer needs no migration.
  assert.ok(!/assignee TEXT[^,]*CHECK/.test(sql("0012_assignee_open.sql")), "0012 leaves the assignee free");
  assert.deepEqual(list(sql("0012_assignee_open.sql"), "priority"), [...PRIORITIES]);
  // `col` still allows the two old columns (a CHECK can't be changed without a rebuild) but no card keeps them.
  assert.deepEqual(list(sql("0012_assignee_open.sql"), "col"), ["feedback", "backlog", "todo", "progress", "testing", "later", "done"]);
  // 0011 and 0012 list the nine original statuses (history); since 0013 the database has no CHECK on the status:
  // public/board/statuses.js is the rule, so a new status needs no migration.
  const NINE = STATUS_SLUGS.filter((slug) => slug !== "spike_ready" && slug !== "probe_needed");
  assert.deepEqual(list(sql("0012_assignee_open.sql"), "status"), NINE);
  assert.deepEqual(list(sql("0011_card_status.sql"), "status"), NINE);
  const open = sql("0013_status_open.sql");
  assert.ok(!/status TEXT[^;]*CHECK/.test(open), "0013 leaves the status free");
  assert.deepEqual(list(open, "priority"), [...PRIORITIES]);
  assert.deepEqual(list(open, "col"), ["feedback", "backlog", "todo", "progress", "testing", "later", "done"]);
});

test("the eleven statuses, in their fixed order, and the column each one is shown in", () => {
  assert.deepEqual(STATUS_SLUGS, ["feedback", "backlog", "todo", "progress", "pr_review", "on_main", "spike_ready", "probe_needed", "on_prod_qa", "qa_later", "done"]);
  assert.deepEqual(COLUMN_KEYS, ["feedback", "backlog", "progress", "testing", "done"]);
  assert.deepEqual(STATUSES.map((s) => s.col), ["feedback", "backlog", "backlog", "progress", "progress", "progress", "progress", "testing", "testing", "testing", "done"]);
  assert.deepEqual(statusesOf("backlog").map((s) => s.slug), ["backlog", "todo"]);
  assert.deepEqual(statusesOf("progress").map((s) => s.slug), ["progress", "pr_review", "on_main", "spike_ready"]);
  assert.deepEqual(statusesOf("testing").map((s) => s.slug), ["probe_needed", "on_prod_qa", "qa_later"]);
  // Every status's column is a stored column, and every column has a status.
  for (const s of STATUSES) assert.ok(COLUMN_KEYS.includes(s.col), s.slug);
  for (const c of COLUMN_KEYS) assert.ok(statusesOf(c).length > 0, c);
  assert.equal(columnOf("on_main"), "progress");
  assert.equal(columnOf("nope"), undefined);
});

test("old column words mean statuses: a column its first status, todo and later their own", () => {
  assert.equal(statusFromWord("progress"), "progress");
  assert.equal(statusFromWord("testing"), "on_prod_qa");
  assert.equal(statusFromWord("later"), "qa_later");
  assert.equal(statusFromWord("todo"), "todo");
  assert.equal(statusFromWord("backlog"), "backlog");
  assert.equal(statusFromWord("pr_review"), "pr_review");
  assert.equal(statusFromWord("waiting"), undefined);
  assert.equal(statusFromWord(3), undefined);
});

test("the CLI's help lists every status", () => {
  const cli = readFileSync(new URL("../cli/board.mjs", import.meta.url), "utf8");
  for (const slug of STATUS_SLUGS) assert.ok(cli.includes(slug), slug);
});

test("the board page's columns: every status shown exactly once, inside its stored column", () => {
  assert.deepEqual(VIEW_COLUMNS.map((c) => c.key), ["feedback", "backlog", "progress", "pr", "testing", "done"]);
  assert.deepEqual(VIEW_COLUMNS.find((c) => c.key === "pr")?.statuses, ["pr_review", "spike_ready", "on_main"]);
  assert.deepEqual(VIEW_COLUMNS.find((c) => c.key === "testing")?.statuses, ["probe_needed", "on_prod_qa", "qa_later"]);
  assert.deepEqual(VIEW_COLUMNS.flatMap((c) => c.statuses).sort(), [...STATUS_SLUGS].sort());
  for (const s of STATUSES) assert.ok(viewColumnOf(s.slug), s.slug);
  // The page only splits a stored column: all the statuses of a shown column share one stored column.
  for (const c of VIEW_COLUMNS) assert.equal(new Set(c.statuses.map((x) => columnOf(x))).size, 1, c.key);
});

test("a project can hide statuses and rename some; every other project shows all eleven as before", () => {
  const layouts = PROJECT_LAYOUTS;
  const key = "layout-test"; // a layout registered for this test only
  layouts[key] = { hide: ["probe_needed", "qa_later"], labels: { on_prod_qa: "Ready for QA", spike_ready: "Spike done" }, order: { pr: ["pr_review", "on_main", "spike_ready"] } };
  try {
    assert.deepEqual(projectStatuses("main"), STATUS_SLUGS);
    assert.deepEqual(projectStatuses("another-project"), STATUS_SLUGS);
    assert.deepEqual(viewStatusesFor("main", "testing"), ["probe_needed", "on_prod_qa", "qa_later"]);
    // The layout above: Backlog (backlog, to do), In progress, PR submitted (PR reviewing, On main, Spike done), one Ready for QA status, Done.
    assert.deepEqual(viewStatusesFor(key, "backlog"), ["backlog", "todo"]);
    assert.deepEqual(viewStatusesFor(key, "progress"), ["progress"]);
    assert.deepEqual(viewStatusesFor(key, "pr"), ["pr_review", "on_main", "spike_ready"]);
    assert.deepEqual(viewStatusesFor("main", "pr"), ["pr_review", "spike_ready", "on_main"]);
    assert.deepEqual(viewStatusesFor(key, "testing"), ["on_prod_qa"]);
    assert.equal(statusLabelFor(key, "spike_ready"), "Spike done");
    assert.equal(statusLabelFor(key, "on_prod_qa"), "Ready for QA");
    assert.equal(statusLabelFor("main", "spike_ready"), "Spike report ready");
    assert.equal(statusLabelFor("main", "probe_needed"), "Owner check needed");
    assert.equal(statusLabelFor(key, "on_main"), "On Main");
    // Whatever a project hides, every status it keeps is drawn in exactly one layer, and its stored columns are still the five.
    for (const k of Object.keys(layouts)) {
      const drawn = VIEW_COLUMNS.flatMap((c) => viewStatusesFor(k, c.key)).sort();
      assert.deepEqual(drawn, [...projectStatuses(k)].sort(), k);
      for (const slug of layouts[k].hide ?? []) assert.ok(STATUS_SLUGS.includes(slug), `${k} hides a status that exists: ${slug}`);
      for (const slug of Object.keys(layouts[k].labels ?? {})) assert.ok(STATUS_SLUGS.includes(slug), `${k} renames a status that exists: ${slug}`);
    }
  } finally { delete layouts[key]; }
  // The Worker checks it where a card is made and where its status changes.
  const worker = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(worker.match(/projectStatuses\(/g)?.length, 2);
});
