// The board: one page per project (a switcher in the top bar), columns for the
// statuses (Done in a floating panel), cards with chips, assignee, description,
// screenshots and files. Data comes from the Worker's /api; the owner signs
// in with the owner key, the agents use the CLI with their own keys.
// A card has a status (docs/STATUSES.md); a column draws one bordered layer
// per status it holds. public/board/statuses.js says which.
import { commentBodyError, COMMENT_ERRORS } from "./comment-rules.js";
import { columnOf, STATUSES, statusLabelFor, VIEW_COLUMNS, viewColumnOf, viewStatusesFor } from "./statuses.js";

// The columns the page draws (statuses.js VIEW_COLUMNS), each with the colour of its dot.
const COLUMNS = VIEW_COLUMNS.map((c) => [c.key, c.label, `--c-${c.key}`]);
// Who works on a card: the agents and the owner. The agents are the Worker's
// list (src/agents.ts), read from /api/agents when the page starts, so a new
// developer needs no change here.
let OWNER = { name: "owner", label: "Owner" };
let AGENTS = { owner: "Owner" };
let TARGETS = [["owner", "Owner"]];
let AGENT_INDEX = {};   // agent name -> its place in the list, which picks its colour
let BRAND = "Board";    // the name the pages show (GET /api/info)
let FILES = true;       // file storage is on (GET /api/info "files"); without it the attach controls are hidden
// "owner" is the author of everything the owner does on the page; OWNER.name is the owner's assignee name.
const isOwner = (name) => name === "owner" || name === OWNER.name;
// The owner has a colour of its own in the style sheet; the agents take one from a palette.
const agentStyle = (name) => (isOwner(name) || AGENT_INDEX[name] === undefined ? null
  : { "--ag": `var(--x${AGENT_INDEX[name] % 4})`, "--ag-bg": `var(--x${AGENT_INDEX[name] % 4}-bg)` });
async function loadAgents() {
  const res = await fetch("/api/agents");
  if (!res.ok) return;
  const data = await res.json();
  OWNER = data.owner;
  AGENTS = Object.fromEntries([...data.agents.map((a) => [a.name, a.label]), [data.owner.name, data.owner.label]]);
  TARGETS = [...data.agents.map((a) => [a.name, a.label]), ["owner", data.owner.label]];
  AGENT_INDEX = Object.fromEntries(data.agents.map((a, i) => [a.name, i]));
  $("f-assignee").replaceChildren(...[["", "Anyone"], ...Object.entries(AGENTS), ["none", "Nobody"]].map(([v, l]) => el("option", { value: v }, l)));
}
// The public name from the Worker (the PROJECT_NAME var); "Board" when it is missing.
async function loadBrand() {
  try {
    const res = await fetch("/api/info");
    if (res.ok) {
      const info = await res.json();
      BRAND = info.projectName || BRAND;
      FILES = info.files !== false;
    }
  } catch {}
  $("gate-title").textContent = BRAND;
  if (!project) document.title = BRAND;
}
// Highest first, as the pickers list them; null is none.
const PRIORITIES = [["blocker", "Blocker"], ["critical", "Critical"], ["major", "Major"], ["minor", "Minor"]];
const PRIORITY = Object.fromEntries(PRIORITIES);
const TYPES = { note: "Note", assign: "Assign", started: "Started", blocked: "Blocked", question: "Question", review: "Review", merged: "Merged", decision: "Decision" };
const FILTERS = ["q", "f-assignee", "f-priority", "f-chip"];
const PAGE = 60; // cards shown per column before "show more"

const $ = (id) => document.getElementById(id);
let me = null, cards = [], chips = [], shown = {}, dragging = null, openNo = null;
// The order of a column's layers is the owner's to change (buttons on a layer's
// header) and is remembered in this browser, per project: { progress: ["pr_review", ...] }.
let layerPrefs = {};
const layersKey = () => "board.layers." + project;
function loadLayerPrefs() {
  layerPrefs = {};
  try { layerPrefs = JSON.parse(localStorage.getItem(layersKey()) || "{}") || {}; } catch {}
}
// The statuses of a column, top layer first: the saved order, then any the
// saved order doesn't know (a status added later) in their default places.
function layerOrder(colKey) {
  const all = viewStatusesFor(project, colKey), saved = Array.isArray(layerPrefs[colKey]) ? layerPrefs[colKey] : [];
  const out = saved.filter((x) => all.includes(x));
  all.forEach((slug, i) => {
    if (out.includes(slug)) return;
    const next = all.slice(i + 1).find((x) => out.includes(x));
    if (next) out.splice(out.indexOf(next), 0, slug); else out.push(slug);
  });
  return out;
}
function moveLayer(colKey, slug, by) {
  const order = layerOrder(colKey), i = order.indexOf(slug), j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  layerPrefs[colKey] = order;
  try { localStorage.setItem(layersKey(), JSON.stringify(layerPrefs)); } catch {}
  render();
}
// Projects: every card, chip and comment belongs to one. `project` is the
// current one's key; the cards, chips and comments calls carry it (inProject).
// Card numbers are global, so a call about one card doesn't need it.
let projects = [], project = null;
const inProject = (path) => `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
// The Done column is the longest and the slowest to load, so a visit starts
// without it. It isn't a board column: the top bar's Done button opens it as a
// floating panel, which loads it; closing the panel unloads it.
let doneLoaded = false, doneHidden = 0, doneOpen = false;
// Comments. lastC: the newest comment number pulled; seenC: the last one
// the owner has read (kept in the browser); countedUpTo: what the cards'
// commentCount already includes. Polling asks /api/version (one row) and pulls
// only comments newer than lastC, so the page never re-reads the conversation.
let lastC = 0, seenC = null, unread = [], countedUpTo = 0, feedOpen = false, openThread = null;
// Each project keeps its own read mark (comment numbers are global).
const seenKey = () => "board.seenC." + project;
function loadSeen() {
  seenC = null;
  try {
    const v = localStorage.getItem(seenKey());
    seenC = v === null ? null : Number(v);
  } catch {}
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style") for (const [p, val] of Object.entries(v)) e.style.setProperty(p, val);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
// undo = { label, run }: a button that stays a little longer than plain text.
function toast(text, undo) {
  const t = $("toast");
  t.textContent = text;
  if (undo) {
    t.append(" ", el("button", { type: "button", class: "btn small", onclick: () => { t.hidden = true; undo.run(); } }, undo.label));
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), undo ? 7000 : 3000);
}
const ERRORS = { unauthorized: "Your session expired; reload the page", forbidden: "Not allowed", not_found: "Card not found", too_large: "The file is too large (25 MB at most)", invalid_image: "Screenshots must be PNG, JPEG, WebP or GIF", exists: "That name is already taken", invalid_fields: "Invalid content", title_length: "The title must be 1 to 200 characters", description_too_long: "The description is too long (about 1.8 MB at most); attach very long content as a file", rate_limit: "Too fast: at most 60 comments per author per hour", comment_too_long: "The comment is too long (4 KB at most); put long content in a link", invalid_ref: "A link must start with http:// or https://", invalid_type: "Invalid comment type", invalid_to: "Invalid recipient", invalid_key: "A project key uses lowercase letters, digits and hyphens only (30 characters at most, \"all\" is reserved); give one when the name has no latin letters", invalid_name: "A project name must be 1 to 60 characters", project_exists: "A project with that key already exists", too_many_projects: "Too many projects (50 at most)", unknown_project: "Project not found", invalid_assignee: "Unknown assignee", invalid_priority: "Invalid priority", invalid_status: "Invalid status", invalid_column: "Invalid column", files_disabled: "This board has no file storage", not_owner: "That is not the owner key" };

async function call(method, path, data) {
  const opts = { method, headers: { "x-board": "1" } };
  if (data instanceof FormData) opts.body = data;
  else if (data !== undefined) { opts.body = JSON.stringify(data); opts.headers["content-type"] = "application/json"; }
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = COMMENT_ERRORS[body.error] || ERRORS[body.error] || "Something went wrong: " + (body.error || res.status);
    toast(msg);
    throw new Error(body.error || String(res.status));
  }
  return body;
}

// ------------------------------------------------------------ sign-in

async function start() {
  await loadBrand();
  const res = await fetch("/api/me");
  if (res.ok) {
    me = await res.json();
    await loadAgents();
    $("app").hidden = false;
    $("who").textContent = AGENTS[me.name] || me.name;
    await loadProjects();
    await enterProject(pickProject());
    setInterval(async () => {
      if (document.visibilityState !== "visible" || dragging) return;
      try { await checkForChanges(); } catch {}
    }, 30000);
    // Coming back to the tab asks the same one-row question, not for every card.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      checkForChanges().catch(() => {});
      loadProjects().catch(() => {});
    });
    return;
  }
  $("gate").hidden = false;
  $("gate-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const field = $("gate-key");
    $("gate-submit").disabled = true;
    try { await call("POST", "/api/session", { key: field.value.trim() }); location.reload(); }
    catch { field.value = ""; field.focus(); }
    finally { $("gate-submit").disabled = false; }
  };
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (cfg.development) {
    $("dev-signin").append(el("button", { type: "button", class: "btn", onclick: async () => { await call("POST", "/api/session", { dev: true }); location.reload(); } }, "Local development sign-in"));
  }
}
$("logout").onclick = async () => { await call("DELETE", "/api/session"); location.reload(); };

// ------------------------------------------------------------ projects

async function loadProjects() {
  ({ projects } = await call("GET", "/api/projects"));
  renderProjects();
}
// The project to open: the link's ?p=, else the last one used, else the first.
function pickProject() {
  const want = new URLSearchParams(location.search).get("p");
  let saved = null;
  try { saved = localStorage.getItem("board.project"); } catch {}
  return [want, saved].find((k) => k && projects.some((p) => p.slug === k)) || projects[0].slug;
}
function renderProjects() {
  const sel = $("project");
  sel.replaceChildren(...projects.map((p) => el("option", { value: p.slug }, p.name)));
  if (project) sel.value = project;
  const current = projects.find((p) => p.slug === project);
  document.title = current ? `${current.name} · Board` : BRAND;
}
// Open a project: forget the last one's cards, filters and read mark, load this one.
async function enterProject(slug) {
  project = slug;
  try { localStorage.setItem("board.project", slug); } catch {}
  history.replaceState(null, "", "?p=" + encodeURIComponent(slug));
  cards = []; chips = []; shown = {}; version = null;
  doneLoaded = doneOpen = false; doneHidden = 0;
  lastC = 0; unread = []; countedUpTo = 0; feedOpen = false; openThread = null;
  for (const id of FILTERS) $(id).value = "";
  loadSeen();
  loadLayerPrefs();
  renderProjects();
  render();
  await reload();
  if (project !== slug) return;
  await startComments();
}
$("project").onchange = (e) => enterProject(e.target.value);

$("projects-btn").onclick = () => { drawProjectAdmin(); $("projects-dlg").showModal(); };
const keyFrom = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
function drawProjectAdmin() {
  const form = $("projects-form");
  const name = el("input", { class: "field", placeholder: "New project name", "aria-label": "New project name" });
  const key = el("input", { class: "field", placeholder: "key (lowercase letters, optional)", "aria-label": "Project key" });
  // The key follows the name until it is typed in.
  let typed = false;
  key.addEventListener("input", () => { typed = true; });
  name.addEventListener("input", () => { if (!typed) key.value = keyFrom(name.value); });
  const add = async () => {
    if (!name.value.trim()) return name.focus();
    const made = await call("POST", "/api/projects", { name: name.value, ...(key.value.trim() ? { key: key.value } : {}) });
    await loadProjects();
    $("projects-dlg").close();
    await enterProject(made.slug);
    toast(`Project created: ${made.name}`);
  };
  for (const input of [name, key]) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  form.replaceChildren(
    el("header", {}, el("strong", {}, "Projects"), el("span", { style: { flex: "1" } }), el("button", { class: "btn small", value: "close" }, "Close")),
    el("div", { class: "projadmin" },
      projects.map((p) => {
        const n = el("input", { class: "field", value: p.name, "aria-label": "Project name", onchange: async () => {
          if (!n.value.trim() || n.value.trim() === p.name) { n.value = p.name; return; }
          await call("PATCH", `/api/projects/${encodeURIComponent(p.slug)}`, { name: n.value });
          await loadProjects();
          drawProjectAdmin();
        } });
        return el("div", { class: "row" }, el("code", {}, p.slug), n, el("span", { class: "used" }, p.slug === project ? "Current" : ""));
      }),
      el("div", { class: "row new" }, name, key, el("button", { type: "button", class: "btn small primary", onclick: add }, "Add project"))),
  );
}

// ------------------------------------------------------------ board

let version = null;
// Ask a one-row question first; only fetch every card when something changed.
async function checkForChanges() {
  const mine = project;
  const { v, c } = await call("GET", inProject("/api/version"));
  if (mine !== project) return;
  if (c > lastC) await pullComments();
  if (v !== version) { version = v; await reload(); }
}
// One request brings the cards, the chips and the change check (read first, so
// a change made meanwhile shows at the next check). The database is read as
// little as possible: the done count is one row and the chips come without
// their usage counts (the chip manager asks for those).
async function reload() {
  // A switch of project while this runs means the answer is for the old one.
  const mine = project;
  const r = await call("GET", inProject(`/api/cards?${doneLoaded ? "" : "hide=done&"}version=1&chips=1`));
  if (mine !== project) return;
  version = r.version.v;
  countedUpTo = r.version.c;
  cards = r.cards;
  doneHidden = r.hidden ? r.hidden.count : 0;
  chips = r.chips;
  renderFilters();
  render();
}
function chipColor(name) { return (chips.find((c) => c.name === name) || {}).color || "#6b7280"; }
function chipEl(name, onRemove) {
  return el("span", { class: "chip", style: { "--chip": chipColor(name) } }, name,
    onRemove && el("button", { type: "button", title: "Remove", onclick: (e) => { e.stopPropagation(); onRemove(); } }, "×"));
}
function agentEl(a) { return a ? el("span", { class: "agent" + (isOwner(a) ? " owner" : agentStyle(a) ? " dyn" : ""), style: agentStyle(a) || undefined }, AGENTS[a] || a) : null; }
function statusEl(st) { return el("span", { class: "status", style: { "--sc": `var(--s-${st})` }, title: "Status" }, statusLabelFor(project, st)); }
function priorityEl(p) { return p ? el("span", { class: "prio " + p, title: "Priority" }, PRIORITY[p] || p) : null; }

function renderFilters() {
  const sel = $("f-chip"), keep = sel.value;
  // Counted from the cards on the page (the board's, not Done's): asking the
  // database for the full counts would include Done too.
  const used = (name) => cards.filter((k) => k.col !== "done" && k.chips.includes(name)).length;
  sel.replaceChildren(el("option", { value: "" }, "All chips"), ...chips.map((c) => el("option", { value: c.name }, `${c.name} (${used(c.name)})`)));
  sel.value = chips.some((c) => c.name === keep) ? keep : "";
}
function matches(c) {
  const q = $("q").value.trim().toLowerCase(), who = $("f-assignee").value, prio = $("f-priority").value, chip = $("f-chip").value;
  if (who === "none" ? c.assignee : who && c.assignee !== who) return false;
  if (prio === "none" ? c.priority : prio && c.priority !== prio) return false;
  if (chip && !c.chips.includes(chip)) return false;
  if (!q) return true;
  if (/^#?\d+$/.test(q)) return String(c.no).startsWith(q.replace("#", ""));
  return (c.title + "\n" + c.description + "\n" + c.chips.join(" ")).toLowerCase().includes(q);
}
for (const id of FILTERS) $(id).addEventListener("input", () => render());

const sorted = (list, status) => list.filter((c) => c.status === status).sort((a, b) => b.sort - a.sort || b.no - a.no);
const searching = () => FILTERS.some((id) => $(id).value.trim());
// A list of cards (the first PAGE, then "show more") for a column or the panel.
function cardList(key, list) {
  const limit = shown[key] || PAGE;
  return {
    box: el("div", { class: "cards" }, list.slice(0, limit).map(cardEl)),
    more: list.length > limit && el("button", { class: "btn small more", type: "button", onclick: () => { shown[key] = limit + PAGE; render(); } }, `Show ${Math.min(PAGE, list.length - limit)} more`),
  };
}
// Cards dropped on node get the status `status`; box (if any) places them between
// cards. A layer inside a column stops the event, so the column behind it doesn't
// also take the card (it only takes what lands outside every layer).
function dropTarget(node, status, box, inner) {
  node.addEventListener("dragover", (e) => { if (dragging) { e.preventDefault(); if (inner) e.stopPropagation(); node.classList.add("over"); } });
  node.addEventListener("dragleave", (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove("over"); });
  node.addEventListener("drop", (e) => { e.preventDefault(); if (inner) e.stopPropagation(); node.classList.remove("over"); dropOn(status, box && box(), e.clientY); });
  return node;
}
// One bordered layer of a column: the status's name, its card count and the
// buttons that move the layer up or down inside the column. Always drawn, even
// empty, so a card can be dropped into it.
function layerEl(colKey, slug, list) {
  const { box, more } = cardList(slug, list);
  const order = layerOrder(colKey), i = order.indexOf(slug);
  const move = (by, label, text) => el("button", { type: "button", class: "lay-btn", title: label, "aria-label": label, disabled: i + by < 0 || i + by >= order.length,
    onclick: (ev) => { ev.stopPropagation(); moveLayer(colKey, slug, by); } }, text);
  return dropTarget(el("div", { class: "layer", "data-status": slug, style: { "--sc": `var(--s-${slug})` } },
    el("header", {}, el("span", { class: "lname" }, statusLabelFor(project, slug)), el("span", { class: "count" }, list.length),
      move(-1, "Move this layer up", "▲"), move(1, "Move this layer down", "▼")),
    box, more), slug, () => box, true);
}

function render() {
  const board = $("board");
  const onBoard = cards.filter((c) => c.col !== "done");
  const visible = cards.filter(matches);
  $("total").textContent = `${visible.filter((c) => c.col !== "done").length} / ${onBoard.length} cards`;
  const cols = {};
  for (const [key, label, dot] of COLUMNS) {
    if (key === "done") continue;
    const inCol = visible.filter((c) => viewColumnOf(c.status) === key), slugs = layerOrder(key);
    let kids, box = null;
    if (slugs.length > 1) kids = [el("div", { class: "layers" }, slugs.map((slug) => layerEl(key, slug, sorted(inCol, slug))))];
    else { const list = cardList(slugs[0], sorted(inCol, slugs[0])); box = list.box; kids = [list.box, list.more]; }
    // Dropped outside every layer, a card takes the column's top layer's status.
    const col = dropTarget(el("section", { class: "col", "data-col": key, style: { "--dot": `var(${dot})` } },
      el("h2", {}, label, el("span", { class: "count" }, inCol.length)), ...kids), slugs[0], () => box);
    cols[key] = { col, count: inCol.length };
  }
  // Feedback sits on top of Backlog in one column and only shows while it
  // has cards (after the filters), so the board is a column narrower.
  const stack = el("div", { class: "stack" }, cols.feedback.count > 0 && cols.feedback.col, cols.backlog.col);
  board.replaceChildren(stack, ...COLUMNS.filter(([key]) => key !== "feedback" && key !== "backlog" && key !== "done").map(([key]) => cols[key].col));
  renderDone(visible);
}

// ------------------------------------------------------------ done panel

function renderDone(visible) {
  const total = doneLoaded ? cards.filter((c) => c.col === "done").length : doneHidden;
  const btn = $("done-btn");
  btn.textContent = `Done ${total}`;
  btn.classList.toggle("on", doneOpen);
  const panel = $("done-panel");
  panel.hidden = !doneOpen;
  if (!doneOpen) return;
  const close = el("button", { class: "btn small", type: "button", onclick: closeDone }, "Close");
  if (!doneLoaded) {
    panel.replaceChildren(el("header", {}, el("h2", {}, "Done", el("span", { class: "count" }, total)), close), el("p", { class: "empty" }, "Loading…"));
    return;
  }
  const list = sorted(visible, "done");
  const { box, more } = cardList("done", list);
  // Every render rebuilds the list; keep the reader where they were.
  const old = panel.querySelector(".cards");
  const top = old ? old.scrollTop : 0;
  panel.replaceChildren(...[
    el("header", {}, el("h2", {}, "Done", el("span", { class: "count" }, searching() ? `${list.length} / ${total}` : total)), close),
    !list.length && el("p", { class: "empty" }, searching() ? "No done cards match the search and filters" : "No done cards yet"),
    box, more].filter(Boolean));
  box.scrollTop = top;
}
async function openDone() {
  doneOpen = true;
  render();
  if (doneLoaded) return;
  doneLoaded = true;
  try { await reload(); }
  catch (e) { doneLoaded = doneOpen = false; toast("It did not load; click again"); render(); }
}
// Closing drops the done cards again, so later reloads skip them.
function closeDone() {
  doneOpen = doneLoaded = false;
  doneHidden = cards.filter((c) => c.col === "done").length;
  cards = cards.filter((c) => c.col !== "done");
  render();
}
$("done-btn").onclick = () => (doneOpen ? closeDone() : openDone());
dropTarget($("done-btn"), "done", null);
dropTarget($("done-panel"), "done", () => $("done-panel").querySelector(".cards"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && doneOpen && !document.querySelector("dialog[open]")) closeDone();
});
// The panel starts just under the top bar, whose height changes as it wraps.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty("--top-h", `${entry.target.offsetHeight}px`)).observe(document.querySelector(".top"));
// Mark done / reopen without dragging. The toast offers an undo that
// puts the card back where it was; the card is looked up by number because a
// reload replaces the card objects (and drops done cards while the panel is shut).
async function setStatus(no, status) {
  const c = cards.find((k) => k.no === no);
  if (c) { c.status = status; c.col = columnOf(status); render(); }
  try { await call("PATCH", `/api/cards/${no}`, { status }); }
  finally { reload(); }
}
async function markDone(no, before) {
  await setStatus(no, "done");
  toast(`#${no} marked done`, { label: "Undo", run: () => setStatus(no, before) });
}
async function reopen(no) {
  await setStatus(no, "backlog");
  toast(`#${no} reopened and put back in the backlog`, { label: "Undo", run: () => setStatus(no, "done") });
}
function doneButton(c, small) {
  const done = c.status === "done";
  return el("button", { type: "button", class: `btn ${small ? "small " : ""}${done ? "" : "ok"}`.trim(), title: done ? "Move back to the backlog" : "Move to Done",
    onclick: (ev) => { ev.stopPropagation(); done ? reopen(c.no) : markDone(c.no, c.status); } }, done ? "Reopen" : "Done");
}
function cardEl(c) {
  const tools = el("div", { class: "tools" },
    doneButton(c, true),
    el("button", { type: "button", class: "btn small", title: "Edit this card", onclick: (ev) => { ev.stopPropagation(); openCard(c.no); } }, "Edit"),
    confirmButton("Remove", "Remove it?", () => removeCard(c.no)));
  tools.addEventListener("click", (ev) => ev.stopPropagation());
  const e = el("article", { class: "card", draggable: "true", "data-no": c.no, "data-prio": c.priority, onclick: () => openCard(c.no) },
    // The status chip sits at the card's top right; the number and title run on beside it and under it.
    el("div", { class: "head" }, statusEl(c.status), tools, el("span", { class: "no" }, "#" + c.no), el("span", { class: "title" }, c.title)),
    FILES && c.thumb && el("img", { class: "thumb", src: `/api/files/${c.thumb}`, alt: "", loading: "lazy" }),
    el("div", { class: "meta" }, priorityEl(c.priority), c.chips.map((n) => chipEl(n)), agentEl(c.assignee),
      FILES && (c.shots || c.files) ? el("span", { class: "icons" }, [c.shots && `Images ${c.shots}`, c.files && `Files ${c.files}`].filter(Boolean).join(" · ")) : null,
      c.commentCount ? el("span", { class: "icons talk", title: "Comments" }, `Comments ${c.commentCount}`) : null));
  e.addEventListener("dragstart", (ev) => { dragging = c; e.classList.add("dragging"); ev.dataTransfer.setData("text/plain", String(c.no)); });
  e.addEventListener("dragend", () => { dragging = null; e.classList.remove("dragging"); });
  return e;
}
// Drop between two cards of a layer (or a column): a sort value halfway between them.
async function dropOn(status, box, y) {
  const c = dragging;
  dragging = null;
  if (!c) return;
  const others = box ? [...box.querySelectorAll(".card")].filter((x) => Number(x.dataset.no) !== c.no) : [];
  const below = others.findIndex((x) => y < x.getBoundingClientRect().top + x.offsetHeight / 2);
  const sortOf = (x) => cards.find((k) => k.no === Number(x.dataset.no)).sort;
  let sort;
  if (!others.length) sort = undefined;
  else if (below === 0) sort = sortOf(others[0]) + 1;
  else if (below === -1) sort = sortOf(others[others.length - 1]) - 1;
  else sort = (sortOf(others[below - 1]) + sortOf(others[below])) / 2;
  if (status === c.status && sort === undefined) return;
  c.status = status;
  c.col = columnOf(status);
  if (sort !== undefined) c.sort = sort;
  if (status === "done" && !doneOpen) toast(`#${c.no} moved to Done (the Done button in the top bar shows it)`);
  render();
  try { await call("PATCH", `/api/cards/${c.no}`, sort === undefined ? { status } : { status, sort }); }
  finally { reload(); }
}

// ------------------------------------------------------------ remove / restore

// Removing hides a card; it keeps its number and can come back. Only the
// owner can delete a removed card for good.
async function removeCard(no) {
  await call("DELETE", `/api/cards/${no}`);
  toast(`#${no} removed (the Removed button in the top bar restores it)`);
  if (openNo === no) $("card-dlg").close();
  reload();
}
async function restoreCard(no) {
  await call("POST", `/api/cards/${no}/restore`);
  toast(`#${no} restored`);
  reload();
}
$("removed").onclick = async () => { await drawRemoved(); $("removed-dlg").showModal(); };
async function drawRemoved() {
  const { cards: gone } = await call("GET", inProject("/api/cards?removed=1"));
  gone.sort((a, b) => (b.removedAt || "").localeCompare(a.removedAt || ""));
  $("removed-form").replaceChildren(
    el("header", {}, el("strong", {}, `Removed: ${gone.length}`), el("span", { style: { flex: "1" } }), el("button", { class: "btn small", value: "close" }, "Close")),
    gone.length ? el("div", { class: "gone" }, gone.map((c) => el("div", { class: "row" },
      el("span", { class: "no" }, "#" + c.no),
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); $("removed-dlg").close(); openCard(c.no); } }, c.title),
      el("span", { class: "when" }, `${when(c.removedAt)} · ${who(c.removedBy)}`),
      el("button", { type: "button", class: "btn small", onclick: async () => { await restoreCard(c.no); drawRemoved(); } }, "Restore"),
      me.actor === "owner" && confirmButton("Delete forever", "Click again; it is gone for good", async () => { await call("DELETE", `/api/cards/${c.no}?purge=1`); toast(`#${c.no} deleted forever`); drawRemoved(); }),
    ))) : el("p", {}, "No removed cards."),
  );
}
function who(a) { return AGENTS[a] || (isOwner(a) ? OWNER.label : a === "visitor" ? "Visitor" : a || ""); }

// ------------------------------------------------------------ card dialog

// A card's status, grouped by the column that shows it (the single-status
// columns, Feedback and Done, have just the one option).
function statusSelect(value, onchange) {
  return el("select", { class: "field", onchange }, COLUMNS.map(([k, label]) =>
    el("optgroup", { label }, viewStatusesFor(project, k).map((slug) => el("option", { value: slug, selected: slug === value }, statusLabelFor(project, slug))))));
}
function agentSelect(value, onchange) {
  return el("select", { class: "field", onchange },
    el("option", { value: "" }, "Nobody"), Object.entries(AGENTS).map(([k, v]) => el("option", { value: k, selected: k === value }, v)));
}
function prioritySelect(value, onchange) {
  return el("select", { class: "field", onchange },
    el("option", { value: "" }, "None"), PRIORITIES.map(([k, v]) => el("option", { value: k, selected: k === value }, v)));
}
function chipPicker(list, onchange) {
  const id = "chip-options-" + Math.random().toString(36).slice(2);
  const input = el("input", { class: "field", list: id, placeholder: "Add a chip, press Enter" });
  const add = () => {
    const name = input.value.trim();
    if (name && !list.includes(name)) onchange([...list, name]);
    input.value = "";
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  input.addEventListener("change", add);
  return el("div", { class: "chiprow" }, list.map((n) => chipEl(n, () => onchange(list.filter((x) => x !== n)))), input,
    el("datalist", { id }, chips.filter((c) => !list.includes(c.name)).map((c) => el("option", { value: c.name }))));
}
function confirmButton(label, sure, action) {
  const b = el("button", { type: "button", class: "btn small danger" }, label);
  b.onclick = () => {
    if (b.dataset.armed) return action();
    b.dataset.armed = "1";
    b.textContent = sure;
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
  };
  return b;
}
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const when = (t) => new Date(t).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ACTIONS = { priority: "priority", remove: "removed", restore: "restored", purge: "deleted forever", create: "created", move: "moved to", title: "changed the title", description: "changed the description", assign: "assigned to", chips: "chips", status: "status", screenshot: "added a screenshot", attach: "added a file", "remove file": "removed a file", delete: "deleted the card" };

async function upload(no, files, kind) {
  if (!files.length) return;
  const form = new FormData();
  form.append("kind", kind);
  for (const f of files) form.append("file", f, f.name || (kind === "screenshot" ? "screenshot.png" : "file"));
  await call("POST", `/api/cards/${no}/files`, form);
  toast(kind === "screenshot" ? "Screenshot uploaded" : "File uploaded");
}
function dropZone(text, onfiles) {
  const input = el("input", { type: "file", multiple: true, hidden: true, onchange: () => onfiles([...input.files]) });
  const z = el("div", { class: "drop", onclick: () => input.click() }, text, input);
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
  z.addEventListener("dragleave", () => z.classList.remove("over"));
  z.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); z.classList.remove("over"); onfiles([...e.dataTransfer.files]); });
  return z;
}

async function openCard(no) {
  openNo = no;
  const { card, files, activity } = await call("GET", `/api/cards/${no}`);
  const form = $("card-form");
  const save = async (patch) => { await call("PATCH", `/api/cards/${no}`, patch); await reload(); if (openNo === no) openCard(no); };
  const title = el("input", { value: card.title, "aria-label": "Title", onchange: () => title.value.trim() && save({ title: title.value }) });

  const view = el("div", { class: "desc-view", title: "Click to edit" }, card.description || "(No description; click to write one)");
  const area = el("textarea", { class: "field", hidden: true }, card.description);
  const descBtns = el("div", { class: "actions", hidden: true },
    el("button", { type: "button", class: "btn small", onclick: () => { area.value = card.description; area.hidden = descBtns.hidden = true; view.hidden = false; } }, "Cancel"),
    el("button", { type: "button", class: "btn small primary", onclick: () => save({ description: area.value }) }, "Save description"));
  view.onclick = () => { view.hidden = true; area.hidden = descBtns.hidden = false; area.focus(); };

  const talkLabel = el("label", {}, `Comments ${card.commentCount || 0}`);
  const shots = files.filter((f) => f.kind === "screenshot"), others = files.filter((f) => f.kind === "file");
  const refresh = () => reload().then(() => openCard(no));
  form.replaceChildren(
    el("header", {}, el("span", { class: "no" }, "#" + card.no), title,
      !card.removedAt && el("button", { type: "button", class: `btn small${card.status === "done" ? "" : " ok"}`, onclick: async () => {
        card.status === "done" ? await reopen(no) : await markDone(no, card.status);
        if (openNo === no) openCard(no);
      } }, card.status === "done" ? "Reopen" : "Mark done"),
      el("button", { class: "btn small", value: "close" }, "Close")),
    el("div", { class: "grid" },
      el("label", {}, "Status"), statusSelect(card.status, (e) => save({ status: e.target.value })),
      el("label", {}, "Assignee"), agentSelect(card.assignee || "", (e) => save({ assignee: e.target.value || null })),
      el("label", {}, "Priority"), prioritySelect(card.priority || "", (e) => save({ priority: e.target.value || null })),
      el("label", {}, "Chips"), chipPicker(card.chips, (list) => save({ chips: list })),
      el("label", {}, "Description"), el("div", {}, view, area, descBtns),
      card.report && el("label", {}, "Diagnostics"), card.report && el("details", { class: "report" }, el("summary", {}, "Show"), el("pre", {}, card.report)),
      card.contact && el("label", {}, "Contact"), card.contact && el("div", {}, card.contact),
      // Screenshots and attachments need file storage (R2); without it these rows are not drawn.
      FILES && [
        el("label", {}, `Screenshots ${shots.length}`),
        el("div", {}, el("div", { class: "shots" }, shots.map((f) =>
          el("div", { class: "shot" },
            el("img", { src: `/api/files/${f.id}`, alt: f.name, loading: "lazy", onclick: () => { $("zoom-img").src = `/api/files/${f.id}`; $("zoom-dlg").showModal(); } }),
            confirmButton("×", "Delete?", () => call("DELETE", `/api/files/${f.id}`).then(refresh))))),
          dropZone("Drag screenshots here, click to choose, or paste", (fs) => upload(no, fs.filter((f) => f.type.startsWith("image/")), "screenshot").then(refresh))),
        el("label", {}, `Files ${others.length}`),
        el("div", {}, el("div", { class: "files" }, others.map((f) =>
          el("div", { class: "file" }, el("a", { href: `/api/files/${f.id}`, download: f.name }, f.name), el("span", {}, size(f.size)),
            confirmButton("Delete", "Delete?", () => call("DELETE", `/api/files/${f.id}`).then(refresh))))),
          dropZone("Drag files here or click to choose (25 MB at most)", (fs) => upload(no, fs, "file").then(refresh))),
      ],
      talkLabel, threadBox(no, (n) => { talkLabel.textContent = `Comments ${n}`; }),
      el("label", {}, "Activity"),
      el("div", { class: "activity" }, activity.map((a) => el("div", {}, `${when(a.at)} · ${who(a.actor)} · ${ACTIONS[a.action] || a.action} ${a.action === "assign" ? (AGENTS[a.detail] || "nobody") : a.action === "priority" ? (PRIORITY[a.detail] || "none") : a.action === "status" || a.action === "create" ? a.detail.replace(/[a-z_]+/g, (w) => (STATUSES.some((x) => x.slug === w) ? statusLabelFor(project, w) : w)) : a.detail}`)))),
    card.removedAt
      ? el("div", { class: "actions" }, el("span", { class: "who" }, `Removed: ${when(card.removedAt)} · ${who(card.removedBy)}`),
          el("button", { type: "button", class: "btn small", onclick: async () => { await restoreCard(no); openCard(no); } }, "Restore"),
          me.actor === "owner" && confirmButton("Delete forever", "Click again; it is gone for good", async () => { await call("DELETE", `/api/cards/${no}?purge=1`); $("card-dlg").close(); reload(); }))
      : el("div", { class: "actions" }, confirmButton("Remove this card", "Remove it? (it can be restored)", () => removeCard(no))),
  );
  if (!$("card-dlg").open) $("card-dlg").showModal();
}
$("card-dlg").addEventListener("close", () => { openNo = null; openThread = null; });
// Pasting an image while a card is open adds it as a screenshot.
document.addEventListener("paste", (e) => {
  if (!FILES || !openNo || !$("card-dlg").open) return;
  const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return;
  e.preventDefault();
  const no = openNo;
  upload(no, imgs, "screenshot").then(() => reload()).then(() => openCard(no));
});


// ------------------------------------------------------------ comments

function ref(m) {
  return m.ref && /^https?:\/\/\S+$/.test(m.ref) ? el("a", { class: "ref", href: m.ref, target: "_blank", rel: "noopener noreferrer" }, m.ref) : null;
}
// One comment. Everything is text (never HTML); the card link only in the feed.
function commentEl(m, withCard) {
  return el("div", { class: `msg${isOwner(m.author) ? " owner" : agentStyle(m.author) ? " dyn" : ""}${unread.includes(m.id) ? " fresh" : ""}`, "data-id": m.id, style: agentStyle(m.author) || undefined },
    el("div", { class: "mh" }, el("strong", {}, who(m.author)), m.to ? el("span", {}, "→ " + who(m.to)) : null,
      el("span", { class: "type" }, TYPES[m.type] || m.type),
      withCard ? el("a", { class: "cardlink", href: "#", onclick: (e) => { e.preventDefault(); $("feed-dlg").close(); openCard(m.cardNo); } }, `#${m.cardNo} ${m.cardTitle || ""}`) : null,
      el("span", { class: "when" }, when(m.createdAt))),
    el("div", { class: "mb" }, m.body), ref(m));
}
function markSeen() {
  unread = [];
  seenC = lastC;
  try { localStorage.setItem(seenKey(), String(seenC)); } catch {}
  badge();
}
function badge() {
  const b = $("feed-btn");
  b.textContent = unread.length ? `Conversation ${unread.length}` : "Conversation";
  b.classList.toggle("unread", unread.length > 0);
}
// First visit: everything so far counts as read. Later visits: pull what came
// after the last one seen, which is also the unread count.
async function startComments() {
  const c = countedUpTo; // read with the cards
  if (seenC === null) { lastC = c; markSeen(); return; }
  lastC = seenC;
  if (c > lastC) await pullComments();
  badge();
}
// Only comments newer than lastC are read, and only when /api/version said so.
async function pullComments() {
  const mine = project;
  const { comments } = await call("GET", inProject(`/api/comments?after=${lastC}&limit=200&titles=1`));
  if (mine !== project || !comments.length) return;
  lastC = comments[comments.length - 1].id;
  let changed = false;
  for (const m of comments) {
    if (!isOwner(m.author) && m.id > (seenC || 0)) unread.push(m.id);
    const k = cards.find((x) => x.no === m.cardNo);
    if (k && m.id > countedUpTo) { k.commentCount = (k.commentCount || 0) + 1; changed = true; }
  }
  countedUpTo = Math.max(countedUpTo, lastC);
  if (feedOpen) { feedAppend(comments); markSeen(); } else badge();
  if (openThread) openThread.add(comments.filter((m) => m.cardNo === openThread.no));
  if (changed) render();
}

// A card's thread and the box to write in.
function threadBox(no, onCount) {
  const list = el("div", { class: "thread" }, el("p", { class: "empty" }, "Loading…"));
  const to = el("select", { class: "field", "aria-label": "To" }, el("option", { value: "" }, "No one in particular"), TARGETS.map(([v, l]) => el("option", { value: v }, l)));
  const type = el("select", { class: "field", "aria-label": "Type" }, Object.entries(TYPES).map(([k, v]) => el("option", { value: k }, v)));
  const text = el("textarea", { class: "field", placeholder: "Write a comment (Ctrl / Cmd + Enter sends)", "aria-label": "Comment" });
  const shown = new Set();
  const add = (comments) => {
    if (shown.size === 0) list.replaceChildren();
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    for (const m of comments) if (!shown.has(m.id)) { shown.add(m.id); list.append(commentEl(m, false)); }
    if (shown.size === 0) list.replaceChildren(el("p", { class: "empty" }, "No comments yet"));
    if (stick) list.scrollTop = list.scrollHeight;
    if (onCount) onCount(shown.size);
  };
  let sending = false;
  const send = async () => {
    if (sending) return;
    const body = text.value.trim();
    if (!body) return text.focus();
    const error = commentBodyError(body);
    if (error) { toast(COMMENT_ERRORS[error]); return; }
    sending = true;
    try {
      await call("POST", `/api/cards/${no}/comments`, { body, ...(to.value ? { to: to.value } : {}), type: type.value });
      if (text.value.trim() === body) text.value = "";
      // The same pull the poll does: it adds our comment (and anything older that
      // arrived meanwhile) to the thread, the feed and the card's count, once.
      await pullComments();
    } finally { sending = false; }
  };
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  const box = el("div", {}, list, el("div", { class: "composer" }, text,
    el("div", { class: "row2" }, "To", to, "Type", type, el("button", { type: "button", class: "btn small primary send", onclick: send }, "Send"))));
  openThread = { no, add };
  call("GET", `/api/cards/${no}/comments`).then(({ comments }) => { if (!comments.length) list.replaceChildren(el("p", { class: "empty" }, "No comments yet")); else add(comments); }).catch(() => {});
  return box;
}

// The conversation page: the latest comments on every card.
const feedFilter = { author: "", type: "" };
async function openFeed() {
  feedOpen = true;
  await drawFeed();
  markSeen();
  $("feed-dlg").showModal();
}
async function drawFeed() {
  const q = new URLSearchParams({ titles: "1", limit: "100", project });
  if (feedFilter.author) q.set("author", feedFilter.author);
  if (feedFilter.type) q.set("type", feedFilter.type);
  const { comments } = await call("GET", "/api/comments?" + q);
  const sel = (key, options, label) => el("select", { class: "field", "aria-label": label, onchange: (e) => { feedFilter[key] = e.target.value; drawFeed(); } },
    el("option", { value: "" }, label), options.map(([v, l]) => el("option", { value: v, selected: feedFilter[key] === v }, l)));
  const list = el("div", { class: "thread feedlist", id: "feed-list" }, comments.length ? comments.map((m) => commentEl(m, true)) : el("p", { class: "empty" }, "No comments yet"));
  $("feed-form").replaceChildren(
    el("header", {}, el("strong", {}, "Conversation"), el("span", { style: { flex: "1" } }),
      sel("author", TARGETS, "All authors"),
      sel("type", Object.entries(TYPES), "All types"),
      el("button", { class: "btn small", value: "close" }, "Close")),
    list);
  list.scrollTop = list.scrollHeight;
}
function feedAppend(comments) {
  const list = $("feed-list");
  if (!list) return;
  const fits = (m) => (!feedFilter.author || m.author === feedFilter.author) && (!feedFilter.type || m.type === feedFilter.type);
  const add = comments.filter(fits);
  if (!add.length) return;
  if (list.querySelector(".empty")) list.replaceChildren();
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  for (const m of add) list.append(commentEl(m, true));
  if (stick) list.scrollTop = list.scrollHeight;
}
$("feed-btn").onclick = openFeed;
$("feed-dlg").addEventListener("close", () => { feedOpen = false; });

// ------------------------------------------------------------ new card

$("new").onclick = () => {
  const form = $("card-form");
  let list = [];
  const title = el("input", { placeholder: "Title", required: true, "aria-label": "Title" });
  const col = statusSelect("backlog");
  const who = agentSelect("");
  const prio = prioritySelect("");
  const desc = el("textarea", { class: "field", placeholder: "Description" });
  const picker = el("div");
  const drawChips = () => picker.replaceChildren(chipPicker(list, (l) => { list = l; drawChips(); }));
  drawChips();
  form.replaceChildren(
    el("header", {}, el("span", { class: "no" }, "New card"), title, el("button", { class: "btn small", value: "close", formnovalidate: true }, "Cancel")),
    el("div", { class: "grid" }, el("label", {}, "Status"), col, el("label", {}, "Assignee"), who, el("label", {}, "Priority"), prio, el("label", {}, "Chips"), picker, el("label", {}, "Description"), desc),
    el("div", { class: "actions" }, el("button", { type: "button", class: "btn primary", onclick: async () => {
      if (!title.value.trim()) return title.focus();
      const { no } = await call("POST", "/api/cards", { project, title: title.value, status: col.value, assignee: who.value || null, priority: prio.value || null, chips: list, description: desc.value });
      await reload();
      toast(`Created #${no}`);
      openCard(no);
    } }, "Create")),
  );
  openNo = null;
  $("card-dlg").showModal();
  title.focus();
};

// ------------------------------------------------------------ chips

// Read stored counts for this project when the manager opens or a chip changes.
let chipCounts = {};
async function loadChipCounts() {
  const r = await call("GET", inProject("/api/chips?counts=1"));
  chipCounts = Object.fromEntries(r.chips.map((c) => [c.name, c.used]));
}
$("manage-chips").onclick = async () => { await loadChipCounts(); drawChipAdmin(); $("chips-dlg").showModal(); };
function drawChipAdmin() {
  const form = $("chips-form");
  const name = el("input", { class: "field", placeholder: "New chip name" });
  const color = el("input", { type: "color", value: "#2563eb" });
  form.replaceChildren(
    el("header", {}, el("strong", {}, "Manage chips"), el("span", { style: { flex: "1" } }), el("button", { class: "btn small", value: "close" }, "Close")),
    el("div", { class: "chipadmin" }, chips.map((c) => {
      const n = el("input", { class: "field", value: c.name, onchange: async () => { if (n.value.trim() && n.value !== c.name) { await call("PATCH", inProject(`/api/chips/${encodeURIComponent(c.name)}`), { name: n.value }); await reload(); await loadChipCounts(); drawChipAdmin(); } } });
      return el("div", { class: "row" },
        el("input", { type: "color", value: c.color, onchange: async (e) => { await call("PATCH", inProject(`/api/chips/${encodeURIComponent(c.name)}`), { color: e.target.value }); await reload(); } }),
        n, el("span", { class: "used" }, `${chipCounts[c.name] ?? 0} cards`),
        confirmButton("Delete", "Remove it from all cards?", async () => { await call("DELETE", inProject(`/api/chips/${encodeURIComponent(c.name)}`)); await reload(); await loadChipCounts(); drawChipAdmin(); }));
    }),
    el("div", { class: "row" }, color, name, el("span"), el("button", { type: "button", class: "btn small primary", onclick: async () => {
      if (!name.value.trim()) return name.focus();
      await call("POST", inProject("/api/chips"), { name: name.value, color: color.value });
      await reload();
      await loadChipCounts();
      drawChipAdmin();
    } }, "Add"))),
  );
}

// ------------------------------------------------------------ theme

// System, light, then dark. theme.js applies the saved choice before the page draws.
const THEMES = [["", "System"], ["light", "Light"], ["dark", "Dark"]];
function drawTheme() {
  const now = document.documentElement.dataset.theme || "";
  $("theme-btn").textContent = "Theme: " + THEMES.find(([k]) => k === now)[1];
}
$("theme-btn").onclick = () => {
  const now = document.documentElement.dataset.theme || "";
  const next = THEMES[(THEMES.findIndex(([k]) => k === now) + 1) % THEMES.length][0];
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try { next ? localStorage.setItem("board.theme", next) : localStorage.removeItem("board.theme"); } catch {}
  drawTheme();
};
drawTheme();

start();
