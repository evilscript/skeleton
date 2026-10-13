#!/usr/bin/env node
// The agents' way into the board: list, read, create and change cards, chips and attachments.
//
// The board has several projects. list, new, chips, feed and version work in
// one: --project <key>, or BOARD_PROJECT, or board.defaultProject from
// skeleton.config.json, or main when none is given. Cards are identified by
// number across all projects, so show, set, move, remove, restore, attach,
// comment and thread don't need it.
//
//   board projects                           list the projects (key, name)
//   board projects add "name" [--key my-key]   new project (the key comes from the name if it has latin letters)
//   board projects rename my-key "New name"
//   board list [--status todo] [--col backlog] [--assignee <name>] [--priority blocker] [--chip Bug] [--all] [--json]   done cards are left out unless --col done or --all (reading them costs the database a thousand rows a time)
//   board show 12 [--json]
//   board new "title" [--desc text | --desc-file f] [--status backlog] [--assignee <name from board agents>|none] [--priority minor|major|critical|blocker] [--chip A]...
//   board set 12 [--title t] [--desc text | --desc-file f] [--status on_prod_qa] [--assignee <name>|none] [--priority major|none]
//   board move 12 pr_review                  a status, or a column name (progress, testing: its first status)
//   board chip 12 +Bug -Feature
//   board attach 12 shot.png [more...] [--screenshot]
//   board remove 12 [13...]                  hide cards (they keep their numbers)
//   board restore 12                         bring a removed card back
//   board list --removed                     the removed cards
//   board chips [--json]                      list chips
//   board chips add "name" [--color #2563eb]   (also: rename "old" "new", color "name" "#hex", delete "name")
//   board comment 12 "text" [--to <name from board agents>|owner] [--type note|assign|started|blocked|question|review|merged|decision] [--ref https://...] [--body-file f]
//   board thread 12 [--json]                 one card's conversation
//   board inbox [--since 17] [--peek] [--json]   comments addressed to you that you haven't seen, in every project (the cursor is kept in ~/.boardkit/<slug>/)
//   board feed [--limit 50] [--author <name>] [--type review] [--json]   the latest comments on every card (--project all: every project)
//   board brief 12 [--dir d] [--json]        the whole card in one folder: brief.md (description, every comment in full) and its screenshots and files downloaded
//   board agents                             the names that can be assigned and written to (the Worker's list, src/agents.ts)
//   board whoami                             the name the Worker knows your key by, next to BOARD_AS
//   board version [--json]                   the one-row change check: any card of the project changed, its newest comment number
//   board usage [--json]                     today's UTC D1 row use, from Wrangler insights
//
// Statuses (docs/STATUSES.md) and the column that shows each:
//   Feedback        feedback
//   Backlog         backlog (Backlog), todo (To do)
//   In progress     progress (In progress), pr_review (PR reviewing), on_main (On Main),
//                   spike_ready (Spike report ready: a spike's report is on the default branch, the Owner decides)
//   Ready for QA    probe_needed (Owner check needed: something only the Owner can run or verify by hand,
//                   with the steps on the card), on_prod_qa (On Prod for QA), qa_later (QA later)
//   Done            done
// A new card starts in backlog; the Owner moves one to todo when work should start on it.
// The old words still work: --col/move todo = todo, later = qa_later, testing = on_prod_qa,
// a column name = its first status. list --col <column> lists a whole column.
// Assignees: the names `board agents` lists, which include the Owner. Priorities: minor major critical blocker.
//
// Where it talks to, and who you are (environment variables; the key is never printed):
//   BOARD_URL       the board's address; default board.url from skeleton.config.json (found by walking up from
//                   this file's directory, then from the current directory)
//   BOARD_AS        your name on the board (board agents lists them)
//   BOARD_KEY       your key; or BOARD_KEY_<NAME> (the board name in capitals, - as _: BOARD_KEY_MY_AGENT), read first,
//                   for a machine that several agents share: each session then says who it is with BOARD_AS alone, and the
//                   plain BOARD_KEY is checked against BOARD_AS once (GET /api/me) so a wrong key can't write under
//                   another agent's name
//   BOARD_AUTH=proxy   a cloud session whose proxy adds the credential on the way out: the CLI sends no key of its own
//   BOARD_PROJECT   the project key; default board.defaultProject
// Without those, the key for BOARD_AS is read from the macOS Keychain (service board.keychainService from the config,
// account = the board name), then from the key file ~/.boardkit/<slug>/keys/<board name> (mode 600; <slug> is
// project.slug, or "default" without a config).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { COMMENT_ERRORS, commentBodyError } from "../public/board/comment-rules.js";
import { COLUMN_KEYS, STATUS_SLUGS, statusFromWord } from "../public/board/statuses.js";
import { boardSettings } from "./config.mjs";
import { boardUsage, usageText } from "./usage.mjs";

let SETTINGS;
try { SETTINGS = boardSettings(); } catch (error) { console.error("board: " + error.message); process.exit(1); }
const BASE = SETTINGS.url;
const COLS = [...COLUMN_KEYS, "todo", "later"];
const PRIORITIES = ["minor", "major", "critical", "blocker"];
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".log": "text/plain", ".zip": "application/zip", ".pdf": "application/pdf" };

function die(msg) {
  console.error("board: " + msg);
  process.exit(1);
}
// The project a command works in; nothing means the server's default (main).
const projectKey = () => flags.project || process.env.BOARD_PROJECT || SETTINGS.defaultProject;
function scoped(path) {
  const p = projectKey();
  return p ? `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(p)}` : path;
}
const ownKeyName = (as) => "BOARD_KEY_" + String(as).toUpperCase().replace(/[^A-Z0-9]/g, "_");
// The macOS Keychain, when there is one (the `security` tool); null when it has no item for this name.
function keychainKey(who) {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", SETTINGS.keychainService, "-a", who, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}
// The key file ~/.boardkit/<slug>/keys/<board name>, for machines without a Keychain.
function keyFile(who) {
  return join(SETTINGS.keyDir, basename(who));
}
function fileKey(who) {
  try { return readFileSync(keyFile(who), "utf8").trim() || null; } catch { return null; }
}
function key() {
  const as = process.env.BOARD_AS;
  if (as && process.env[ownKeyName(as)]) return process.env[ownKeyName(as)];
  if (process.env.BOARD_KEY) return process.env.BOARD_KEY;
  if (!as) die("set BOARD_AS=<your name on the board> (board agents lists them), or BOARD_KEY");
  const stored = keychainKey(as) || fileKey(as);
  if (stored) return stored;
  die(`no key for ${as}: set ${ownKeyName(as)} or BOARD_KEY, or store it in the Keychain (service "${SETTINGS.keychainService}") or in ${keyFile(as)}; the Lead adds a developer with scripts/add-agent.sh`);
}
const authHeaders = () => (process.env.BOARD_AUTH === "proxy" ? {} : { authorization: "Bearer " + key() });
// The plain BOARD_KEY next to a BOARD_AS: whose key is it? One question per run.
let identityChecked = false;
async function checkIdentity(headers) {
  if (identityChecked) return;
  identityChecked = true;
  const as = process.env.BOARD_AS;
  if (!as || !process.env.BOARD_KEY || process.env[ownKeyName(as)] || process.env.BOARD_AUTH === "proxy") return;
  const me = await fetch(BASE + "/api/me", { headers }).then((r) => r.json()).catch(() => null);
  if (me && me.actor === "agent" && me.name && me.name !== as) {
    die(`BOARD_KEY is ${me.name}'s key but BOARD_AS is ${as}: set ${ownKeyName(as)} to ${as}'s own key (or fix BOARD_AS)`);
  }
}
async function call(method, path, body) {
  if (!BASE) die("no board address: set BOARD_URL, or board.url in skeleton.config.json");
  const headers = authHeaders();
  await checkIdentity(headers);
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
  let res;
  try { res = await fetch(BASE + path, { method, headers, body: payload }); }
  catch (e) { die(`cannot reach the board at ${BASE}: ${(e.cause && e.cause.code) || e.message}`); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    let hint = "";
    if (out.error === "invalid_assignee" || out.error === "invalid_to") {
      const list = await fetch(BASE + "/api/agents", { headers }).then((r) => r.json()).catch(() => null);
      if (list) hint = ` (valid: ${[...list.agents.map((a) => a.name), out.error === "invalid_to" ? "owner" : list.owner.name].join(" ")}${out.error === "invalid_assignee" ? " none" : ""})`;
    }
    die(`${method} ${path}: ${res.status} ${COMMENT_ERRORS[out.error] || out.message || out.error || ""}${hint}`);
  }
  return out;
}

// Flags: --name value (repeatable ones collect into arrays); the rest are positional.
function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const bool = ["json", "screenshot", "removed", "peek", "all"].includes(name);
      const v = bool ? true : argv[++i];
      if (v === undefined) die(`--${name} needs a value`);
      if (name === "chip") (flags.chip ||= []).push(v);
      else flags[name] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}
function num(v) {
  const n = Number(String(v || "").replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) die("card number expected, e.g. 12");
  return n;
}
function col(v) {
  if (!COLS.includes(v)) die(`column must be one of: ${COLS.join(" ")}`);
  return v;
}
// A status for a card: a slug, or the old column words (see the header).
function status(v) {
  const s = statusFromWord(v);
  if (!s) die(`status must be one of: ${STATUS_SLUGS.join(" ")} (or a column: ${COLS.join(" ")})`);
  return s;
}
function who(v) {
  // The Worker checks the name against its list (src/agents.ts); a wrong one is answered with the valid ones (call).
  return v === "none" ? null : v;
}
function prio(v) {
  if (v === "none") return null;
  if (!PRIORITIES.includes(v)) die(`priority must be one of: ${PRIORITIES.join(" ")} none`);
  return v;
}
function desc(flags) {
  if (flags["desc-file"] !== undefined) return readFileSync(flags["desc-file"], "utf8");
  return flags.desc;
}
// Times in the Owner's time zone (owner.timezone in the config; this machine's own without one), short.
const clockZone = (zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
let clock;
try { clock = clockZone(SETTINGS.timezone); } catch { clock = clockZone(undefined); }
function when(iso) {
  const p = Object.fromEntries(clock.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}
function commentLine(m, withCard) {
  const to = m.to ? ` → ${m.to}` : "";
  const card = withCard ? ` #${m.cardNo}${m.cardTitle ? " " + m.cardTitle : ""}\n  ` : " ";
  return `[${m.id}] ${when(m.createdAt)} ${m.author}${to} (${m.type})${card}${m.body.replace(/\n/g, "\n  ")}${m.ref ? "\n  " + m.ref : ""}`;
}
function me() {
  const w = process.env.BOARD_AS;
  if (!w) die("set BOARD_AS=<your name on the board> (the inbox is yours; board agents lists them)");
  return w;
}
function line(c) {
  const chips = c.chips.length ? " [" + c.chips.join(", ") + "]" : "";
  return `#${c.no}\t${c.status || c.col}\t${c.assignee || "-"}\t${c.priority ? `(${c.priority}) ` : ""}${c.title}${chips}`;
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, flags } = parse(rest);

switch (cmd) {
  case "list": {
    const q = new URLSearchParams();
    if (flags.status) q.set("status", status(flags.status));
    if (flags.col) q.set("col", col(flags.col));
    if (flags.assignee) q.set("assignee", flags.assignee);
    if (flags.priority) q.set("priority", flags.priority);
    if (flags.chip) q.set("chip", flags.chip[0]);
    if (flags.removed) q.set("removed", "1");
    // Done is the longest column: left out (and counted) unless asked for.
    if (!flags.col && flags.status !== "done" && !flags.all && !flags.removed) q.set("hide", "done");
    const { cards, hidden } = await call("GET", scoped("/api/cards" + (q.size ? "?" + q : "")));
    if (flags.json) console.log(JSON.stringify(cards, null, 2));
    else for (const c of cards) console.log(line(c));
    if (hidden && hidden.count) console.error(`(${hidden.count} done cards not listed: --col done, or --all for everything)`);
    break;
  }
  case "show": {
    const out = await call("GET", `/api/cards/${num(pos[0])}`);
    if (flags.json) { console.log(JSON.stringify(out, null, 2)); break; }
    const c = out.card;
    console.log(line(c));
    console.log(`updated ${c.updatedAt} by ${c.updatedBy}; source ${c.source}${out.project ? "; project " + out.project : ""}`);
    if (c.description) console.log("\n" + c.description);
    if (c.report) console.log("\n--- report ---\n" + c.report);
    if (c.contact) console.log("\ncontact: " + c.contact);
    for (const f of out.files) console.log(`\n${f.kind}: ${f.name} (${f.size} bytes) ${BASE}/api/files/${f.id}`);
    break;
  }
  case "brief": {
    // Everything about a card in one folder: the description, every comment in full, and the screenshots and
    // attachments downloaded with the caller's own key. For a developer that can't fetch images itself (a sandbox,
    // a runtime without the key): it reads brief.md and opens the local files.
    const no = num(pos[0]);
    const out = await call("GET", `/api/cards/${no}`);
    const { comments } = await call("GET", `/api/cards/${no}/comments`);
    const dir = flags.dir || join(process.env.BOARD_BRIEF_DIR || join(SETTINGS.stateDir, "briefs"), String(no));
    mkdirSync(dir, { recursive: true });
    const c = out.card;
    const saved = [];
    for (const f of out.files || []) {
      const name = `${f.id.slice(0, 8)}-${basename(f.name || "file").replace(/[^\w.\-]+/g, "_")}`;
      const res = await fetch(`${BASE}/api/files/${f.id}`, { headers: authHeaders() });
      if (!res.ok) { console.error(`board: file ${f.id}: ${res.status}`); continue; }
      writeFileSync(join(dir, name), Buffer.from(await res.arrayBuffer()));
      saved.push({ kind: f.kind, name: f.name, path: join(dir, name), size: f.size });
    }
    const md = [`# #${no} ${c.title}`, "", `status ${c.status} · assignee ${c.assignee || "-"} · priority ${c.priority || "-"} · chips ${c.chips.join(", ") || "-"}`,
      `updated ${c.updatedAt} by ${c.updatedBy}`, "", c.description || "(no description)", ""];
    if (c.report) md.push("## report", c.report, "");
    md.push("## attachments", ...(saved.length ? saved.map((f) => `- ${f.kind}: ${f.name} (${f.size} bytes) → ${f.path}`) : ["(none)"]), "");
    md.push("## comments (oldest first, in full)", "", ...(comments.length ? comments.map((m) => commentLine(m, false) + "\n") : ["(no comments)"]));
    writeFileSync(join(dir, "brief.md"), md.join("\n"));
    if (flags.json) console.log(JSON.stringify({ dir, brief: join(dir, "brief.md"), files: saved }));
    else { console.log(join(dir, "brief.md")); for (const f of saved) console.log(f.path); }
    break;
  }
  case "new": {
    if (!pos[0]) die('title expected: board new "title"');
    const b = { title: pos.join(" ") };
    const d = desc(flags);
    if (d !== undefined) b.description = d;
    if (flags.status || flags.col) b.status = status(flags.status || flags.col);
    if (flags.assignee) b.assignee = who(flags.assignee);
    if (flags.priority) b.priority = prio(flags.priority);
    if (flags.chip) b.chips = flags.chip;
    const project = projectKey();
    if (project) b.project = project;
    const { no } = await call("POST", "/api/cards", b);
    console.log("#" + no);
    break;
  }
  case "set": {
    const n = num(pos[0]), b = {};
    if (flags.title) b.title = flags.title;
    const d = desc(flags);
    if (d !== undefined) b.description = d;
    if (flags.status || flags.col) b.status = status(flags.status || flags.col);
    if (flags.assignee) b.assignee = who(flags.assignee);
    if (flags.priority) b.priority = prio(flags.priority);
    if (!Object.keys(b).length) die("nothing to change");
    const out = await call("PATCH", `/api/cards/${n}`, b);
    console.log(`#${n} ${out.changed ? "updated" : "unchanged"}`);
    break;
  }
  case "move": {
    const n = num(pos[0]);
    if (!pos[1]) die(`move 12 <status>: ${STATUS_SLUGS.join(" ")}`);
    const s = status(pos[1]);
    await call("PATCH", `/api/cards/${n}`, { status: s });
    console.log(`#${n} → ${s}`);
    break;
  }
  case "chip": {
    const n = num(pos[0]);
    const { card } = await call("GET", `/api/cards/${n}`);
    let list = card.chips;
    for (const p of pos.slice(1)) {
      if (p.startsWith("+")) { if (!list.includes(p.slice(1))) list = [...list, p.slice(1)]; }
      else if (p.startsWith("-")) list = list.filter((x) => x !== p.slice(1));
      else die("use +Chip to add, -Chip to remove");
    }
    await call("PATCH", `/api/cards/${n}`, { chips: list });
    console.log(`#${n} chips: ${list.join(", ") || "(none)"}`);
    break;
  }
  case "attach": {
    const n = num(pos[0]);
    if (pos.length < 2) die("file expected");
    const form = new FormData();
    form.append("kind", flags.screenshot ? "screenshot" : "file");
    for (const p of pos.slice(1)) {
      if (statSync(p).size > 25 * 1024 * 1024) die(`${p} is over 25 MB`);
      const type = TYPES[extname(p).toLowerCase()] || "application/octet-stream";
      form.append("file", new Blob([readFileSync(p)], { type }), basename(p));
    }
    const { files } = await call("POST", `/api/cards/${n}/files`, form);
    for (const f of files) console.log(`#${n} + ${f.name}`);
    break;
  }
  case "remove": {
    if (!pos.length) die("card number expected");
    for (const p of pos) { const n = num(p); await call("DELETE", `/api/cards/${n}`); console.log(`#${n} removed`); }
    break;
  }
  case "restore": {
    const n = num(pos[0]);
    await call("POST", `/api/cards/${n}/restore`);
    console.log(`#${n} restored`);
    break;
  }
  case "projects": {
    const [sub, a, b] = pos;
    if (!sub) {
      const { projects } = await call("GET", "/api/projects");
      if (flags.json) console.log(JSON.stringify(projects, null, 2));
      else for (const p of projects) console.log(`${p.slug}\t${p.name}`);
    } else if (sub === "add") {
      if (!a) die('name expected: board projects add "name" [--key my-key]');
      const out = await call("POST", "/api/projects", { name: a, ...(flags.key ? { key: flags.key } : {}) });
      console.log(`${out.slug}\t${out.name}`);
    } else if (sub === "rename") {
      if (!a || !b) die('board projects rename my-key "New name"');
      await call("PATCH", `/api/projects/${encodeURIComponent(a)}`, { name: b });
      console.log(`${a} → ${b}`);
    } else die("projects: add | rename");
    break;
  }
  case "chips": {
    const [sub, a, b] = pos;
    if (!sub) {
      const { chips } = await call("GET", scoped("/api/chips?counts=1"));
      if (flags.json) console.log(JSON.stringify(chips, null, 2));
      else for (const c of chips) console.log(`${c.name}\t${c.color}\t${c.used}`);
    } else if (sub === "add") {
      await call("POST", scoped("/api/chips"), { name: a, ...(flags.color ? { color: flags.color } : {}) });
      console.log("added " + a);
    } else if (sub === "rename") {
      await call("PATCH", scoped(`/api/chips/${encodeURIComponent(a)}`), { name: b });
      console.log(`${a} → ${b}`);
    } else if (sub === "color") {
      await call("PATCH", scoped(`/api/chips/${encodeURIComponent(a)}`), { color: b });
      console.log(`${a} ${b}`);
    } else if (sub === "delete") {
      await call("DELETE", scoped(`/api/chips/${encodeURIComponent(a)}`));
      console.log("deleted " + a);
    } else die("chips: add | rename | color | delete");
    break;
  }
  case "comment": {
    const n = num(pos[0]);
    const text = flags["body-file"] !== undefined ? readFileSync(flags["body-file"], "utf8") : pos.slice(1).join(" ");
    if (!text.trim()) die('text expected: board comment 12 "text"');
    const error = commentBodyError(text);
    if (error) die(COMMENT_ERRORS[error]);
    const b = { body: text };
    if (flags.to) b.to = flags.to;
    if (flags.type) b.type = flags.type;
    if (flags.ref) b.ref = flags.ref;
    const { id } = await call("POST", `/api/cards/${n}/comments`, b);
    console.log(`#${n} comment [${id}]`);
    break;
  }
  case "thread": {
    const { comments } = await call("GET", `/api/cards/${num(pos[0])}/comments`);
    if (flags.json) console.log(JSON.stringify(comments, null, 2));
    else if (!comments.length) console.log("(no comments)");
    else for (const m of comments) console.log(commentLine(m, false));
    break;
  }
  case "inbox": {
    const as = me();
    const file = join(SETTINGS.stateDir, `inbox-${basename(as)}.json`);
    let after = 0;
    try { after = JSON.parse(readFileSync(file, "utf8")).after || 0; } catch {}
    if (flags.since !== undefined) after = Number(flags.since) || 0;
    const { comments } = await call("GET", `/api/comments?to=${as}&after=${after}&limit=200&titles=1&project=all`);
    if (flags.json) console.log(JSON.stringify(comments, null, 2));
    else if (!comments.length) console.log("(nothing new)");
    else for (const m of comments) console.log(commentLine(m, true));
    if (comments.length && !flags.peek) {
      mkdirSync(SETTINGS.stateDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ after: comments[comments.length - 1].id }));
    }
    break;
  }
  case "feed": {
    const q = new URLSearchParams({ titles: "1", limit: String(Number(flags.limit) || 50) });
    if (flags.author) q.set("author", flags.author);
    if (flags.type) q.set("type", flags.type);
    if (flags.to) q.set("to", flags.to);
    const { comments } = await call("GET", scoped("/api/comments?" + q));
    if (flags.json) console.log(JSON.stringify(comments, null, 2));
    else if (!comments.length) console.log("(no comments)");
    else for (const m of comments) console.log(commentLine(m, true));
    break;
  }
  case "usage": {
    try {
      const out = boardUsage();
      console.log(flags.json ? JSON.stringify(out, null, 2) : usageText(out));
    } catch (error) { die(error.message); }
    break;
  }
  case "agents": {
    const list = await call("GET", "/api/agents");
    for (const a of list.agents) console.log(`${a.name}\t${a.label}`);
    console.log(`${list.owner.name}\t${list.owner.label} (the Owner: assignee, and comment target "owner")`);
    break;
  }
  case "whoami": {
    // Whose key the Worker sees (and what BOARD_AS says): the check for a machine that several agents share.
    const me = await call("GET", "/api/me");
    const list = await call("GET", "/api/agents");
    const mine = list.agents.find((a) => a.name === me.name) || {};
    const label = mine.label || "";
    const limited = mine.limited ? " (limited: comments of type note, question and blocked only)" : "";
    console.log(`${me.name}${label ? " (" + label + ")" : ""}${limited}   BOARD_AS=${process.env.BOARD_AS || "-"}`);
    break;
  }
  case "version": {
    const out = await call("GET", scoped("/api/version"));
    console.log(flags.json ? JSON.stringify(out) : `cards ${out.v || "-"}  comments ${out.c}`);
    break;
  }
  default:
    // The usage is the comment at the top of this file.
    const head = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
    console.log(head.slice(0, head.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(cmd ? 1 : 0);
}
