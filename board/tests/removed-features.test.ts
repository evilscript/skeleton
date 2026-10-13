import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { COLUMN_KEYS, STATUS_SLUGS, STATUSES } from "../public/board/statuses.js";
import { database } from "./support.ts";

// The board has no public form and no inbox status. A fresh database never held them, and nothing in this folder names them.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GONE = "feed" + "back"; // the word is spelled in two pieces so that this file does not contain it

test("a fresh database has ten statuses, four stored columns, and nothing of the old inbox", () => {
  assert.equal(STATUS_SLUGS.length, 10);
  assert.deepEqual(STATUS_SLUGS, ["backlog", "todo", "progress", "pr_review", "on_main", "spike_ready", "probe_needed", "on_prod_qa", "qa_later", "done"]);
  assert.deepEqual(COLUMN_KEYS, ["backlog", "progress", "testing", "done"]);
  const { sqlite } = database();
  try {
    // No table, column, index, trigger, CHECK or seed row of the fresh schema mentions it.
    const schema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all().map((r) => String(r.sql)).join("\n");
    assert.ok(!new RegExp(GONE, "i").test(schema), "the schema names it");
    const columns = sqlite.prepare("PRAGMA table_info(cards)").all().map((r) => String(r.name));
    for (const old of ["report", "contact", "locale", "request_key"]) assert.ok(!columns.includes(old), `cards.${old}`);
    assert.deepEqual(columns.filter((c) => c === "source"), ["source"]); // where a card came from: board, or migrated
    assert.deepEqual(sqlite.prepare("SELECT name FROM chips WHERE project_id=1 ORDER BY sort").all().map((r) => r.name), ["Bug", "Feature"]);
    // The database itself refuses a card in a column it does not have.
    assert.throws(() => sqlite.exec(`INSERT INTO cards(no,col,title,created_at,updated_at) VALUES (50,'${GONE}','x','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z')`));
  } finally { sqlite.close(); }
});

test("a card with the removed status is refused as an unknown status, in every way it can be asked for", async () => {
  const { sqlite, request } = database();
  try {
    for (const [body, error] of [[{ title: "x", status: GONE }, "invalid_status"], [{ title: "x", col: GONE }, "invalid_column"]] as const) {
      const res = await request("/api/cards", "POST", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error });
    }
    assert.equal(((await (await request("/api/cards/1", "PATCH", { status: GONE })).json()) as { error: string }).error, "invalid_status");
    assert.equal(((await (await request("/api/cards/1", "PATCH", { col: GONE })).json()) as { error: string }).error, "invalid_column");
    assert.equal(((await (await request(`/api/cards?status=${GONE}`)).json()) as { error: string }).error, "invalid_status");
    assert.equal(((await (await request(`/api/cards?col=${GONE}`)).json()) as { error: string }).error, "invalid_column");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cards").get()?.n, 1); // nothing was made or changed
    // The routes of the public form are gone too: an unknown path, with or without a body.
    assert.equal((await request("/api/" + GONE, "POST", { title: "x" })).status, 404);
  } finally { sqlite.close(); }
});

test("the column order and the counts still work: a card in each of the ten statuses lands in its column", async () => {
  const { sqlite, request } = database();
  try {
    const made: Record<string, number> = {};
    for (const { slug } of STATUSES) {
      const res = await request("/api/cards", "POST", { title: slug, status: slug });
      assert.equal(res.status, 201, slug);
      made[slug] = ((await res.json()) as { no: number }).no;
    }
    const list = (await (await request("/api/cards")).json()) as { cards: { no: number; status: string; col: string }[] };
    assert.equal(list.cards.length, 11); // the seed card, backlog, and the ten new ones
    for (const { slug, col } of STATUSES) {
      const card = list.cards.find((c) => c.no === made[slug])!;
      assert.deepEqual([card.status, card.col], [slug, col], slug);
    }
    // One row per stored column, in step with the cards, and no other column.
    const counts = sqlite.prepare("SELECT col, n FROM column_counts WHERE project_id=1 ORDER BY col").all().map((r) => [r.col, r.n]);
    assert.deepEqual(counts, [["backlog", 3], ["done", 1], ["progress", 4], ["testing", 3]]);
    // A move between columns keeps them right, and the board's own first load (done left out) counts the rest.
    assert.equal((await request(`/api/cards/${made.todo}`, "PATCH", { status: "done" })).status, 200);
    const loaded = (await (await request("/api/cards?hide=done&version=1&chips=1")).json()) as { hidden: { count: number } };
    assert.equal(loaded.hidden.count, 2);
    for (const status of ["inbox", "Backlog", ""]) assert.equal((await request("/api/cards", "POST", { title: "x", status })).status, 400, status);
  } finally { sqlite.close(); }
});

test("nothing in this folder names the old inbox or the public form", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".wrangler" || name === ".git") continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) { walk(path); continue; }
      const raw = readFileSync(path);
      if (raw.includes(0)) continue; // a binary file
      const word = new RegExp(GONE, "i");
      if (word.test(path.slice(ROOT.length)) || word.test(new TextDecoder().decode(raw))) hits.push(path.slice(ROOT.length));
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});

test("the setup script refuses to run without a terminal, and takes only its three modes", () => {
  const script = join(ROOT, "scripts/setup-secrets.sh");
  // No terminal on standard input (as in an agent's shell or a pipe): the password cannot be typed, so it stops before it asks or changes anything.
  const piped = spawnSync("bash", [script, "--password-only"], { input: "hunter2 hunter2 hunter2\n", encoding: "utf8" });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /run it yourself in a terminal/);
  assert.doesNotMatch(piped.stdout + piped.stderr, /hunter2/);
  const everything = spawnSync("bash", [script], { input: "x\n", encoding: "utf8" });
  assert.equal(everything.status, 1);
  const unknown = spawnSync("bash", [script, "--nonsense"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: bash scripts\/setup-secrets\.sh \[--password-only \| --keys-only\]/);
  // How it handles the password, from its text: a hidden prompt typed twice, whitespace kept, 12 characters at least, standard input only.
  const source = readFileSync(script, "utf8");
  assert.match(source, /IFS= read -r -s -p "Choose the password/);
  assert.match(source, /IFS= read -r -s -p "Type it again/);
  assert.match(source, /Array\.from\(s\)\.length>=12/);
  assert.match(source, /printf '%s' "\$2" \| npx wrangler secret put "\$1"/); // a secret goes to Wrangler on its standard input
  // The only places the password is read are the comparison of the two entries, the length check (through a pipe to node) and
  // the call that sets the secret: never an echo, a file, a key store or a command line.
  for (const line of source.split("\n").filter((l) => l.includes("$password"))) {
    assert.match(line, /^\s*(if \[ "\$password" != "\$again" \]|if ! printf '%s' "\$password" \| node -e |put OWNER_PASSWORD "\$password")/, line);
  }
  assert.ok(!/set -x|--password(?!-only)|store_key[^\n]*password/.test(source));
  assert.match(source, /--password-only\) mode=password/);
  assert.match(source, /--keys-only\) mode=keys/);
});
