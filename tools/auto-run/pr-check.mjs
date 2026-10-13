#!/usr/bin/env node
// The QA's tool: run the project's check command on a pull request and write the result where the team reads it.
//
// For one pull request it fetches the head, makes a scratch work tree off origin/<default branch>, merges the head
// into it (what would land if the Lead merged it now), runs the check command there (checks.command), then writes
// the result: the label `QA: pass` or `QA: fail` on the pull request (created when missing; the other one is
// removed) and a `note` comment on the card, addressed to the Lead (the card is the "Card: #N" line of the pull
// request description). It removes the work tree afterwards. It never pushes and never merges: QA does not change
// code.
//
//   node tools/auto-run/pr-check.mjs 12 [--command "npm test"] [--timeout 60] [--link path] [--dry-run] [--keep]
//
//   --command c      run c instead of checks.command
//   --timeout m      stop the command after m minutes and count it as a failure (default 60)
//   --link path      link an untracked path of this checkout into the scratch tree (repeatable; node_modules is
//                    linked when it exists)
//   --dry-run        read the pull request and print what would be done; change nothing
//   --keep           keep the scratch work tree
//   --config f --cli f  the config file and the board CLI to use (defaults: found by walking up)
//
// Exit codes: 0 the checks passed, 4 they failed (the result is written either way), 1 something stopped the
// run or the result could not be written, 2 bad usage. BOARD_AS must be the QA's board name. Needs Node 20+, git,
// gh (signed in, allowed to label pull requests) and the board CLI.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from '../board-path.mjs';
import { ConfigError, checkCommand, defaultBranch, githubRepo, leadBoardName, loadConfig, memberByBoardName, slugOf, stateDir } from '../lib/config.mjs';
import { parseCli, whole } from '../lib/cli.mjs';
import { boardEnv, boardProblem, makeBoard } from '../lib/board.mjs';
import { duration, errorOf, firstLine, sh } from '../lib/proc.mjs';
import { LABELS, cardOfPr, tailText } from '../lib/pr.mjs';
import { prView, relabel } from '../lib/gh.mjs';
import { linkInto, memberDir, runLogged, stamp } from '../lib/worktree.mjs';
import { qaNote } from '../lib/comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: V, positionals, fail } = parseCli(import.meta.url, {
	command: { type: 'string' }, timeout: { type: 'string', default: '60' }, link: { type: 'string', multiple: true },
	'dry-run': { type: 'boolean' }, keep: { type: 'boolean' }, config: { type: 'string' }, cli: { type: 'string' },
});
const say = (s) => console.log(s);
const die = (s, code = 1) => { console.error(`pr-check.mjs: ${s}`); process.exit(code); };

if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) fail('usage: node tools/auto-run/pr-check.mjs <pull request number> [--command c] [--dry-run] [--keep]');
const NUMBER = Number(positionals[0]);
const TIMEOUT = whole(V.timeout, 'timeout', fail, { min: 1 }) * 60000;

let loaded;
try { loaded = loadConfig(V.config || here); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
if (loaded.isExample) die('there is no skeleton.config.json, only the example. This tool writes to GitHub and the board, so it needs the project\'s own config: run the first-run protocol in START_HERE.md.');
const config = loaded.config;
const REPO_SLUG = githubRepo(config);
if (!REPO_SLUG) die('github.owner and github.repo are missing in skeleton.config.json.');
const BRANCH = defaultBranch(config);
const COMMAND = V.command || checkCommand(config);
if (!COMMAND) die('checks.command is empty. Set it in skeleton.config.json or pass --command.');
const ME = process.env.BOARD_AS || '';
if (!ME) die('set BOARD_AS to the QA\'s board name first.');
const me = memberByBoardName(config, ME);
if (me?.role === 'developer') die(`BOARD_AS is ${ME}, a developer. The QA result is written by the QA, so the Lead can trust it.`);
const LEAD = leadBoardName(config);

const env = boardEnv(loaded, { as: ME });
const board = makeBoard({ cli: V.cli || boardCli(resolve(here, '../..')), env });

let pr;
try { pr = await prView(REPO_SLUG, NUMBER); } catch (e) { die(e.message); }
if (pr.state !== 'OPEN') die(`PR #${NUMBER} is ${pr.state}, not open.`);
if (pr.isDraft) die(`PR #${NUMBER} is a draft. Test it when the Developer marks it ready.`);
if (pr.baseRefName !== BRANCH) die(`PR #${NUMBER} is based on ${pr.baseRefName}, not ${BRANCH}.`);
const card = cardOfPr(pr.title, pr.body);
const labels = (pr.labels || []).map((l) => l.name);

if (V['dry-run']) {
	say(`PR #${NUMBER} "${pr.title}" (${pr.headRefName} @ ${pr.headRefOid.slice(0, 7)}), card ${card ? `#${card}` : 'unknown: no "Card: #N" line in the description'}`);
	say(`would: fetch the head, merge it onto origin/${BRANCH} in a scratch work tree, run \`${COMMAND}\` (up to ${TIMEOUT / 60000} min)`);
	say(`then: label the pull request "${LABELS.qaPass.name}" or "${LABELS.qaFail.name}"${card && LEAD ? `, and post a note on card #${card} to ${LEAD}` : ' (no card comment)'}; then remove the work tree.`);
	process.exit(0);
}
const problem = boardProblem(env, loaded);
if (problem) die(problem);

const top = await sh('git', ['rev-parse', '--show-toplevel'], { cwd: here });
if (top.code) die('this is not a git checkout. Run the script from the QA\'s checkout.');
const REPO = top.out.trim();
const git = (args, cwd = REPO) => sh('git', args, { cwd });

// ---------------------------------------------------------------- fetch and merge
const f1 = await git(['fetch', '-q', 'origin']);
if (f1.code) die(`git fetch failed: ${errorOf(f1.err)}`);
const f2 = await git(['fetch', '-q', 'origin', `pull/${NUMBER}/head`]);
if (f2.code) die(`could not fetch the head of PR #${NUMBER}: ${errorOf(f2.err)}`);
const sha = (await git(['rev-parse', 'FETCH_HEAD'])).out.trim();
const baseSha = (await git(['rev-parse', `origin/${BRANCH}`])).out.trim();
if (sha !== pr.headRefOid) say(`note: the pull request moved while this ran (${pr.headRefOid.slice(0, 7)} -> ${sha.slice(0, 7)}); testing ${sha.slice(0, 7)}`);

const parent = memberDir(REPO, me, slugOf(config));
let name = `pr-check-${NUMBER}-${stamp()}`;
for (let n = 2; existsSync(join(parent, name)); n++) name = `pr-check-${NUMBER}-${stamp()}-${n}`;
const dir = join(parent, name);
const wt = await git(['worktree', 'add', '--detach', dir, `origin/${BRANCH}`]);
if (wt.code) die(`git worktree add failed: ${errorOf(wt.err)}`);
const cleanup = async () => {
	if (V.keep) { say(`kept: ${dir}`); return; }
	await git(['worktree', 'remove', '--force', dir]);
};

let result;
try {
	say(`PR #${NUMBER} @ ${sha.slice(0, 7)} onto origin/${BRANCH} @ ${baseSha.slice(0, 7)} in ${dir}`);
	const m = await git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=pr-check', '-c', 'user.email=pr-check@localhost', 'merge', '--no-ff', '--no-autostash', '--no-edit', '-m', `Merge PR #${NUMBER} for QA`, sha], dir);
	if (m.code) {
		const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], dir)).out.trim().split('\n').filter(Boolean);
		if (!conflicts.length) throw new Error(`the merge failed: ${errorOf(m.err)}`);
		result = { pass: false, conflicts, seconds: 0, tail: '' };
	} else {
		const linked = linkInto(REPO, dir, ['node_modules', ...(V.link || [])]);
		if (linked.length) say(`linked into the tree: ${linked.join(', ')}`);
		const log = join(stateDir(config), `pr-check-${NUMBER}-${sha.slice(0, 7)}.log`);
		say(`running \`${COMMAND}\`, log ${log}`);
		const r = await runLogged(COMMAND, { cwd: dir, log, timeoutMs: TIMEOUT, onTick: (min) => say(`... still running (${min} min)`) });
		result = { pass: r.code === 0, seconds: r.seconds, tail: tailText(r.tail), log, timedOut: r.timedOut };
		say(r.code === 0 ? `passed in ${duration(r.seconds)}` : `FAILED (exit ${r.code}${r.timedOut ? ', timed out' : ''}) after ${duration(r.seconds)}`);
	}
} catch (e) {
	await cleanup();
	die(e.message);
}
await cleanup();

// ---------------------------------------------------------------- write the result
let wrote = true;
const lb = await relabel(REPO_SLUG, NUMBER, { add: [result.pass ? LABELS.qaPass : LABELS.qaFail], remove: [result.pass ? LABELS.qaFail : LABELS.qaPass], current: labels });
if (lb.code) { wrote = false; console.error(`pr-check.mjs: could not label the pull request: ${firstLine(lb.err)}`); } else say(`label: ${result.pass ? LABELS.qaPass.name : LABELS.qaFail.name}`);
if (!card || !LEAD) {
	console.error(`pr-check.mjs: no note was posted: ${!card ? 'the pull request description has no "Card: #N" line' : 'skeleton.config.json has no lead'}.`);
	wrote = false;
} else {
	const text = qaNote({ ...result, pr: NUMBER, sha, base: BRANCH, baseSha, command: COMMAND });
	const folder = mkdtempSync(join(tmpdir(), 'pr-check-'));
	const file = join(folder, 'note.md');
	writeFileSync(file, text);
	const c = await board(['comment', String(card), '--body-file', file, '--to', LEAD, '--type', 'note']);
	rmSync(folder, { recursive: true, force: true });
	if (c.code) { wrote = false; console.error(`pr-check.mjs: could not post the note on card #${card}: ${errorOf(c.err)}`); } else say(`note posted on card #${card} to ${LEAD}`);
}
process.exit(!wrote ? 1 : result.pass ? 0 : 4);
