import { AGENT_LIST, OWNER_ASSIGNEE } from "./agents.ts";
import { actorName, actorOf, CLEAR_COOKIE, isOwnerKey, sessionCookie, type Actor, type AuthEnv } from "./auth.ts";
import { assigneeValue as assignee, boundedForm, cardTitle, commentFields, DEFAULT_PROJECT, fields, hasContent, imageExtension, InputError, keyFromName, MAX_FILE, MAX_IMAGES, MAX_PROJECTS, priorityValue as priority, projectKey, projectName } from "./validation.ts";
import { COMMENT_ERRORS } from "../public/board/comment-rules.js";
import { COLUMN_KEYS, columnOf, projectStatuses, STATUS_SLUGS, statusFromWord, statusesOf } from "../public/board/statuses.js";

interface Env extends AuthEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES?: R2Bucket; // absent when the board has no R2 bucket: files and screenshots are switched off
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  ENVIRONMENT: string;
  PROJECT_NAME: string; // public: the name the pages show (wrangler.jsonc vars)
}

// A card's status says where it is in the work; the stored `col` is the
// column that shows it, and columnOf (one table, public/board/statuses.js) is the
// only place the two are tied together. `todo` and `later` stay in the cards
// table's `col` CHECK but are no longer stored (migration 0011).
type Column = (typeof COLUMN_KEYS)[number];
const MAX_ATTACHMENT = 25 * 1024 * 1024;

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...HEADERS, ...extra } });
}
async function digest(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
const now = () => new Date().toISOString();

// File storage is optional. Without the FILES binding the file endpoints answer
// 501 files_disabled, the feedback form takes no images, and nothing below
// touches the bucket.
function bucket(env: Env): R2Bucket {
  if (!env.FILES) throw new InputError("files_disabled", 501);
  return env.FILES;
}
// Best-effort cleanup of stored objects: nothing to do without a bucket, and a failure is not an error.
async function dropObjects(env: Env, ids: string | string[]): Promise<void> {
  if (env.FILES) await env.FILES.delete(ids).catch(() => {});
}

// The public feedback form files into the default project (id 1); other
// projects get their cards from the board, the CLI or the agents.
const FEEDBACK_PROJECT = 1;

type CardRow = {
  no: number; project_id: number; col: Column; status: string; title: string; description: string; assignee: string | null; priority: string | null; chips: string;
  sort: number; source: string; report: string; contact: string; locale: string;
  created_at: string; updated_at: string; updated_by: string;
  removed_at: string | null; removed_by: string | null; comment_count?: number;
};
// The column is what the stored `col` says; a status that doesn't belong to it
// (a hand-edited row, a restore from before 0011) shows as the column's first one.
function statusOut(r: { col: string; status?: string }): string {
  return r.status && columnOf(r.status) === r.col ? r.status : (statusFromWord(r.col) ?? r.col);
}
// filestat is "<screenshots> <attachments> <first screenshot's created_at> <its id>"
// (the last two empty without a screenshot): one pass over the card's files.
function cardOut(r: CardRow & { filestat?: string }) {
  const [shots, files, , thumb] = (r.filestat ?? "0 0").split(" ");
  return {
    no: r.no, col: r.col, status: statusOut(r), title: r.title, description: r.description, assignee: r.assignee, priority: r.priority ?? null,
    chips: JSON.parse(r.chips || "[]") as string[], sort: r.sort, source: r.source,
    report: r.report, contact: r.contact, locale: r.locale,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    shots: Number(shots), files: Number(files), thumb: thumb || null,
    removedAt: r.removed_at ?? null, removedBy: r.removed_by ?? null, cut: Boolean((r as { cut?: number }).cut),
    commentCount: r.comment_count ?? 0,
  };
}

// ---------------------------------------------------------------- input

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new InputError("invalid_fields");
  const text = await request.text();
  if (text.length > 2_000_000) throw new InputError("too_large", 413);
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new InputError("invalid_fields");
  }
}
function str(v: unknown, min: number, max: number): string {
  if (typeof v !== "string") throw new InputError("invalid_fields");
  const t = v.trim();
  if (t.length < min || t.length > max) throw new InputError("invalid_fields");
  return t;
}
function column(v: unknown): Column {
  if (typeof v !== "string" || !COLUMN_KEYS.includes(v)) throw new InputError("invalid_column");
  return v;
}
// The status a request asks for: `status` (a slug), or the old `col` (a column
// name means its first status; todo and later mean todo and qa_later). Both
// may be given if they agree. undefined when neither is there.
function statusInput(b: Record<string, unknown>): string | undefined {
  let status: string | undefined;
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !STATUS_SLUGS.includes(b.status)) throw new InputError("invalid_status");
    status = b.status;
  }
  if (b.col !== undefined) {
    const fromCol = statusFromWord(b.col);
    if (!fromCol) throw new InputError("invalid_column");
    if (status !== undefined && columnOf(status) !== columnOf(fromCol)) throw new InputError("invalid_status");
    status ??= fromCol;
  }
  return status;
}
function chipList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 20) throw new InputError("invalid_chips");
  const out: string[] = [];
  for (const c of v) {
    const name = str(c, 1, 40);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
const COLOR = /^#[0-9a-f]{6}$/i;

// Titles stay short; a description has no length rule of its own, only
// D1's row limit (about 2 MB, a profile export fits).
const MAX_DESCRIPTION_BYTES = 1_800_000;
function title(v: unknown): string {
  if (typeof v !== "string") throw new InputError("invalid_fields");
  const t = v.trim();
  if (t.length < 1 || t.length > 200) throw new InputError("title_length");
  return t;
}
function description(v: unknown): string {
  if (typeof v !== "string") throw new InputError("invalid_fields");
  const d = v.trim();
  if (new TextEncoder().encode(d).length > MAX_DESCRIPTION_BYTES) throw new InputError("description_too_long", 413);
  return d;
}

// A chip used on a card exists in the project's chip list too (default grey).
function ensureChips(env: Env, project: number, names: string[]) {
  return names.map((n) => env.DB.prepare("INSERT OR IGNORE INTO chips(project_id, name, color, sort) VALUES (?, ?, '#6b7280', (SELECT COALESCE(MAX(sort),0)+1 FROM chips WHERE project_id = ?))").bind(project, n, project));
}
// An entry about a card takes the card's project; one with no card (a chip, a
// project) or whose card is going away says the project itself.
function log(env: Env, no: number | null, actor: string, action: string, detail = "", project?: number) {
  return env.DB.prepare("INSERT INTO activity(card_no, project_id, actor, action, detail, at) VALUES (?, COALESCE(?, (SELECT project_id FROM cards WHERE no = ?), 1), ?,?,?,?)")
    .bind(no, project ?? null, no, actor, action, detail.slice(0, 500), now());
}

// ---------------------------------------------------------------- projects

type Project = { id: number; slug: string; name: string };
async function projectByKey(env: Env, key: string): Promise<Project> {
  const p = await env.DB.prepare("SELECT id, slug, name FROM projects WHERE slug = ?").bind(key).first<Project>();
  if (!p) throw new InputError("unknown_project", 404);
  return p;
}
// A key never changes and projects are never deleted, so its id is kept for
// the life of the isolate: most requests skip the lookup. (Deleting projects
// would have to forget it.)
const projectIds = new Map<string, number>();
async function projectId(env: Env, key: string): Promise<number> {
  const known = projectIds.get(key);
  if (known !== undefined) return known;
  const row = await env.DB.prepare("SELECT id FROM projects WHERE slug = ?").bind(key).first<{ id: number }>();
  if (!row) throw new InputError("unknown_project", 404);
  projectIds.set(key, row.id);
  return row.id;
}
// The project a request is about: ?project=<key>, and the default project when
// there is none.
const projectIdOf = (env: Env, url: URL) => projectId(env, url.searchParams.get("project") || DEFAULT_PROJECT);

// What a refresh asks the database, kept cheap. The change check is one
// statement with two one-row reads (the indexes start with the project): v is
// the project's newest card change, c its newest comment.
const versionStatement = (env: Env, pid: number) =>
  env.DB.prepare("SELECT (SELECT MAX(updated_at) FROM cards WHERE project_id = ?1) AS v, (SELECT MAX(id) FROM comments WHERE project_id = ?1) AS c").bind(pid);
const versionOut = (row: { v: string | null; c: number | null } | null | undefined) => ({ v: row?.v ?? "", c: row?.c ?? 0 });
// Chip counts are maintained by card triggers in the same transaction as
// each write. Even ?counts=1 reads only this project's chip rows.
function chipsStatement(env: Env, pid: number, counts: boolean) {
  return env.DB.prepare(`SELECT name, color, sort${counts ? ", used" : ""} FROM chips WHERE project_id = ? ORDER BY sort, name`).bind(pid);
}
// Live cards per column, so "how many are done" is one row, not a count of a
// thousand. Every write that creates, moves, removes or restores a card bumps it.
const bump = (env: Env, pid: number, col: string, by: number) =>
  env.DB.prepare("INSERT INTO column_counts(project_id, col, n) VALUES (?,?,?) ON CONFLICT(project_id, col) DO UPDATE SET n = n + excluded.n").bind(pid, col, by);

async function listProjects(env: Env) {
  const { results } = await env.DB.prepare("SELECT slug, name, created_at AS createdAt FROM projects ORDER BY id").all();
  return json({ projects: results });
}

async function createProject(env: Env, actor: Actor, b: Record<string, unknown>) {
  const name = projectName(b.name);
  const slug = b.key === undefined || b.key === "" ? keyFromName(name) : projectKey(b.key);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PROJECTS) throw new InputError("too_many_projects", 409);
  if (await env.DB.prepare("SELECT 1 FROM projects WHERE slug = ?").bind(slug).first()) throw new InputError("project_exists", 409);
  const by = actorName(actor), at = now();
  try {
    // A new project starts with the two chips every backlog wants.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects(slug, name, created_at) VALUES (?,?,?)").bind(slug, name, at),
      env.DB.prepare("INSERT INTO chips(project_id, name, color, sort) SELECT id, 'Bug', '#dc2626', 1 FROM projects WHERE slug = ?").bind(slug),
      env.DB.prepare("INSERT INTO chips(project_id, name, color, sort) SELECT id, 'Feature', '#2563eb', 2 FROM projects WHERE slug = ?").bind(slug),
      env.DB.prepare("INSERT INTO activity(card_no, project_id, actor, action, detail, at) SELECT NULL, id, ?, 'create project', ?, ? FROM projects WHERE slug = ?").bind(by, name.slice(0, 500), at, slug),
    ]);
  } catch (e) {
    // Two creators picking the same key at once: the loser is a conflict, not an outage.
    if (await env.DB.prepare("SELECT 1 FROM projects WHERE slug = ?").bind(slug).first().catch(() => null)) throw new InputError("project_exists", 409);
    throw e;
  }
  return json({ slug, name }, 201);
}

// Only the name changes; the key is what links and the CLI use.
async function renameProject(env: Env, actor: Actor, key: string, b: Record<string, unknown>) {
  const project = await projectByKey(env, key);
  const name = projectName(b.name);
  if (name === project.name) return json({ slug: project.slug, name, changed: false });
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET name = ? WHERE id = ?").bind(name, project.id),
    log(env, null, actorName(actor), "rename project", `${project.name} → ${name}`, project.id),
  ]);
  return json({ slug: project.slug, name, changed: true });
}

// ---------------------------------------------------------------- cards

const CARD_COLUMNS = "c.no, c.project_id, c.col, c.status, c.title, c.assignee, c.priority, c.chips, c.sort, c.source, c.contact, c.locale, c.created_at, c.updated_at, c.updated_by, c.removed_at, c.removed_by, c.comment_count";
// The board list carries a description preview; a card's page has it all.
// A card's files are read once, from the files_card_stats index alone (it was
// three passes, each also reading every file's table row).
const LIST_SQL = `SELECT ${CARD_COLUMNS}, substr(c.description, 1, 2000) AS description, length(c.description) > 2000 AS cut, '' AS report,
  (SELECT COALESCE(SUM(f.kind = 'screenshot'), 0) || ' ' || COALESCE(SUM(f.kind = 'file'), 0) || ' ' || COALESCE(MIN(CASE WHEN f.kind = 'screenshot' THEN f.created_at || ' ' || f.id END), '')
    FROM files f WHERE f.card_no = c.no) AS filestat
  FROM cards c`;

async function listCards(env: Env, url: URL) {
  const q = url.searchParams;
  const pid = await projectIdOf(env, url);
  // Removed cards only show when asked for (?removed=1), and then only them.
  const where: string[] = ["c.project_id = ?", q.get("removed") === "1" ? "c.removed_at IS NOT NULL" : "c.removed_at IS NULL"], args: unknown[] = [pid];
  // ?status=<slug> is one status; ?col= is a column (todo and later, the old
  // columns, mean their statuses). A status filter also names its column so the
  // (project, col, sort) index is used.
  const statusQ = q.get("status");
  if (statusQ) {
    if (!STATUS_SLUGS.includes(statusQ)) throw new InputError("invalid_status");
    where.push("c.status = ?", "c.col = ?"); args.push(statusQ, columnOf(statusQ));
  }
  const col = q.get("col");
  if (col) {
    if (col === "todo" || col === "later") { const st = statusFromWord(col) as string; where.push("c.status = ?", "c.col = ?"); args.push(st, columnOf(st)); }
    else { where.push("c.col = ?"); args.push(column(col)); }
  }
  const who = q.get("assignee");
  if (who) { where.push("c.assignee = ?"); args.push(assignee(who)); }
  const prio = q.get("priority");
  if (prio) { where.push("c.priority = ?"); args.push(priority(prio)); }
  const chip = q.get("chip");
  if (chip) { where.push("EXISTS (SELECT 1 FROM json_each(c.chips) WHERE value = ?)"); args.push(chip); }
  // ?hide=done leaves one column out and says how many cards it left out:
  // the board's first load (done is the longest column, and every card in
  // it costs the database a few extra reads for its files).
  const hide = q.get("hide");
  let left: Column | undefined;
  if (hide && q.get("removed") !== "1") {
    left = column(hide);
    const kept = COLUMN_KEYS.filter((k) => k !== left);
    where.push(`c.col IN (${kept.map(() => "?").join(",")})`);
    args.push(...kept);
  }
  // One batch for a refresh: ?version=1 adds the change check (read first, so a
  // change made meanwhile shows at the next check), ?chips=1 the chip list.
  const stmts: D1PreparedStatement[] = [];
  const at: { version?: number; count?: number; list: number; chips?: number } = { list: 0 };
  if (q.get("version") === "1") { at.version = stmts.length; stmts.push(versionStatement(env, pid)); }
  if (left) { at.count = stmts.length; stmts.push(env.DB.prepare("SELECT COALESCE((SELECT n FROM column_counts WHERE project_id = ? AND col = ?), 0) AS n").bind(pid, left)); }
  at.list = stmts.length;
  stmts.push(env.DB.prepare(LIST_SQL + " WHERE " + where.join(" AND ") + " ORDER BY c.sort DESC, c.no DESC").bind(...args));
  if (q.get("chips") === "1") { at.chips = stmts.length; stmts.push(chipsStatement(env, pid, false)); }
  const res = await env.DB.batch(stmts);
  return json({
    cards: (res[at.list].results as (CardRow & { filestat: string })[]).map(cardOut),
    ...(left && at.count !== undefined ? { hidden: { col: left, count: (res[at.count].results[0] as { n: number }).n } } : {}),
    ...(at.version !== undefined ? { version: versionOut(res[at.version].results[0] as { v: string | null; c: number | null }) } : {}),
    ...(at.chips !== undefined ? { chips: res[at.chips].results } : {}),
  });
}

// A card's page: the card, its files and its activity in one batch.
async function getCard(env: Env, no: number) {
  const [card, files, activity] = await env.DB.batch([
    env.DB.prepare(LIST_SQL.replace("substr(c.description, 1, 2000) AS description, length(c.description) > 2000 AS cut, '' AS report", "c.description, 0 AS cut, c.report, (SELECT slug FROM projects WHERE id = c.project_id) AS project_key") + " WHERE c.no = ?").bind(no),
    env.DB.prepare("SELECT id, kind, name, type, size, created_at AS createdAt, created_by AS createdBy FROM files WHERE card_no = ? ORDER BY created_at").bind(no),
    env.DB.prepare("SELECT actor, action, detail, at FROM activity WHERE card_no = ? ORDER BY id DESC LIMIT 100").bind(no),
  ]);
  const row = card.results[0] as (CardRow & { project_key: string | null }) | undefined;
  if (!row) throw new InputError("not_found", 404);
  return json({ card: cardOut(row), project: row.project_key, files: files.results, activity: activity.results });
}

async function createCard(env: Env, actor: Actor, b: Record<string, unknown>) {
  if (b.project !== undefined && typeof b.project !== "string") throw new InputError("invalid_fields");
  const pid = await projectId(env, b.project || DEFAULT_PROJECT);
  const titleText = title(b.title);
  const descriptionText = b.description === undefined ? "" : description(b.description);
  const status = statusInput(b) ?? "backlog";
  // (a project may hide some statuses, statuses.js PROJECT_LAYOUTS: a card in a layer its page does not draw would be lost)
  if (!projectStatuses(String(b.project || DEFAULT_PROJECT)).includes(status)) throw new InputError("invalid_status");
  const col = columnOf(status) as Column;
  const who = b.assignee === undefined ? (actor.kind === "agent" ? actor.name : null) : assignee(b.assignee);
  const prio = b.priority === undefined ? null : priority(b.priority);
  const chips = b.chips === undefined ? [] : chipList(b.chips);
  const at = now(), by = actorName(actor);
  // Importing cards from another tracker may keep their numbers (and dates), but
  // only the owner can ask for that; everyone else gets the next free number
  // from the database.
  let fixed: number | null = null;
  if (b.no !== undefined) {
    if (actor.kind !== "owner") throw new InputError("forbidden", 403);
    if (!Number.isInteger(b.no) || (b.no as number) < 1) throw new InputError("invalid_fields");
    fixed = b.no as number;
  }
  const sort = typeof b.sort === "number" ? b.sort : null;
  const createdAt = fixed !== null && typeof b.createdAt === "string" ? b.createdAt : at;
  const updatedAt = fixed !== null && typeof b.updatedAt === "string" ? b.updatedAt : at;
  const source = fixed !== null ? "migrated" : "board";
  const insert = env.DB.prepare(
    `INSERT INTO cards(no, project_id, col, status, title, description, assignee, priority, chips, sort, source, created_at, updated_at, updated_by)
     SELECT COALESCE(?, (SELECT COALESCE(MAX(no),0)+1 FROM cards)), ?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE(?, (SELECT COALESCE(MAX(sort),0)+1 FROM cards WHERE project_id = ? AND col = ?)), ?, ?, ?, ? RETURNING no`,
  ).bind(fixed, pid, col, status, titleText, descriptionText, who, prio, JSON.stringify(chips), sort, pid, col, source, createdAt, updatedAt, by);
  // One batch, one transaction: the chips, the card (a single statement, so the
  // number can't be taken twice) and the column count.
  const results = await env.DB.batch([...ensureChips(env, pid, chips), insert, bump(env, pid, col, 1)]);
  const row = results[chips.length].results[0] as { no: number } | undefined;
  if (!row) throw new InputError("unavailable", 503);
  await log(env, row.no, by, "create", status).run();
  return json({ no: row.no }, 201);
}

async function updateCard(env: Env, actor: Actor, no: number, b: Record<string, unknown>) {
  const row = await env.DB.prepare("SELECT * FROM cards WHERE no = ?").bind(no).first<CardRow>();
  if (!row) throw new InputError("not_found", 404);
  const sets: string[] = [], args: unknown[] = [], logs: [string, string][] = [], counts: D1PreparedStatement[] = [];
  const by = actorName(actor);
  let chips: string[] = [];
  if (b.title !== undefined) { const t = title(b.title); if (t !== row.title) { sets.push("title = ?"); args.push(t); logs.push(["title", t]); } }
  if (b.description !== undefined) { const d = description(b.description); if (d !== row.description) { sets.push("description = ?"); args.push(d); logs.push(["description", ""]); } }
  if (b.assignee !== undefined) { const a = assignee(b.assignee); if (a !== row.assignee) { sets.push("assignee = ?"); args.push(a); logs.push(["assign", a || "none"]); } }
  if (b.priority !== undefined) { const p = priority(b.priority); if (p !== row.priority) { sets.push("priority = ?"); args.push(p); logs.push(["priority", p || "none"]); } }
  if (b.chips !== undefined) {
    chips = chipList(b.chips);
    const old: string[] = JSON.parse(row.chips || "[]");
    const added = chips.filter((c) => !old.includes(c)), removed = old.filter((c) => !chips.includes(c));
    if (added.length || removed.length) {
      sets.push("chips = ?"); args.push(JSON.stringify(chips));
      logs.push(["chips", [...added.map((c) => "+" + c), ...removed.map((c) => "-" + c)].join(" ")]);
    }
  }
  // A status (or the old col) moves the card: `col` follows the status here and
  // nowhere else. The card goes to the top of the new layer unless a sort is given.
  const wanted = statusInput(b);
  const was = statusOut(row);
  if (wanted !== undefined && wanted !== was) {
    const owner = await env.DB.prepare("SELECT slug FROM projects WHERE id = ?").bind(row.project_id).first<{ slug: string }>();
    if (!projectStatuses(owner?.slug ?? DEFAULT_PROJECT).includes(wanted)) throw new InputError("invalid_status");
    const c = columnOf(wanted) as Column;
    sets.push("status = ?"); args.push(wanted); logs.push(["status", `${was} → ${wanted}`]);
    if (c !== row.col) {
      sets.push("col = ?"); args.push(c);
      if (!row.removed_at) counts.push(bump(env, row.project_id, row.col, -1), bump(env, row.project_id, c, 1));
    }
    if (typeof b.sort !== "number") { sets.push("sort = (SELECT COALESCE(MAX(sort),0)+1 FROM cards WHERE project_id = ? AND col = ?)"); args.push(row.project_id, c); }
  }
  if (typeof b.sort === "number" && Number.isFinite(b.sort)) { sets.push("sort = ?"); args.push(b.sort); }
  if (!sets.length) return json({ no, changed: false });
  sets.push("updated_at = ?", "updated_by = ?"); args.push(now(), by);
  await env.DB.batch([
    ...ensureChips(env, row.project_id, chips),
    env.DB.prepare(`UPDATE cards SET ${sets.join(", ")} WHERE no = ?`).bind(...args, no),
    ...counts,
    ...logs.map(([a, d]) => log(env, no, by, a, d)),
  ]);
  return json({ no, changed: true });
}

// Removing hides a card (anyone signed in); it keeps its number and comes
// back with restore. Purging deletes a removed card and its files for
// good, and only the owner can do that.
async function removeCard(env: Env, actor: Actor, no: number, purge: boolean) {
  const row = await env.DB.prepare("SELECT removed_at, project_id, col FROM cards WHERE no = ?").bind(no).first<{ removed_at: string | null; project_id: number; col: string }>();
  if (!row) throw new InputError("not_found", 404);
  const by = actorName(actor);
  if (!purge) {
    if (row.removed_at) return json({ no, removed: true, changed: false });
    const at = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE cards SET removed_at = ?, removed_by = ?, updated_at = ?, updated_by = ? WHERE no = ?").bind(at, by, at, by, no),
      bump(env, row.project_id, row.col, -1),
      log(env, no, by, "remove"),
    ]);
    return json({ no, removed: true, changed: true });
  }
  if (actor.kind !== "owner") throw new InputError("forbidden", 403);
  if (!row.removed_at) throw new InputError("not_removed", 409);
  const { results } = await env.DB.prepare("SELECT id FROM files WHERE card_no = ?").bind(no).all<{ id: string }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM files WHERE card_no = ?").bind(no),
    env.DB.prepare("DELETE FROM comments WHERE card_no = ?").bind(no),
    env.DB.prepare("DELETE FROM cards WHERE no = ?").bind(no),
    log(env, no, by, "purge", "", row.project_id),
  ]);
  if (results.length) await dropObjects(env, results.map((r) => r.id));
  return json({ no, deleted: true });
}

async function restoreCard(env: Env, actor: Actor, no: number) {
  const row = await env.DB.prepare("SELECT removed_at, project_id, col FROM cards WHERE no = ?").bind(no).first<{ removed_at: string | null; project_id: number; col: string }>();
  if (!row) throw new InputError("not_found", 404);
  if (!row.removed_at) return json({ no, changed: false });
  const by = actorName(actor), at = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET removed_at = NULL, removed_by = NULL, updated_at = ?, updated_by = ? WHERE no = ?").bind(at, by, no),
    bump(env, row.project_id, row.col, 1),
    log(env, no, by, "restore"),
  ]);
  return json({ no, changed: true });
}

// ---------------------------------------------------------------- comments

type CommentRow = {
  id: number; card_no: number; author: string; to_actor: string | null; type: string;
  body: string; ref: string; created_at: string; title?: string | null;
};
function commentOut(r: CommentRow) {
  return {
    id: r.id, cardNo: r.card_no, author: r.author, to: r.to_actor, type: r.type, body: r.body, ref: r.ref,
    createdAt: r.created_at, ...(r.title !== undefined ? { cardTitle: r.title ?? "" } : {}),
  };
}
function intParam(v: string | null, fallback: number, min: number, max: number): number {
  const n = v === null || v === "" ? fallback : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError("invalid_fields");
  return n;
}

// The author is the caller (the key or the owner's session), never a field.
async function addComment(env: Env, actor: Actor, no: number, b: Record<string, unknown>) {
  const f = commentFields(b);
  if (actor.kind === "agent" && actor.limited && !["note", "question", "blocked"].includes(f.type)) throw new InputError("forbidden", 403);
  const by = actorName(actor);
  const card = await env.DB.prepare("SELECT project_id FROM cards WHERE no = ?").bind(no).first<{ project_id: number }>();
  if (!card) throw new InputError("not_found", 404);
  const t = Math.floor(Date.now() / 1000);
  // Reserve the quota through the insert trigger and update the card in one
  // transaction. Keep the counter here so the old Worker also remains safe
  // during the migrate-before-deploy window.
  let row: { id: number } | null;
  try {
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO comments(project_id, card_no, author, to_actor, type, body, ref, created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id")
        .bind(card.project_id, no, by, f.to, f.type, f.body, f.ref, now()),
      env.DB.prepare("UPDATE cards SET comment_count = comment_count + 1 WHERE no = ?").bind(no),
    ]);
    row = (results[0].results[0] as { id: number } | undefined) ?? null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("comment_rate_limit")) throw new InputError("comment_rate_limit", 429);
    throw error;
  }
  if (!row) throw new InputError("unavailable", 503);
  // Cleanup has an index and runs once per author/hour, never for rejections.
  if (await env.DB.prepare("SELECT count FROM comment_limits WHERE key = ?").bind(`comment:${by}:${Math.floor(t / 3600)}`).first<number>("count") === 1)
    await env.DB.prepare("DELETE FROM comment_limits WHERE expires_at < ?").bind(t).run().catch(() => {});
  return json({ id: row.id }, 201);
}

// One card's thread, oldest first. ?after= returns only newer comments.
async function cardComments(env: Env, no: number, url: URL) {
  const after = intParam(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url.searchParams.get("limit"), 200, 1, 500);
  // Comment indexes start with the project: the card says which one.
  const card = await env.DB.prepare("SELECT project_id FROM cards WHERE no = ?").bind(no).first<{ project_id: number }>();
  if (!card) throw new InputError("not_found", 404);
  const { results } = await env.DB.prepare(
    "SELECT id, card_no, author, to_actor, type, body, ref, created_at FROM comments WHERE project_id = ? AND card_no = ? AND id > ? ORDER BY id LIMIT ?",
  ).bind(card.project_id, no, after, limit).all<CommentRow>();
  return json({ comments: results.map(commentOut) });
}

// The feed and the inboxes. ?to=<name> is that agent's inbox; ?after=<id> returns
// only newer ones (oldest first), without it the latest ones. The reads are the rows returned (plus the
// card titles when ?titles=1, for the page). ?project=<key> picks the project
// (the default project without it); ?project=all is every project, which is what an inbox wants.
async function listComments(env: Env, url: URL) {
  const after = url.searchParams.get("after");
  const limit = intParam(url.searchParams.get("limit"), 100, 1, 200);
  const where: string[] = [], args: unknown[] = [];
  if (url.searchParams.get("project") !== "all") { where.push("m.project_id = ?"); args.push(await projectIdOf(env, url)); }
  const to = url.searchParams.get("to");
  if (to) { where.push("m.to_actor = ?"); args.push(to); }
  const author = url.searchParams.get("author");
  if (author) { where.push("m.author = ?"); args.push(author); }
  const type = url.searchParams.get("type");
  if (type) { where.push("m.type = ?"); args.push(type); }
  const card = url.searchParams.get("card");
  if (card) { where.push("m.card_no = ?"); args.push(intParam(card, 0, 1, Number.MAX_SAFE_INTEGER)); }
  const titles = url.searchParams.get("titles") === "1";
  const forward = after !== null && after !== "";
  if (forward) { where.push("m.id > ?"); args.push(intParam(after, 0, 0, Number.MAX_SAFE_INTEGER)); }
  const sql = `SELECT m.id, m.card_no, m.author, m.to_actor, m.type, m.body, m.ref, m.created_at${titles ? ", k.title AS title" : ""}
    FROM comments m${titles ? " LEFT JOIN cards k ON k.no = m.card_no" : ""}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
    ORDER BY m.id ${forward ? "ASC" : "DESC"} LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all<CommentRow>();
  if (!forward) results.reverse();
  return json({ comments: results.map(commentOut) });
}

// ---------------------------------------------------------------- files

function sniffImage(type: string, bytes: Uint8Array): boolean {
  if (type === "image/gif") return bytes.length > 6 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF";
  try { imageExtension(type, bytes); return true; } catch { return false; }
}

async function addFiles(env: Env, actor: Actor, no: number, request: Request) {
  const store = bucket(env);
  const exists = await env.DB.prepare("SELECT no FROM cards WHERE no = ?").bind(no).first();
  if (!exists) throw new InputError("not_found", 404);
  let form: FormData;
  try { form = await request.formData(); } catch { throw new InputError("invalid_fields"); }
  const kind = form.get("kind") === "screenshot" ? "screenshot" : "file";
  const entries = form.getAll("file").filter((e): e is File => typeof e !== "string");
  if (!entries.length || entries.length > 10) throw new InputError("invalid_fields");
  const by = actorName(actor), at = now(), out: { id: string; name: string }[] = [];
  for (const f of entries) {
    if (!f.size || f.size > MAX_ATTACHMENT) throw new InputError("too_large", 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const type = f.type || "application/octet-stream";
    if (kind === "screenshot" && !sniffImage(type, bytes)) throw new InputError("invalid_image");
    const id = crypto.randomUUID();
    const name = (f.name || "file").replace(/[\\/\r\n"]/g, "_").slice(0, 200);
    await store.put(id, bytes, { httpMetadata: { contentType: type } });
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO files(id, card_no, kind, name, type, size, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)").bind(id, no, kind, name, type, f.size, at, by),
        env.DB.prepare("UPDATE cards SET updated_at = ?, updated_by = ? WHERE no = ?").bind(at, by, no),
        log(env, no, by, kind === "screenshot" ? "screenshot" : "attach", name),
      ]);
    } catch (e) {
      await dropObjects(env, id);
      throw e;
    }
    out.push({ id, name });
  }
  return json({ files: out }, 201);
}

async function getFile(env: Env, id: string) {
  const store = bucket(env);
  const row = await env.DB.prepare("SELECT name, type, kind FROM files WHERE id = ?").bind(id).first<{ name: string; type: string; kind: string }>();
  if (!row) throw new InputError("not_found", 404);
  const obj = await store.get(id);
  if (!obj) throw new InputError("not_found", 404);
  const image = row.kind === "screenshot" && /^image\/(png|jpeg|webp|gif)$/.test(row.type);
  return new Response(obj.body, {
    headers: {
      "content-type": image ? row.type : "application/octet-stream",
      "content-disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}

async function deleteFile(env: Env, actor: Actor, id: string) {
  const row = await env.DB.prepare("SELECT card_no, name FROM files WHERE id = ?").bind(id).first<{ card_no: number; name: string }>();
  if (!row) throw new InputError("not_found", 404);
  const by = actorName(actor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE cards SET updated_at = ?, updated_by = ? WHERE no = ?").bind(now(), by, row.card_no),
    log(env, row.card_no, by, "remove file", row.name),
  ]);
  await dropObjects(env, id);
  return json({ id, deleted: true });
}

// ---------------------------------------------------------------- chips

async function chipsApi(env: Env, actor: Actor, request: Request, name: string | null, pid: number) {
  const by = actorName(actor);
  if (request.method === "GET" && !name) {
    const counts = new URL(request.url).searchParams.get("counts") === "1";
    return json({ chips: (await chipsStatement(env, pid, counts).all()).results });
  }
  if (request.method === "POST" && !name) {
    const b = await body(request);
    const n = str(b.name, 1, 40);
    const color = b.color === undefined ? "#6b7280" : str(b.color, 7, 7);
    if (!COLOR.test(color)) throw new InputError("invalid_fields");
    await env.DB.prepare("INSERT INTO chips(project_id, name, color, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM chips WHERE project_id = ?)) ON CONFLICT(project_id, name) DO UPDATE SET color = excluded.color").bind(pid, n, color, pid).run();
    return json({ name: n }, 201);
  }
  if (!name) throw new InputError("not_found", 404);
  const chip = await env.DB.prepare("SELECT name FROM chips WHERE project_id = ? AND name = ?").bind(pid, name).first();
  if (!chip) throw new InputError("not_found", 404);
  if (request.method === "PATCH") {
    const b = await body(request);
    const stmts: D1PreparedStatement[] = [];
    if (b.color !== undefined) {
      const color = str(b.color, 7, 7);
      if (!COLOR.test(color)) throw new InputError("invalid_fields");
      stmts.push(env.DB.prepare("UPDATE chips SET color = ? WHERE project_id = ? AND name = ?").bind(color, pid, name));
    }
    if (b.name !== undefined) {
      const to = str(b.name, 1, 40);
      if (to !== name) {
        if (await env.DB.prepare("SELECT 1 FROM chips WHERE project_id = ? AND name = ?").bind(pid, to).first()) throw new InputError("exists", 409);
        stmts.push(
          env.DB.prepare("UPDATE chips SET name = ? WHERE project_id = ? AND name = ?").bind(to, pid, name),
          // Rename inside this project's cards' JSON lists, keeping its position.
          env.DB.prepare(
            "UPDATE cards SET chips = (SELECT json_group_array(CASE WHEN value = ? THEN ? ELSE value END) FROM json_each(cards.chips)) WHERE project_id = ? AND EXISTS (SELECT 1 FROM json_each(cards.chips) WHERE value = ?)",
          ).bind(name, to, pid, name),
          log(env, null, by, "rename chip", `${name} → ${to}`, pid),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ name: (b.name as string) || name });
  }
  if (request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE cards SET chips = (SELECT json_group_array(value) FROM json_each(cards.chips) WHERE value <> ?) WHERE project_id = ? AND EXISTS (SELECT 1 FROM json_each(cards.chips) WHERE value = ?)",
      ).bind(name, pid, name),
      env.DB.prepare("DELETE FROM chips WHERE project_id = ? AND name = ?").bind(pid, name),
      log(env, null, by, "delete chip", name, pid),
    ]);
    return json({ name, deleted: true });
  }
  throw new InputError("not_found", 404);
}

// ---------------------------------------------------------------- feedback

// Visitors' submissions: a card in the feedback column with the "User
// feedback" chip, their screenshots, diagnostics and optional contact.
// Turnstile, bounded multipart, image signatures, hashed-IP quota and retry
// de-duplication.
async function submitFeedback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) throw new InputError("invalid_origin", 403);
  const local = env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!env.DB || (!local && (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET))) throw new InputError("unavailable", 503);
  const form = await boundedForm(request);
  const data = fields(form);
  // Everything is optional, but not nothing at all.
  const imageCount = form.getAll("images").length;
  // Without file storage the form has no image field; a request that carries images anyway is refused, not dropped silently.
  if (imageCount && !env.FILES) throw new InputError("files_disabled", 501);
  if (!hasContent(data, imageCount)) throw new InputError("invalid_fields");
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip && !local) throw new InputError("unavailable", 503);
  const fingerprint = await digest(`${env.TURNSTILE_SECRET || "local"}:${ip || "local"}`);
  const requestKey = await digest(`${fingerprint}:${data.requestId}`);
  const previous = await env.DB.prepare("SELECT no FROM cards WHERE request_key = ?").bind(requestKey).first<{ no: number }>();
  if (previous) return json({ id: `#${previous.no}` });
  if (!local) {
    if (!data.token) throw new InputError("captcha", 403);
    const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: data.token, remoteip: ip, idempotency_key: data.requestId }),
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!check.ok) throw new InputError("unavailable", 503);
    const result = (await check.json()) as { success: boolean; hostname?: string; action?: string };
    if (!result.success || result.hostname !== url.hostname || result.action !== "feedback") throw new InputError("captcha", 403);
  }
  const entries = form.getAll("images");
  if (entries.length > MAX_IMAGES) throw new InputError("too_many_images");
  const images = [];
  for (const entry of entries) {
    if (typeof entry === "string" || !entry.size || entry.size > MAX_FILE) throw new InputError("invalid_image");
    const bytes = new Uint8Array(await entry.arrayBuffer());
    const ext = imageExtension(entry.type, bytes);
    images.push({ bytes, ext, type: entry.type, size: entry.size });
  }
  const t = Math.floor(Date.now() / 1000);
  const rate = await env.DB.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  ).bind(`${fingerprint}:${Math.floor(t / 600)}`, t + 1200).first<{ count: number }>();
  if (!rate || rate.count > 5) throw new InputError("rate_limit", 429);

  const at = now();
  const ids = images.map(() => crypto.randomUUID());
  try {
    if (images.length) {
      const store = bucket(env);
      for (const [i, image] of images.entries()) await store.put(ids[i], image.bytes, { httpMetadata: { contentType: image.type } });
    }
    const chips = ["User feedback"];
    // One transaction: the card gets the next number and its screenshots
    // point at it through the request key.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cards(no, project_id, col, status, title, description, chips, sort, source, report, contact, locale, request_key, created_at, updated_at, updated_by)
         SELECT (SELECT COALESCE(MAX(no),0)+1 FROM cards), ${FEEDBACK_PROJECT}, 'feedback', 'feedback', ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM cards WHERE project_id = ${FEEDBACK_PROJECT} AND col = 'feedback'),
           'feedback', ?, ?, ?, ?, ?, ?, 'visitor'`,
      ).bind(cardTitle(data, images.length), data.description, JSON.stringify(chips), data.report, data.contact, data.locale, requestKey, at, at),
      bump(env, FEEDBACK_PROJECT, "feedback", 1),
      ...images.map((image, i) =>
        env.DB.prepare("INSERT INTO files(id, card_no, kind, name, type, size, created_at, created_by) SELECT ?, no, 'screenshot', ?, ?, ?, ?, 'visitor' FROM cards WHERE request_key = ?")
          .bind(ids[i], `screenshot-${i + 1}.${image.ext}`, image.type, image.size, at, requestKey),
      ),
      env.DB.prepare("INSERT INTO activity(card_no, project_id, actor, action, detail, at) SELECT no, project_id, 'visitor', 'create', 'feedback', ? FROM cards WHERE request_key = ?").bind(at, requestKey),
    ]);
  } catch (error) {
    const existing = await env.DB.prepare("SELECT no FROM cards WHERE request_key = ?").bind(requestKey).first<{ no: number }>().catch(() => undefined);
    // Keep the images when we can't tell whether the card was committed.
    if (existing === null && ids.length) await dropObjects(env, ids);
    if (existing) return json({ id: `#${existing.no}` });
    throw error;
  }
  await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(t).run().catch(() => {});
  const card = await env.DB.prepare("SELECT no FROM cards WHERE request_key = ?").bind(requestKey).first<{ no: number }>();
  return json({ id: card ? `#${card.no}` : "" }, 201);
}

// ---------------------------------------------------------------- routing

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname, method = request.method;
  if (path === "/api/config" && method === "GET") {
    return json({
      siteKey: env.TURNSTILE_SITE_KEY || "",
      development: env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1"].includes(url.hostname),
    });
  }
  // Public: the name the pages show (the PROJECT_NAME var) and whether file storage is on (the FILES binding),
  // for the feedback form, the sign-in page and the board's attach controls.
  if (path === "/api/info" && method === "GET") return json({ projectName: env.PROJECT_NAME || "Board", files: Boolean(env.FILES) });
  if (path === "/api/feedback" && method === "POST") return submitFeedback(request, env);
  if (path === "/api/session" && method === "POST") {
    if (request.headers.get("origin") !== url.origin) throw new InputError("invalid_origin", 403);
    const b = await body(request);
    // Local development only: sign in as the owner without the key.
    const local = env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (local && b.dev === true) return json({ name: OWNER_ASSIGNEE.name }, 200, { "set-cookie": await sessionCookie(env) });
    // The owner key (the OWNER_KEY secret) makes the caller the owner: a signed session cookie.
    const given = str(b.key, 1, 500);
    if (!env.SESSION_SECRET || !(await isOwnerKey(env, given))) throw new InputError("not_owner", 403);
    return json({ name: OWNER_ASSIGNEE.name }, 200, { "set-cookie": await sessionCookie(env) });
  }
  if (path === "/api/session" && method === "DELETE") return json({ ok: true }, 200, { "set-cookie": CLEAR_COOKIE });

  const actor = await actorOf(env, request);
  if (!actor) throw new InputError("unauthorized", 401);
  // A limited agent (the QA role) reads, and posts one thing: a comment on a card (the type is checked in addComment).
  if (actor.kind === "agent" && actor.limited && method !== "GET" && method !== "HEAD" && !/^\/api\/cards\/\d+\/comments$/.test(path)) throw new InputError("forbidden", 403);
  if (path === "/api/me") return json({ actor: actor.kind, name: actor.name });
  // Who can be assigned or written to: the page and the command line build their lists from this.
  if (path === "/api/agents" && method === "GET") return json({ agents: AGENT_LIST, owner: OWNER_ASSIGNEE });
  // Cheap change check for the board's polling (D1's free tier counts every row a query scans).
  if (path === "/api/version" && method === "GET") return json(versionOut(await versionStatement(env, await projectIdOf(env, url)).first()));

  const parts = path.split("/").filter(Boolean); // ["api", "cards", "12", "files"]
  if (parts[1] === "projects") {
    if (parts.length === 2 && method === "GET") return listProjects(env);
    if (parts.length === 2 && method === "POST") return createProject(env, actor, await body(request));
    if (parts.length === 3 && method === "PATCH") return renameProject(env, actor, decodeURIComponent(parts[2]), await body(request));
    throw new InputError("not_found", 404);
  }
  if (parts[1] === "cards") {
    if (parts.length === 2) {
      if (method === "GET") return listCards(env, url);
      if (method === "POST") return createCard(env, actor, await body(request));
    }
    const no = Number(parts[2]);
    if (!Number.isInteger(no) || no < 1) throw new InputError("not_found", 404);
    if (parts.length === 3) {
      if (method === "GET") return getCard(env, no);
      if (method === "PATCH") return updateCard(env, actor, no, await body(request));
      if (method === "DELETE") return removeCard(env, actor, no, url.searchParams.get("purge") === "1");
    }
    if (parts.length === 4 && parts[3] === "restore" && method === "POST") return restoreCard(env, actor, no);
    if (parts.length === 4 && parts[3] === "comments") {
      if (method === "GET") return cardComments(env, no, url);
      if (method === "POST") return addComment(env, actor, no, await body(request));
    }
    if (parts.length === 4 && parts[3] === "files" && method === "POST") return addFiles(env, actor, no, request);
  }
  if (parts[1] === "files" && parts.length === 3) {
    if (method === "GET") return getFile(env, parts[2]);
    if (method === "DELETE") return deleteFile(env, actor, parts[2]);
  }
  if (parts[1] === "comments" && parts.length === 2 && method === "GET") return listComments(env, url);
  if (parts[1] === "chips") return chipsApi(env, actor, request, parts[2] ? decodeURIComponent(parts[2]) : null, await projectIdOf(env, url));
  if (parts[1] === "activity" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT card_no AS no, actor, action, detail, at FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 200").bind(await projectIdOf(env, url)).all();
    return json({ activity: results });
  }
  throw new InputError("not_found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return Response.redirect(url.origin + "/feedback/", 302);
      if (url.pathname === "/feedback" || url.pathname === "/board") return Response.redirect(url.origin + url.pathname + "/", 301);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof InputError) {
        const message = COMMENT_ERRORS[error.code as keyof typeof COMMENT_ERRORS];
        return json({ error: error.code, ...(message ? { message } : {}) }, error.status,
          error.code === "comment_rate_limit" ? { "retry-after": String(3600 - Math.floor(Date.now() / 1000) % 3600) } : {});
      }
      // Card text, contacts and keys must never enter logs.
      // D1 messages carry the SQL text, never the bound values.
      console.error("Request failed", url.pathname, error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "");
      return json({ error: "unavailable" }, 503);
    }
  },
};
