#!/usr/bin/env node
// What to look at before reading a pull request's code: the facts a review starts with, on one screen.
// It decides nothing and does not replace reading the diff; it says where to look.
//
//   node tools/auto-run/review-prep.mjs 12 [--config f] [--cli f]
//
// Reports: state, size, files by kind (code, tests, docs), the "Card: #N" line, which sections of
// .github/pull_request_template.md the description filled in, whether code changed without any test file
// changing, and where the card stands: the Lead's review after the last commit, and the QA's result.
// BOARD_AS is the Lead's board name (used to find the Lead's own review). Needs Node 20+, git, gh and the board CLI.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from '../board-path.mjs';
import { ConfigError, githubRepo, leadBoardName, loadConfig, rolesOf } from '../lib/config.mjs';
import { parseCli } from '../lib/cli.mjs';
import { boardEnv, boardProblem, makeBoard, makeBoardJson } from '../lib/board.mjs';
import { firstLine, sh } from '../lib/proc.mjs';
import { LABELS, cardOfPr, kindOfPath, templateReport } from '../lib/pr.mjs';
import { prView } from '../lib/gh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: V, positionals, fail } = parseCli(import.meta.url, { config: { type: 'string' }, cli: { type: 'string' } });
const die = (msg) => { console.error(`review-prep.mjs: ${msg}`); process.exit(1); };
if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) fail('usage: node tools/auto-run/review-prep.mjs <pull request number>');

let loaded;
try { loaded = loadConfig(V.config || here); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
const config = loaded.config;
const repoSlug = githubRepo(config);
if (loaded.isExample || !repoSlug) die('there is no skeleton.config.json with github.owner and github.repo (only the example, or none). Run the first-run protocol in START_HERE.md.');
const ME = process.env.BOARD_AS || leadBoardName(config);
const env = boardEnv(loaded, { as: ME });

let pr;
try { pr = await prView(repoSlug, positionals[0], 'number,title,body,headRefName,headRefOid,state,isDraft,mergeable,additions,deletions,changedFiles,labels,files'); } catch (e) { die(e.message); }
const card = cardOfPr(pr.title, pr.body);
const labels = pr.labels.map((l) => l.name);
const by = { code: [], tests: [], docs: [] };
for (const f of pr.files) by[kindOfPath(f.path)].push(f.path);
const docsOnly = pr.files.length > 0 && !by.code.length && !by.tests.length;

const out = [];
const P = (s = '') => out.push(s);
const mark = (ok, s) => P(`  ${ok ? '[x]' : '[ ]'} ${s}`);
P(`PR #${pr.number} ${pr.title}`);
P(`  ${pr.headRefName} @ ${pr.headRefOid.slice(0, 7)} - ${pr.state}${pr.isDraft ? ' (draft)' : ''} - mergeable: ${pr.mergeable} - +${pr.additions} -${pr.deletions} in ${pr.changedFiles} files - card ${card ? `#${card}` : 'MISSING'}`);
P(`  labels: ${labels.join(', ') || '-'}`);
P();
P(docsOnly ? 'DOCUMENTATION ONLY: no code or test file changed.' : `files: code ${by.code.length} - tests ${by.tests.length} - docs ${by.docs.length}`);
for (const k of ['code', 'tests']) if (by[k].length) P(`  ${k}: ${by[k].slice(0, 14).join(', ')}${by[k].length > 14 ? ` ... (+${by[k].length - 14})` : ''}`);
if (by.code.length && !by.tests.length) P('  look: code changed but no test file did.');

P();
let template = '';
try { template = readFileSync(join(loaded.root, '.github', 'pull_request_template.md'), 'utf8'); } catch { /* no template: only the card line is checked */ }
P('description:');
mark(Boolean(card), 'Card: #N line');
for (const s of templateReport(template, pr.body)) mark(s.filled, `section "${s.heading}"${s.filled ? '' : ' is empty'}`);

if (card) {
	const board = makeBoardJson(makeBoard({ cli: V.cli || boardCli(resolve(here, '../..')), env }));
	const problem = boardProblem(env, loaded);
	P();
	if (problem) P(`card #${card}: not read (${problem})`);
	else {
		try {
			const comments = await board(['thread', String(card)]);
			const c = await sh('git', ['log', '-1', '--format=%cI', `origin/${pr.headRefName}`], { cwd: here });
			const committed = c.code || !c.out.trim() ? null : new Date(c.out.trim());
			const late = (x) => (committed ? new Date(x.createdAt) > committed : null);
			const mine = comments.filter((x) => x.author === ME && x.type === 'review').pop();
			P(mine ? (late(mine) === false ? `card #${card}: the last review by ${ME} is OLDER than the last commit: review again` : `card #${card}: reviewed by ${ME} at ${mine.createdAt}${committed ? ' (after the last commit)' : ' (fetch the branch to compare with the last commit)'}`) : `card #${card}: no review by ${ME} yet`);
			if (rolesOf(config, 'qa').length) {
				const qa = new Set(rolesOf(config, 'qa').map((r) => r.boardName));
				const note = comments.filter((x) => qa.has(x.author)).pop();
				P(`  QA: ${labels.includes(LABELS.qaPass.name) ? 'pass' : labels.includes(LABELS.qaFail.name) ? 'FAIL' : 'not yet'} (label)${note ? `, last QA comment ${note.createdAt}${late(note) === false ? ' - OLDER than the last commit' : ''}` : ', no QA comment'}`);
			}
		} catch (e) { P(`card #${card}: could not be read (${firstLine(e.message)})`); }
	}
}
console.log(out.join('\n'));
