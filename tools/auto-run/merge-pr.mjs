#!/usr/bin/env node
// The Lead's merge helper: merge reviewed pull requests into the default branch, the mechanical part.
//
// The Lead reads the code and decides a pull request is ready (a `review` comment on its card, written after the
// pull request's last commit). This script then does the rest:
//
//   1. refuses unless every pull request is ready: open, not a draft, based on the default branch, a "Card: #N"
//      line in its description, the Lead's `review` comment on the card after its last commit and, when the
//      project has a qa role, the label `QA: pass` with a QA comment on the card after that commit; and the main
//      working tree is clean, on the default branch and up to date with origin
//   2. makes a scratch work tree off origin/<default branch> in the Lead's member folder
//   3. merges each pull request there with --no-ff (a conflict stops it: exit 3, the work tree is left)
//   4. runs the project's check command there (checks.command), the minimum scope for a merge
//   5. fast-forwards the default branch, pushes it, moves each card to On Main, posts the `merged` comment for
//      the Owner and labels the pull request `Lead: merged`
//   6. removes the work tree and the scratch branch, then runs the status audit
//
//   node tools/auto-run/merge-pr.mjs 12 13 [--tests run|none] [--command "npm test"] [--dry-run] [--keep]
//
//   --tests none     skip the check command (a documentation-only batch; say so on the card)
//   --command c      run c instead of checks.command
//   --timeout m      stop the check command after m minutes (default 60)
//   --link path      link an untracked path of this checkout into the scratch tree (repeatable; node_modules is
//                    linked when it exists)
//   --skip-qa        do not require the QA gate (only when the Owner said so, or the change touches no code)
//   --dry-run        everything up to and including the checks, in the scratch tree; nothing is pushed and no
//                    card or label changes; the tree is removed unless --keep
//   --keep           keep the scratch work tree and branch
//   --config f --cli f  the config file and the board CLI to use (defaults: found by walking up)
//
// Exit codes: 0 done, 1 refused or failed, 2 bad usage, 3 merge conflict, 4 checks failed. Nothing is pushed
// unless every step before the push succeeded. BOARD_AS must be the Lead's board name. Needs Node 20+, git, gh
// (signed in) and the board CLI. Run it from the Lead's main checkout.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from '../board-path.mjs';
import { ConfigError, checkCommand, defaultBranch, githubRepo, loadConfig, memberByBoardName, ownerBoardName, rolesOf, slugOf, stateDir, timezoneOf } from '../lib/config.mjs';
import { parseCli, whole } from '../lib/cli.mjs';
import { boardEnv, boardProblem, makeBoard, makeBoardJson } from '../lib/board.mjs';
import { duration, errorOf, sh } from '../lib/proc.mjs';
import { LABELS, cardOfPr } from '../lib/pr.mjs';
import { prView, relabel } from '../lib/gh.mjs';
import { linkInto, memberDir, runLogged, stamp } from '../lib/worktree.mjs';
import { mergedComment } from '../lib/comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: V, positionals, fail } = parseCli(import.meta.url, {
	tests: { type: 'string', default: 'run' }, command: { type: 'string' }, timeout: { type: 'string', default: '60' },
	link: { type: 'string', multiple: true }, 'skip-qa': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' },
	config: { type: 'string' }, cli: { type: 'string' },
});
const say = (s) => console.log(s);
const step = (s) => console.log(`\n== ${s}`);
const die = (s, code = 1) => { console.error(`\nmerge-pr.mjs: ${s}`); process.exit(code); };

if (!positionals.length || !positionals.every((a) => /^\d+$/.test(a))) fail('usage: node tools/auto-run/merge-pr.mjs <pull request number> [...] [--tests run|none] [--command c] [--dry-run] [--keep]');
if (!['run', 'none'].includes(V.tests)) fail('--tests must be run or none');
const TIMEOUT = whole(V.timeout, 'timeout', fail, { min: 1 }) * 60000;
const DRY = Boolean(V['dry-run']);

let loaded;
try { loaded = loadConfig(V.config || here); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
if (loaded.isExample) die('there is no skeleton.config.json, only the example. This tool pushes to the repository, so it needs the project\'s own config: run the first-run protocol in START_HERE.md.');
const config = loaded.config;
const REPO_SLUG = githubRepo(config);
if (!REPO_SLUG) die('github.owner and github.repo are missing in skeleton.config.json.');
const BRANCH = defaultBranch(config);
const BASE = `origin/${BRANCH}`;
const ME = process.env.BOARD_AS || '';
if (!ME) die('set BOARD_AS to the Lead\'s board name first.');
const lead = memberByBoardName(config, ME);
if (lead && lead.role !== 'lead') die(`BOARD_AS is ${ME}, a ${lead.role}. Only the Lead merges.`);
const QA_NAMES = new Set(rolesOf(config, 'qa').map((r) => r.boardName));
const COMMAND = V.command || checkCommand(config);
if (V.tests === 'run' && !COMMAND) die('checks.command is empty. Set it in skeleton.config.json, pass --command, or use --tests none for a documentation-only batch.');

const env = boardEnv(loaded, { as: ME });
const problem = boardProblem(env, loaded);
if (problem) die(problem);
const board = makeBoard({ cli: V.cli || boardCli(resolve(here, '../..')), env });
const boardJson = makeBoardJson(board);

const top = await sh('git', ['rev-parse', '--show-toplevel'], { cwd: here });
if (top.code) die('this is not a git checkout. Run the script from the Lead\'s main checkout.');
const REPO = top.out.trim();
const git = (args, cwd = REPO) => sh('git', args, { cwd });
const clock = () => new Intl.DateTimeFormat('en-GB', { timeZone: timezoneOf(config), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

// ---------------------------------------------------------------- the main working tree
async function checkMainTree() {
	const st = await git(['status', '--porcelain', '--untracked-files=no']);
	if (st.out.trim()) die(`the main working tree has changes (${st.out.trim().split('\n')[0]} ...). Commit or stash them first.`);
	const br = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
	if (br !== BRANCH) die(`the main working tree is on ${br}, not ${BRANCH}. Run the script from the main checkout.`);
	const f = await git(['fetch', '-q', 'origin']);
	if (f.code) die(`git fetch failed: ${errorOf(f.err)}`);
	const behind = await git(['merge-base', '--is-ancestor', BRANCH, BASE]);
	if (behind.code) die(`local ${BRANCH} has commits that ${BASE} does not have (or has diverged). Push or reset them first.`);
}

// ---------------------------------------------------------------- the pull requests and the gates
async function loadPrs() {
	const list = [];
	for (const n of positionals) {
		let pr;
		try { pr = await prView(REPO_SLUG, n); } catch (e) { die(e.message); }
		if (pr.state !== 'OPEN') die(`PR #${n} is ${pr.state}, not open.`);
		if (pr.isDraft) die(`PR #${n} is a draft.`);
		if (pr.baseRefName !== BRANCH) die(`PR #${n} is based on ${pr.baseRefName}, not ${BRANCH}.`);
		pr.card = cardOfPr(pr.title, pr.body);
		if (!pr.card) die(`PR #${n} has no "Card: #N" line in its description. Ask the Developer to add it.`);
		pr.labelNames = (pr.labels || []).map((l) => l.name);
		const dev = rolesOf(config, 'developer').find((d) => pr.headRefName.startsWith(d.branchPrefix || `${d.boardName}/`));
		pr.who = dev ? dev.name : pr.author?.login || pr.headRefName.split('/')[0];
		list.push(pr);
	}
	return list;
}

// The review gate: a `review` comment from the Lead on the card, written after the pull request's last commit.
// The QA gate (only with a qa role): `QA: pass`, no `QA: fail`, and a QA comment on the card after that commit.
async function gates(pr) {
	let comments;
	try { comments = await boardJson(['thread', String(pr.card)]); } catch (e) { die(`could not read card #${pr.card}: ${e.message}`); }
	const c = await git(['log', '-1', '--format=%cI', `origin/${pr.headRefName}`]);
	if (c.code || !c.out.trim()) die(`PR #${pr.number}: the branch ${pr.headRefName} is not on origin (forks are not supported).`);
	const committed = new Date(c.out.trim());
	if (!comments.some((x) => x.author === ME && x.type === 'review' && new Date(x.createdAt) > committed)) {
		die(`PR #${pr.number}: no "${ME}" review comment on card #${pr.card} after its last commit (${c.out.trim()}). Review it first: the gate is the point.`);
	}
	if (QA_NAMES.size && !V['skip-qa']) {
		if (!pr.labelNames.includes(LABELS.qaPass.name) || pr.labelNames.includes(LABELS.qaFail.name)) die(`PR #${pr.number}: it needs the label "${LABELS.qaPass.name}" and not "${LABELS.qaFail.name}". Wait for QA (or use --skip-qa if the Owner said so).`);
		if (!comments.some((x) => QA_NAMES.has(x.author) && new Date(x.createdAt) > committed)) die(`PR #${pr.number}: QA has not written on card #${pr.card} since the last commit, so "${LABELS.qaPass.name}" may be stale. Ask QA to run it again.`);
	}
}

// ---------------------------------------------------------------- the scratch work tree and the merges
async function makeWorktree() {
	const parent = memberDir(REPO, lead, slugOf(config));
	let name = `batch-${stamp()}`;
	for (let n = 2; existsSync(join(parent, name)) || (await git(['rev-parse', '--verify', '-q', `refs/heads/merge/${name}`])).code === 0; n++) name = `batch-${stamp()}-${n}`;
	const dir = join(parent, name);
	const branch = `merge/${name}`;
	const r = await git(['worktree', 'add', dir, '-b', branch, BASE]);
	if (r.code) die(`git worktree add failed: ${errorOf(r.err)}`);
	const linked = linkInto(REPO, dir, ['node_modules', ...(V.link || [])]);
	if (linked.length) say(`  linked into the tree: ${linked.join(', ')}`);
	return { dir, branch };
}

async function mergeOne(wt, pr) {
	// Hooks are off in the scratch tree: the check command is run explicitly below.
	const args = ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-autostash', `origin/${pr.headRefName}`, '-m', `Merge PR #${pr.number}: ${pr.title} (card #${pr.card})`];
	let r = await git(args, wt.dir);
	for (let i = 0; i < 3 && r.code && /stash failed/.test(r.out + r.err); i++) { // a new work tree's first merge sometimes says this: wait, try again
		await new Promise((res) => setTimeout(res, 3000));
		r = await git(args, wt.dir);
	}
	if (r.code) {
		const st = await git(['diff', '--name-only', '--diff-filter=U'], wt.dir);
		console.error(`\nmerge-pr.mjs: merging PR #${pr.number} stopped:\n${(r.out + r.err).trim()}`);
		if (st.out.trim()) console.error(`Conflicts in:\n  ${st.out.trim().split('\n').join('\n  ')}\nThe work tree is left at ${wt.dir}. Ask the Developer to merge ${BRANCH} into the branch and push, then run this again.`);
		process.exit(3);
	}
	say(`  merged PR #${pr.number} (${pr.headRefName})`);
}

// ---------------------------------------------------------------- the checks
async function runChecks(wt) {
	if (V.tests === 'none') { say('  checks: none (asked for)'); return false; }
	const log = join(stateDir(config), `merge-${stamp()}.log`);
	say(`  checks: \`${COMMAND}\`${config.checks?.minimumScope ? ` (minimum scope: ${config.checks.minimumScope})` : ''}, log ${log}`);
	const r = await runLogged(COMMAND, { cwd: wt.dir, log, timeoutMs: TIMEOUT, onTick: (min) => say(`  ... still running (${min} min)`) });
	if (r.code !== 0) {
		console.error(`\nmerge-pr.mjs: the check command did not pass (exit ${r.code}${r.timedOut ? ', timed out' : ''}). Log: ${log}\n${r.tail.trim().split('\n').slice(-15).join('\n')}`);
		console.error(`The work tree is left at ${wt.dir}. Nothing was pushed.`);
		process.exit(4);
	}
	say(`  the checks passed after ${duration(r.seconds)}`);
	return true;
}

// ---------------------------------------------------------------- publish and the board
async function publish(wt, prs, tested) {
	await checkMainTree(); // fetches again: origin may have moved while the checks ran
	const anc = await git(['merge-base', '--is-ancestor', BASE, wt.branch]);
	if (anc.code) die(`${BASE} moved while the checks ran. Merge it into ${wt.branch} again (the work tree ${wt.dir} is left).`);
	const ff = await git(['merge', '--ff-only', wt.branch]);
	if (ff.code) die(`fast-forward failed: ${errorOf(ff.err)}`);
	// The network can drop for a minute: try the push again a few times.
	let push = await git(['push', '-q', 'origin', BRANCH]);
	for (let i = 0; push.code && i < 4; i++) {
		say(`  push failed (${errorOf(push.err)}); trying again in 30 s`);
		await new Promise((r) => setTimeout(r, 30000));
		push = await git(['push', '-q', 'origin', BRANCH]);
	}
	if (push.code) die(`push failed: ${errorOf(push.err)}. The merge is committed locally on ${BRANCH}; push it by hand.`);
	say(`  ${BRANCH} is at ${(await git(['rev-parse', '--short', 'HEAD'])).out.trim()} and pushed`);
	for (const pr of prs) {
		const mv = await board(['move', String(pr.card), 'on_main']);
		const merge = (await git(['log', '--format=%h', '-1', `--grep=^Merge PR #${pr.number}:`])).out.trim() || (await git(['rev-parse', '--short', 'HEAD'])).out.trim();
		const text = mergedComment({
			leadName: lead?.name || ME, time: `${clock()} ${timezoneOf(config)}`, card: pr.card, pr: pr.number, who: pr.who, branch: BRANCH, merge,
			tested: tested ? `The check command passed in the merge tree (\`${COMMAND}\`); the full suite runs when the Lead deploys.` : 'No tests were run (asked for).',
		});
		const cm = await board(['comment', String(pr.card), text, '--to', ownerBoardName(config), '--type', 'merged']);
		const lb = await relabel(REPO_SLUG, pr.number, { add: [LABELS.merged], remove: [LABELS.changesNeeded], current: pr.labelNames });
		say(`  card #${pr.card}: ${mv.code ? `move failed: ${errorOf(mv.err)}` : 'On Main'}; comment ${cm.code ? `failed: ${errorOf(cm.err)}` : 'posted'}; label ${lb.code ? 'failed' : 'set'}`);
	}
}

async function cleanup(wt) {
	if (V.keep) { say(`  kept: ${wt.dir} (${wt.branch})`); return; }
	await git(['worktree', 'remove', '--force', wt.dir]);
	await git(['branch', '-D', wt.branch]);
	say('  work tree and branch removed');
}

// ---------------------------------------------------------------- main
await checkMainTree();
const prs = await loadPrs();
step(`pull requests: ${prs.map((p) => `#${p.number} (card #${p.card})`).join(', ')}${DRY ? '  [dry run]' : ''}`);
for (const pr of prs) await gates(pr);
say('  gates: ok');

step('work tree and merges');
const wt = await makeWorktree();
say(`  ${wt.dir} (${wt.branch}) from ${BASE}`);
for (const pr of prs) await mergeOne(wt, pr);

step('checks');
const tested = await runChecks(wt);

if (DRY) {
	step('dry run: would now fast-forward, push, move the cards to On Main, comment and label');
	await cleanup(wt);
	process.exit(0);
}

step('publish');
await publish(wt, prs, tested);
step('cleanup and audit');
await cleanup(wt);
const audit = await sh('node', [join(here, 'watch.mjs'), '--as', ME, '--role', 'lead', '--audit', ...(V.config ? ['--config', V.config] : []), ...(V.cli ? ['--cli', V.cli] : [])], { cwd: REPO, env });
say(`  ${(audit.out + audit.err).trim().split('\n').slice(-2).join('\n  ') || 'no audit result'}`);
