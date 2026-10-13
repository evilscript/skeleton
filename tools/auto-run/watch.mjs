#!/usr/bin/env node
// The board listener for every agent (docs/CONSTITUTION.md, section 6).
// It asks the board a one-row question every --board seconds and reads cards and comments only when that
// row changed; it makes no model call and prints one line per event, nothing otherwise.
//
//   node tools/auto-run/watch.mjs --as <identity> --role lead|developer|qa
//        [--once | --wake [--minutes 110]] [--board 30] [--prs 60|0] [--slot 30] [--state file]
//        [--agents a,b,c] [--cli path] [--repo owner/name] [--config file] [--replay] [--audit]
//
// --as      the agent's board identity (default: BOARD_AS); the board CLI needs its key
// --role    developer (default): comments addressed to you, plus the Owner's comments on your cards;
//           cards assigned to you or moved by somebody else.
//           lead: every comment by anybody else, cards entering todo, pull requests, our `assign`
//           comments with no reply, cards stuck in progress, the batch slot, the status audit.
//           qa: every `review` comment by a Developer (not the Lead's own reviews) on any card, which is a
//           Developer saying its pull request is submitted, as a [review] line that names the pull requests it
//           links; plus comments addressed to you. Test them with tools/auto-run/pr-check.mjs.
// How the agent is woken depends on its runtime:
//   (default) stream: runs forever, one line per event; for a runtime with a background monitor (a line
//             wakes the agent). Re-arm it when the monitor expires.
//   --wake    runs until the first event, prints the events and exits (or exits after --minutes with
//             "nothing new"; exit 1 when the board is unreachable three times in a row); for a runtime that
//             is woken when a background command exits.
//   --once    one check, prints what is new since the last call and exits; for a runtime that can only run a
//             command now and then (call it at the start of each turn).
// A developer's event line for a card ends with `| brief: <path>`: the listener runs `board brief <card>`
// (description, every comment in full, screenshots downloaded with the agent's own key) and names brief.md, so
// the agent reads the Owner's own words and images, not a summary (--brief 0 turns it off).
// State (what was already reported) is kept in --state (default ~/.boardkit/<slug>/watch-<as>.json), so a
// restart or a repeated call reports only what is new. The first run of a fresh state is silent (it prints a
// baseline line); --replay ignores the state and reports everything.
// The lead also audits the board's statuses against the facts ([status] lines; --audit runs just that and
// exits): an open pull request whose card is still backlog, todo or progress; a merged one whose card is not
// On Main yet; a merged one that is in a git tag while its card is still On Main.
// --prs is how often (seconds) the Lead reads GitHub through the gh CLI (default 60, 0 = never, and no audit);
// the other roles never read GitHub unless asked. --slot is the length in minutes of the Lead's batch slot (a
// divisor of 60, default 30; 0 = off): at the start of each slot a [slot] line lists the open pull requests.
// Events ([tag] first): [card] [comment] [pr] [review] [no-ack] [stuck] [slot] [status] and [watch] (the
// watcher itself: baseline, unreachable, back). Needs Node 20+, the board CLI (--cli or BOARD_CLI, default:
// found by tools/board-path.mjs), BOARD_URL (or board.url in skeleton.config.json) and, for GitHub, the gh CLI
// signed in. A cloud session also sets BOARD_AUTH=proxy (and NODE_USE_ENV_PROXY=1 when its network goes
// through a proxy).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from '../board-path.mjs';
import { loadConfig, ConfigError, githubRepo, ownerBoardName, rolesOf, stateDir, timezoneOf } from '../lib/config.mjs';
import { parseCli, whole } from '../lib/cli.mjs';
import { sh, firstLine } from '../lib/proc.mjs';
import { boardEnv, boardProblem, makeBoard, makeBoardJson } from '../lib/board.mjs';
import { cardOfPr, prNumbersIn } from '../lib/pr.mjs';
import { cardEvents, cardLine, mismatches, relevant, short, slotOf, statusOf } from './watch-logic.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

const { values: V, fail } = parseCli(import.meta.url, {
	as: { type: 'string' }, role: { type: 'string', default: 'developer' },
	once: { type: 'boolean' }, wake: { type: 'boolean' }, minutes: { type: 'string', default: '110' },
	board: { type: 'string', default: '30' }, prs: { type: 'string' }, slot: { type: 'string', default: '30' },
	ack: { type: 'string', default: '30' }, stuck: { type: 'string', default: '3' }, brief: { type: 'string', default: '1' },
	state: { type: 'string' }, agents: { type: 'string' }, cli: { type: 'string' }, repo: { type: 'string' }, config: { type: 'string' },
	replay: { type: 'boolean' }, audit: { type: 'boolean' },
}, { positionals: false });
const die = (msg, code = 2) => { console.error(`watch.mjs: ${msg}`); process.exit(code); };

let loaded;
try { loaded = loadConfig(V.config || here); } catch (e) { if (e instanceof ConfigError) die(e.message, 1); throw e; }
const config = loaded.config;

const ME = V.as || process.env.BOARD_AS || '';
if (!ME) die('say who you are: --as <identity> (or set BOARD_AS to your board name)');
const ROLE = V.role;
if (!['lead', 'developer', 'qa'].includes(ROLE)) die('--role must be lead, developer or qa');
const LEAD = ROLE === 'lead';
const QA = ROLE === 'qa';
const MODE = V.once ? 'once' : V.wake ? 'wake' : 'stream';
const MINUTES = whole(V.minutes, 'minutes', fail, { min: 1 });
const BOARD_EVERY = whole(V.board, 'board', fail, { min: 1 }) * 1000;
const PRS_EVERY = whole(V.prs ?? (LEAD ? '60' : '0'), 'prs', fail) * 1000;
const SLOT = whole(V.slot, 'slot', fail);
if (SLOT && 60 % SLOT !== 0) die('--slot must divide 60 (5, 10, 15, 20, 30 or 60), or be 0 to turn it off');
const ACK_MIN = whole(V.ack, 'ack', fail);
const STUCK_H = whole(V.stuck, 'stuck', fail);
const BRIEF = !LEAD && !QA && Number(V.brief) !== 0;
const REPLAY = Boolean(V.replay);
const TZ = timezoneOf(config);
const OWNER = ownerBoardName(config);
const LEADS = new Set(rolesOf(config, 'lead').map((r) => r.boardName));
const GH_REPO = V.repo || githubRepo(config);
// GitHub is read only for a real project: the example config names a repository that is not yours.
const USE_GH = Boolean(GH_REPO) && PRS_EVERY > 0 && (!loaded.isExample || Boolean(V.repo));
if (loaded.isExample) console.error('watch.mjs: no skeleton.config.json found, so the example config is used: GitHub is not read until the real one exists.');
// --audit keeps its own state so it never swallows events the running listener has not reported yet.
const STATE = V.state || join(stateDir(config), `watch-${ME}${V.audit ? '-audit' : ''}.json`);

const env = boardEnv(loaded, { as: ME });
const problem = boardProblem(env, loaded);
if (problem) die(problem, 1);
const BOARD_CLI = V.cli || boardCli(repo);
const board = makeBoardJson(makeBoard({ cli: BOARD_CLI, env }));

// The roster: the board's own list when it can be read (so a new member needs no change here), else the config's.
let AGENTS = new Set(V.agents ? V.agents.split(',') : rolesOf(config, 'lead').concat(rolesOf(config, 'developer'), rolesOf(config, 'qa')).map((r) => r.boardName));
const LABELS = {}; // name -> the label the board page shows, to spot a comment signed as another agent
if (!V.agents) {
	const r = await makeBoard({ cli: BOARD_CLI, env })(['agents']);
	if (!r.code) {
		const rows = r.out.split('\n').filter((l) => l && !l.includes('(the owner')).map((l) => l.split('\t')).filter((c) => /^[a-z][a-z0-9-]*$/.test((c[0] || '').trim()) && c[0].trim() !== OWNER);
		for (const c of rows) LABELS[c[0].trim()] = (c[1] || '').trim();
		if (rows.length) AGENTS = new Set(rows.map((c) => c[0].trim()));
	}
}
let MANAGED = new Set([...AGENTS].filter((a) => a !== ME));
const ctx = { me: ME, role: ROLE, agents: AGENTS, leads: LEADS };

let state = { v: null, maxComment: 0, cards: {}, comments: [], prs: {}, flags: {}, slot: '' };
if (!REPLAY) {
	try { state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { /* first run */ }
}
// Each source is silent exactly once, on its first read of a run that had no state.
const first = { board: !state.v && state.maxComment === 0 && Object.keys(state.cards).length === 0, prs: false };
first.prs = first.board;
const save = () => {
	try {
		mkdirSync(dirname(STATE), { recursive: true });
		writeFileSync(STATE, JSON.stringify(state));
	} catch { /* a read-only disk must not stop the watch */ }
};
let events = 0;
const out = (tag, text) => {
	if (tag !== 'watch') events += 1;
	console.log(`[${tag}] ${text}`);
};

// `board brief <no>`: the card's folder, or '' when it can't be made (a failure never stops an event line).
const briefs = new Map();
const briefOf = async (no) => {
	if (!BRIEF) return '';
	if (briefs.has(no)) return briefs.get(no);
	let note = '';
	try {
		const r = await board(['brief', String(no)]);
		note = ` | brief: ${r.brief}${r.files.length ? ` (${r.files.length} file${r.files.length > 1 ? 's' : ''})` : ''}`;
	} catch { /* no brief: the line stands alone */ }
	briefs.set(no, note);
	return note;
};
const gh = async (args) => {
	const r = await sh('gh', args, { timeout: 60000 });
	if (r.code) throw new Error(firstLine(r.err) || `gh exited with code ${r.code}`);
	return JSON.parse(r.out);
};

// A source that fails three times in a row is reported once, and again when it is back
// (a single call, --once, reports its first failure at once).
const health = {};
let unreachable = false;
const track = (name, ok, why = '') => {
	const h = (health[name] ||= { fails: 0, down: false });
	if (ok) {
		h.fails = 0;
		if (h.down) { h.down = false; out('watch', `${name} reachable again`); }
		return;
	}
	h.fails += 1;
	if (h.fails >= (MODE === 'once' ? 1 : 3)) {
		unreachable = true;
		if (!h.down) { h.down = true; out('watch', `${name} unreachable${MODE === 'once' ? '' : ' 3 times in a row'}: ${short(why, 300)}`); }
	}
};

async function pollBoard() {
	let ver;
	try { ver = await board(['version']); } catch (e) { return track('board', false, e.message); }
	track('board', true);
	const stamp = `${ver.v}|${ver.c}`;
	if (state.v === stamp && !REPLAY) return checkTimers();
	let cards, comments;
	try {
		cards = await board(['list']);
		comments = await board(['feed', '--limit', '200']);
	} catch (e) { return track('board', false, e.message); }

	const quiet = first.board && !REPLAY;
	first.board = false;
	const lines = []; // [tag, text, card no]: printed together once each card's brief is made
	// Cards.
	const seen = {};
	const old = state.cards;
	for (const c of cards) {
		seen[c.no] = { status: statusOf(c), assignee: c.assignee || null, priority: c.priority || null, updatedAt: c.updatedAt, updatedBy: c.updatedBy || null, title: c.title };
		if (!quiet) for (const line of cardEvents(ctx, c, old[c.no])) lines.push(['card', line, c.no]);
		// A developer's first run (a new session, or a renamed identity) still hears of the cards waiting for it.
		else if (ROLE === 'developer' && c.assignee === ME && ['todo', 'progress', 'pr_review'].includes(statusOf(c))) lines.push(['card', `(waiting) ${cardLine(c)}`, c.no]);
	}
	state.cards = seen;
	// Comments (the feed is ascending, newest last).
	const fresh = comments.filter((m) => m.id > state.maxComment);
	for (const m of fresh) {
		// A comment under the Lead's name that signs as another agent: its wrapper used the wrong identity.
		if (LEAD && !quiet && m.author === ME) {
			const other = Object.entries(LABELS).find(([n, l]) => n !== ME && l && String(m.body).startsWith(l));
			if (other) out('watch', `comment [${m.id}] on #${m.cardNo} is under ${ME}'s name but signs as ${other[1]}: tell it to set BOARD_AS=${other[0]}`);
		}
		if (!quiet && relevant(ctx, m, state.cards)) {
			if (QA && m.type === 'review') {
				if (!LEADS.has(m.author)) {
					const prs = prNumbersIn(`${m.body || ''} ${m.ref || ''}`, GH_REPO).map((n) => `PR #${n}`).join(', ');
					lines.push(['review', `#${m.cardNo} [${m.id}] ${m.author} submitted ${prs || 'a PR (no link in the comment: ask it for the link)'}: ${short(m.body)}`, m.cardNo]);
				}
			} else lines.push(['comment', `#${m.cardNo} [${m.id}] ${m.author} -> ${m.to || '-'} ${m.type}: ${short(m.body)}`, m.cardNo]);
		}
		state.comments.push({ id: m.id, no: m.cardNo, author: m.author, to: m.to || null, type: m.type, at: m.createdAt });
		state.maxComment = Math.max(state.maxComment, m.id);
	}
	// QA: a restart still hears of the submissions nobody has tested (the newest `review` per card, no comment of its own after it).
	if (quiet && QA) {
		const last = {}, mine = {};
		for (const m of comments) {
			if (m.type === 'review' && m.author !== ME && !LEADS.has(m.author)) last[m.cardNo] = m;
			if (m.author === ME) mine[m.cardNo] = m.id;
		}
		for (const m of Object.values(last)) {
			if (mine[m.cardNo] > m.id || !['progress', 'pr_review'].includes(seen[m.cardNo]?.status)) continue;
			const prs = prNumbersIn(`${m.body || ''} ${m.ref || ''}`, GH_REPO).map((n) => `PR #${n}`).join(', ');
			lines.push(['review', `(untested) #${m.cardNo} [${m.id}] ${m.author} submitted ${prs || 'a PR'}: ${short(m.body)}`, m.cardNo]);
		}
	}
	// ... and of the comments addressed to it that it hasn't answered.
	if (quiet && !LEAD) {
		const toMe = {}, answered = {};
		for (const m of comments) {
			if (m.to === ME && m.author !== ME && !['merged', 'note'].includes(m.type)) toMe[m.cardNo] = m; // those two need no answer
			if (m.author === ME) answered[m.cardNo] = m.id;
		}
		for (const m of Object.values(toMe)) {
			if (answered[m.cardNo] > m.id || !seen[m.cardNo] || statusOf(seen[m.cardNo]) === 'done') continue;
			lines.push(['comment', `(unanswered) #${m.cardNo} [${m.id}] ${m.author} -> ${m.to} ${m.type}: ${short(m.body)}`, m.cardNo]);
		}
	}
	state.comments = state.comments.slice(-400);
	state.v = stamp;
	save();
	briefs.clear(); // the card may have changed since the last brief
	for (const [tag, text, no] of lines) out(tag, text + (tag === 'card' && /no longer yours/.test(text) ? '' : await briefOf(no)));
	if (quiet) out('watch', `baseline: ${cards.length} cards, comments up to ${state.maxComment}`);
	checkTimers();
}

// Lead only. no-ack and stuck are time-based: they fire even when the board is quiet.
function checkTimers() {
	if (!LEAD) return;
	const now = Date.now();
	for (const m of state.comments) {
		if (m.author !== ME || m.type !== 'assign' || !MANAGED.has(m.to)) continue;
		const key = `ack:${m.id}`;
		if (state.flags[key]) continue;
		const card = state.cards[m.no];
		if (card && ['on_prod_qa', 'qa_later', 'done'].includes(statusOf(card))) { state.flags[key] = 1; continue; }
		const answered = state.comments.some((x) => x.no === m.no && x.author === m.to && x.id > m.id);
		if (answered) { state.flags[key] = 1; continue; }
		const mins = (now - Date.parse(m.at)) / 60000;
		if (ACK_MIN && mins >= ACK_MIN) {
			state.flags[key] = 1;
			out('no-ack', `#${m.no} assign [${m.id}] to ${m.to} has no reply for ${Math.round(mins)} min (check board thread first)`);
		}
	}
	for (const [no, c] of Object.entries(state.cards)) {
		if (statusOf(c) !== 'progress' || !MANAGED.has(c.assignee)) continue;
		const key = `stuck:${no}:${c.updatedAt}`;
		if (state.flags[key]) continue;
		const last = Math.max(Date.parse(c.updatedAt), ...state.comments.filter((x) => String(x.no) === no).map((x) => Date.parse(x.at)));
		if (STUCK_H && (now - last) / 3600000 >= STUCK_H) {
			state.flags[key] = 1;
			out('stuck', `#${no} "${short(c.title, 60)}" in progress with ${c.assignee}, silent ${Math.round((now - last) / 3600000)} h`);
		}
	}
	save();
}

async function pollPrs() {
	if (!USE_GH) return;
	const quiet = first.prs && !REPLAY;
	let list;
	try {
		list = await gh(['pr', 'list', '--repo', GH_REPO, '--state', 'open', '--limit', '100', '--json', 'number,title,body,headRefName,headRefOid,updatedAt,labels']);
	} catch (e) { return track('github', false, e.message); }
	track('github', true);
	first.prs = false;
	const next = {};
	for (const p of list) {
		const key = String(p.number);
		// (changes: the Lead sent it back with the label `Lead: changes needed`: the card is the developer's again, in progress)
		next[key] = { head: p.headRefOid, branch: p.headRefName, title: p.title, card: cardOfPr(p.title, p.body), label: `PR #${p.number}`, changes: (p.labels || []).some((l) => l.name === 'Lead: changes needed') };
		const prev = state.prs[key];
		if (quiet) continue;
		const card = next[key].card ? ` (card #${next[key].card})` : '';
		if (!prev) out('pr', `PR #${key} opened ${p.headRefName} @${p.headRefOid.slice(0, 7)} "${short(p.title, 80)}"${card}`);
		else if (prev.head !== p.headRefOid) out('pr', `PR #${key} new head ${p.headRefName} @${p.headRefOid.slice(0, 7)} (was ${prev.head.slice(0, 7)})${card}`);
	}
	if (!quiet) for (const key of Object.keys(state.prs)) if (!next[key]) out('pr', `PR #${key} is no longer open`);
	state.prs = next;
	save();
	if (quiet) out('watch', `baseline: ${Object.keys(next).length} open pull request(s) ${Object.keys(next).map((k) => `#${k}`).join(' ')}`);
}

// Lead only. The start of each batch slot (in the Owner's time zone): the round, once per slot, only when something is open.
function checkSlot() {
	if (!LEAD || !SLOT || !USE_GH) return;
	const s = slotOf(new Date(), TZ, SLOT);
	if (state.slot === s.key || s.into > 1) return; // only act in the first minute of a slot
	state.slot = s.key;
	const open = Object.keys(state.prs);
	save();
	if (open.length) out('slot', `${s.label} ${TZ}: ${open.length} pull request(s) open: ${open.map((k) => `#${k}`).join(' ')}`);
	audit(true);
}

// Lead only. The statuses are the Owner's picture of the work: they follow the facts without being asked.
const inRelease = async (oid) => {
	if (!oid) return false;
	const r = await sh('git', ['-C', repo, 'tag', '--contains', oid], { timeout: 30000 });
	return !r.code && r.out.trim().length > 0;
};
async function findMismatches() {
	if (!USE_GH) return [];
	let merged = [];
	try {
		merged = await gh(['pr', 'list', '--repo', GH_REPO, '--state', 'merged', '--limit', '30', '--json', 'number,title,body,mergedAt,mergeCommit']);
	} catch { return []; }
	const released = new Set();
	for (const p of merged) {
		const no = cardOfPr(p.title, p.body);
		if (no && state.cards[no] && statusOf(state.cards[no]) === 'on_main' && await inRelease(p.mergeCommit?.oid)) released.add(p.mergeCommit.oid);
	}
	return mismatches({ cards: state.cards, openPrs: state.prs, mergedPrs: merged, released: (oid) => released.has(oid), ownerName: OWNER });
}
// Each mismatch is said once when it appears and again at every slot while it stands.
async function audit(slot = false) {
	let found;
	try { found = await findMismatches(); } catch (e) { return out('watch', `status audit failed: ${short(e.message, 120)}`); }
	const keys = new Set(found.map(([k]) => k));
	for (const [k, text] of found) {
		const said = state.flags[`st:${k}`];
		if (said && !slot) continue;
		state.flags[`st:${k}`] = 1;
		out('status', `${said ? '(still) ' : ''}${text}`);
	}
	for (const k of Object.keys(state.flags)) if (k.startsWith('st:') && !keys.has(k.slice(3))) delete state.flags[k]; // fixed
	save();
	return found.length;
}

const guarded = (fn) => async () => {
	try { await fn(); } catch (e) { out('watch', `${fn.name} failed: ${short(e.message, 160)}`); }
};
const board1 = guarded(pollBoard);
const prs1 = guarded(pollPrs);
async function auditTick() { await audit(false); }
const audit1 = guarded(auditTick);

if (V.audit) { // just the status audit, now (the lead's: --audit)
	if (!LEAD) die('--audit is for --role lead');
	if (!USE_GH) die('--audit needs GitHub: use a real skeleton.config.json (or --repo owner/name) and --prs above 0', 1);
	await board1();
	await prs1();
	const n = await audit(true);
	console.log(n ? `${n} status mismatch(es)` : 'statuses match the facts');
	process.exit(0);
}

if (MODE === 'once') {
	await board1();
	if (PRS_EVERY) await prs1();
	if (LEAD) await audit(false);
	checkSlot();
	process.exit(unreachable ? 1 : 0);
}

const busy = { board: false, prs: false, audit: false };
const loop = (name, fn, ms) => {
	const tick = async () => {
		if (busy[name]) return;
		busy[name] = true;
		try { await fn(); } finally { busy[name] = false; }
	};
	tick();
	setInterval(tick, ms);
};
loop('board', board1, BOARD_EVERY);
if (PRS_EVERY) loop('prs', prs1, PRS_EVERY);
if (LEAD && USE_GH) setTimeout(() => loop('audit', audit1, 300000), 20000); // after the first board and pull request reads
setInterval(checkSlot, 20000);

if (MODE === 'wake') {
	const deadline = Date.now() + MINUTES * 60000;
	let pending = false;
	setInterval(() => {
		if (unreachable) { out('watch', 'giving up: the board could not be reached'); process.exit(1); }
		if (events > 0 && !pending) {
			pending = true;
			setTimeout(() => process.exit(0), 2500); // let the rest of the same change print
		} else if (!pending && Date.now() >= deadline) {
			console.log(`nothing new in ${MINUTES} minutes`);
			process.exit(0);
		}
	}, 1000);
}
