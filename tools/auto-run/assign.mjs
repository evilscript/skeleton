#!/usr/bin/env node
// The Lead's helper: hand a To do card to a developer with the standard start comment. It sets the assignee
// and posts an `assign` comment built from the card (the priority is the Owner's field; the requirement is the
// Owner's own words, the Lead adds none). The card stays in To do: the developer moves it to In progress when
// it starts.
//
//   node tools/auto-run/assign.mjs 34 agent-bolt --hint "login.ts is the page; session.ts sets the cookie"
//   node tools/auto-run/assign.mjs 35 agent-bolt --docs --note-file extra.md
//   node tools/auto-run/assign.mjs 36 agent-bolt --dry-run
//
//   <card> <developer>  the card number and the developer's board name (a developer in skeleton.config.json)
//   --hint "text"       where the code is / what is risky (signposts only; no requirements)
//   --docs              documentation only: no code checks
//   --note-file f       more text, appended as it is
//   --dry-run           print the comment, change nothing
//   --config f --cli f  the config file and the board CLI to use (defaults: found by walking up)
// BOARD_AS must be the Lead's board name. Needs Node 20+ and the board CLI.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from '../board-path.mjs';
import { ConfigError, branchPrefixOf, defaultBranch, githubRepo, loadConfig, memberByBoardName, rolesOf } from '../lib/config.mjs';
import { parseCli } from '../lib/cli.mjs';
import { boardEnv, boardProblem, makeBoard, makeBoardJson } from '../lib/board.mjs';
import { errorOf } from '../lib/proc.mjs';
import { assignComment, assignMarker } from '../lib/comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: V, positionals, fail } = parseCli(import.meta.url, {
	hint: { type: 'string' }, docs: { type: 'boolean' }, 'note-file': { type: 'string' }, 'dry-run': { type: 'boolean' },
	config: { type: 'string' }, cli: { type: 'string' },
});
const die = (msg, code = 1) => { console.error(`assign.mjs: ${msg}`); process.exit(code); };

let loaded;
try { loaded = loadConfig(V.config || here); } catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
if (loaded.isExample) die('there is no skeleton.config.json, only the example. This tool writes to the board, so it needs the project\'s own config: run the first-run protocol in START_HERE.md.');
const config = loaded.config;

const ME = process.env.BOARD_AS || '';
if (!ME) die('set BOARD_AS to the Lead\'s board name first.');
const lead = memberByBoardName(config, ME);
if (lead && lead.role !== 'lead') die(`BOARD_AS is ${ME}, a ${lead.role}. Only the Lead hands out cards.`);

const [card, dev] = positionals;
const devs = rolesOf(config, 'developer');
if (!/^\d+$/.test(card || '') || !dev) fail(`usage: node tools/auto-run/assign.mjs <card> <${devs.map((d) => d.boardName).join('|') || 'developer'}> [--hint text] [--docs] [--note-file f] [--dry-run]`);
if (!devs.some((d) => d.boardName === dev)) die(`"${dev}" is not a developer in skeleton.config.json. Developers: ${devs.map((d) => d.boardName).join(', ') || '(none)'}.`);

const env = boardEnv(loaded, { as: ME });
const problem = boardProblem(env, loaded);
if (problem) die(problem);
const cli = V.cli || boardCli(resolve(here, '../..'));
const board = makeBoard({ cli, env });
const boardJson = makeBoardJson(board);
const must = async (args) => {
	const r = await board(args);
	if (r.code) die(errorOf(r.err) || `board ${args[0]} failed`);
	return r.out;
};

let c;
try { c = (await boardJson(['show', card])).card; } catch (e) { die(e.message); }
if (['done', 'on_prod_qa', 'on_main'].includes(c.status)) console.error(`note: #${card} is ${c.status}, not in To do`);

const body = assignComment({
	card, priority: c.priority, leadName: lead?.name || ME, repo: githubRepo(config), defaultBranch: defaultBranch(config),
	branch: `${branchPrefixOf(config, dev)}${card}-<short-name>`, docs: V.docs, hint: V.hint, checks: config.checks,
	maxSubagents: config.agentPolicy?.maxSubagents, extra: V['note-file'] ? readFileSync(resolve(V['note-file']), 'utf8').trim() : '',
});
if (Buffer.byteLength(body) > 4000) die('the comment is over the board\'s 4096-byte limit: shorten --hint or --note-file.');

if (V['dry-run']) {
	console.log(`#${card} -> ${dev} (${c.title})\n\n${body}`);
	process.exit(0);
}
if (c.assignee !== dev) await must(['set', card, '--assignee', dev]);
const folder = mkdtempSync(join(tmpdir(), 'assign-'));
const file = join(folder, 'comment.md');
writeFileSync(file, body);
let said;
try { said = await must(['comment', card, '--body-file', file, '--to', dev, '--type', 'assign']); } finally { rmSync(folder, { recursive: true, force: true }); }
const thread = await must(['thread', card]);
const ok = thread.includes(assignMarker(lead?.name || ME));
console.log(`${said.trim()} ${ok ? '- the thread shows it' : '- NOT in the thread, check'}; #${card} is ${c.status} (the developer moves it to In progress)`);
if (!ok) process.exit(1);
