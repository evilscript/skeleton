#!/usr/bin/env node
// A status report in one command: what merged, what is open, what waits for whom, what looks stuck.
// For the morning, for "what is going on", for the end of a duty stretch. Times are in the Owner's time zone.
//
//   node tools/auto-run/report.mjs               # the last 12 hours
//   node tools/auto-run/report.mjs --since 24h
//   node tools/auto-run/report.mjs --no-audit    # skip the status audit at the end
//
// Cards the Owner moved to done are not listed. BOARD_AS is the Lead's board name. Needs Node 20+, gh and the
// board CLI; --config f and --cli f pick the config file and the board CLI (defaults: found by walking up).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from '../board-path.mjs';
import { ConfigError, defaultBranch, githubRepo, leadBoardName, loadConfig, ownerBoardName, timezoneOf } from '../lib/config.mjs';
import { parseCli, whole } from '../lib/cli.mjs';
import { boardEnv, boardProblem, makeBoard, makeBoardJson } from '../lib/board.mjs';
import { firstLine, sh } from '../lib/proc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: V, fail } = parseCli(import.meta.url, { since: { type: 'string', default: '12h' }, 'no-audit': { type: 'boolean' }, config: { type: 'string' }, cli: { type: 'string' } }, { positionals: false });
const die = (msg) => { console.error(`report.mjs: ${msg}`); process.exit(1); };
const m = /^(\d+)h$/.exec(V.since);
if (!m) fail(`--since needs hours like 12h, got "${V.since}"`);
const hours = whole(m[1], 'since', fail, { min: 1 });
const since = new Date(Date.now() - hours * 3600e3);

let loaded;
try { loaded = loadConfig(V.config || here); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
const config = loaded.config;
const repoSlug = githubRepo(config);
if (loaded.isExample || !repoSlug) die('there is no skeleton.config.json with github.owner and github.repo (only the example, or none). Run the first-run protocol in START_HERE.md.');
const ME = process.env.BOARD_AS || leadBoardName(config);
const env = boardEnv(loaded, { as: ME });
const problem = boardProblem(env, loaded);
if (problem) die(problem);
const cli = V.cli || boardCli(resolve(here, '../..'));
const board = makeBoardJson(makeBoard({ cli, env, timeout: 120000 }));
const TZ = timezoneOf(config);
const OWNER = ownerBoardName(config);

const gh = async (args) => {
	const r = await sh('gh', args, { timeout: 120000 });
	if (r.code) die(`gh failed: ${firstLine(r.err)}`);
	return JSON.parse(r.out);
};
const at = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const out = [];
const P = (s = '') => out.push(s);

P(`# Status report (last ${hours} hours, as of ${at(new Date())} ${TZ})`);

// merged and open pull requests
const merged = await gh(['pr', 'list', '--repo', repoSlug, '--state', 'merged', '--base', defaultBranch(config), '--limit', '60', '--json', 'number,title,mergedAt,headRefName']);
const recent = merged.filter((p) => new Date(p.mergedAt) >= since).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
P(`\n## Merged into ${defaultBranch(config)} (${recent.length})`);
for (const p of recent) P(`- ${at(p.mergedAt)} PR #${p.number} ${short(p.title, 56)} (${p.headRefName.split('/')[0]})`);
const open = await gh(['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName']);
P(`\n## Open pull requests (${open.length})`);
for (const p of open) P(`- PR #${p.number} ${short(p.title, 56)} (${p.headRefName.split('/')[0]})`);

// the cards that are not done
let cards;
try { cards = await board(['list']); } catch (e) { die(e.message); }
const live = cards.filter((c) => c.status !== 'done');
const ORDER = [['todo', 'To do (waiting for a start)'], ['progress', 'In progress'], ['pr_review', 'PR reviewing'], ['on_main', 'On Main (not released yet)'], ['spike_ready', 'Spike report ready'], ['probe_needed', 'Owner check needed'], ['on_prod_qa', 'On Prod for QA (the Owner tests)'], ['qa_later', 'QA later'], ['feedback', 'Feedback'], ['backlog', 'Backlog (nobody started)']];
P('\n## Cards');
for (const [st, label] of ORDER) {
	const list = live.filter((c) => c.status === st);
	if (!list.length) continue;
	P(`- ${label} (${list.length}): ${list.slice(0, 8).map((c) => `#${c.no}${c.assignee && c.assignee !== OWNER ? ` (${c.assignee})` : ''}`).join(' ')}${list.length > 8 ? ' ...' : ''}`);
}

// waiting for the Owner: the last comment on a live card is an agent's question to the Owner
const waiting = [];
for (const c of live.filter((x) => !['backlog', 'feedback'].includes(x.status))) {
	let thread = [];
	try { thread = await board(['thread', String(c.no)]); } catch { continue; }
	const last = thread[thread.length - 1];
	if (last && last.to === OWNER && last.type === 'question') waiting.push(`#${c.no} ${short(c.title, 30)}: ${short(last.body.replace(/\s+/g, ' '), 70)} (${at(last.createdAt)})`);
}
P(`\n## Questions waiting for the Owner (${waiting.length})`);
for (const w of waiting) P(`- ${w}`);

// stuck: In progress with no activity for three hours
const stuck = live.filter((c) => c.status === 'progress' && Date.now() - Date.parse(c.updatedAt) > 3 * 3600e3);
P(`\n## Possibly stuck (in progress, quiet for 3 hours) (${stuck.length})`);
for (const c of stuck) P(`- #${c.no} (${c.assignee || '-'}) ${short(c.title, 40)}, last activity ${at(c.updatedAt)}`);

if (!V['no-audit']) {
	const a = await sh('node', [join(here, 'watch.mjs'), '--as', ME, '--role', 'lead', '--audit', ...(V.config ? ['--config', V.config] : []), ...(V.cli ? ['--cli', V.cli] : [])], { env, timeout: 180000 });
	P(`\n## Status audit\n- ${(a.out + a.err).trim().split('\n').slice(-2).join(' ') || '(no result)'}`);
}
console.log(out.join('\n'));
