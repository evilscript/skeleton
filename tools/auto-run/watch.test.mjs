// End-to-end tests of watch.mjs against a stand-in board CLI (a local file that prints canned JSON).
// No network, no board, no GitHub: the Lead runs with --prs 0.   node tools/lib/run-tests.mjs tools/auto-run
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../lib/tmp.mjs';

const watch = resolve(dirname(fileURLToPath(import.meta.url)), 'watch.mjs');
const dir = tempDir('watch-');
const config = join(dir, 'skeleton.config.json');
writeFileSync(config, JSON.stringify({
	version: 1,
	project: { name: 'Acme', slug: 'acme' },
	github: { owner: 'acme-co', repo: 'acme', defaultBranch: 'main' },
	owner: { name: 'Jordan', boardName: 'owner', timezone: 'UTC' },
	roles: [
		{ role: 'lead', name: 'Atlas', boardName: 'agent-atlas' },
		{ role: 'developer', name: 'Bolt', boardName: 'agent-bolt' },
		{ role: 'qa', name: 'Check', boardName: 'agent-check', limited: true },
	],
	board: { enabled: true, url: 'https://board.invalid' },
	checks: { command: 'true' },
}));

// The stand-in CLI answers from a fixture file named by FAKE_BOARD.
const fake = join(dir, 'fake-board.mjs');
writeFileSync(fake, `
import { readFileSync } from 'node:fs';
const f = JSON.parse(readFileSync(process.env.FAKE_BOARD, 'utf8'));
const cmd = process.argv[2];
if (cmd === 'version') console.log(JSON.stringify({ v: f.v, c: Math.max(0, ...f.comments.map((m) => m.id)) }));
else if (cmd === 'list') console.log(JSON.stringify(f.cards));
else if (cmd === 'feed') console.log(JSON.stringify(f.comments));
else if (cmd === 'agents') console.log('agent-atlas\\tAtlas\\nagent-bolt\\tBolt\\nagent-check\\tCheck\\nowner\\tJordan (the owner: assignee only)');
else if (cmd === 'brief') console.log(JSON.stringify({ brief: '/briefs/' + process.argv[3] + '/brief.md', files: [] }));
else { console.error('board: unknown command ' + cmd); process.exit(1); }
`);

let n = 0;
function fixture(data) {
	const file = join(dir, `fixture-${++n}.json`);
	writeFileSync(file, JSON.stringify(data));
	return file;
}
const card = (o) => ({ no: 1, title: 'Fix login redirect', status: 'todo', assignee: null, priority: null, updatedAt: '2026-10-13T10:00:00Z', updatedBy: 'owner', ...o });
const comment = (o) => ({ id: 1, cardNo: 1, author: 'owner', to: null, type: 'note', body: 'hello', ref: null, createdAt: '2026-10-13T10:00:00Z', ...o });

function run(role, as, fix, state, extra = []) {
	const args = [watch, '--as', as, '--role', role, '--once', '--config', config, '--cli', fake, '--state', join(dir, state), '--prs', '0', ...extra];
	const r = spawnSync(process.execPath, args, { env: { ...process.env, FAKE_BOARD: fix, BOARD_URL: 'https://board.invalid' }, encoding: 'utf8' });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

test('developer: the first run reports what waits for it, later runs only what is new, with a brief', () => {
	const one = fixture({ v: 'a', cards: [card({ no: 5, status: 'todo', assignee: 'agent-bolt' }), card({ no: 6, status: 'backlog' })], comments: [comment({ id: 1, cardNo: 5, author: 'agent-atlas', to: 'agent-bolt', type: 'assign', body: 'Start.' })] });
	const a = run('developer', 'agent-bolt', one, 'dev.json');
	assert.equal(a.code, 0);
	assert.match(a.out, /\[card\] \(waiting\) #5 "Fix login redirect" status=todo assignee=agent-bolt \| brief: \/briefs\/5\/brief\.md/);
	assert.match(a.out, /\[comment\] \(unanswered\) #5 \[1\] agent-atlas -> agent-bolt assign: Start\./);
	assert.match(a.out, /\[watch\] baseline: 2 cards, comments up to 1/);
	const again = run('developer', 'agent-bolt', one, 'dev.json');
	assert.equal(again.out.trim(), '');
	const two = fixture({ v: 'b', cards: [card({ no: 5, status: 'todo', assignee: 'agent-bolt' })], comments: [comment({ id: 1, cardNo: 5, author: 'agent-atlas', to: 'agent-bolt', type: 'assign' }), comment({ id: 2, cardNo: 5, author: 'owner', body: 'Use the blue button.' })] });
	const b = run('developer', 'agent-bolt', two, 'dev.json');
	assert.match(b.out, /\[comment\] #5 \[2\] owner -> - note: Use the blue button\. \| brief: /);
	assert.equal(b.out.split('\n').filter(Boolean).length, 1);
});

test('lead: new To do cards, comments of others, unanswered assign and stuck cards', () => {
	const old = new Date(Date.now() - 10 * 3600e3).toISOString();
	const base = fixture({ v: 'a', cards: [card({ no: 2, status: 'progress', assignee: 'agent-bolt', updatedAt: old })], comments: [comment({ id: 1, cardNo: 2, author: 'agent-atlas', to: 'agent-bolt', type: 'assign', createdAt: old })] });
	const first = run('lead', 'agent-atlas', base, 'lead.json');
	assert.match(first.out, /\[watch\] baseline: 1 cards/);
	assert.match(first.out, /\[no-ack\] #2 assign \[1\] to agent-bolt has no reply/);
	assert.match(first.out, /\[stuck\] #2 "Fix login redirect" in progress with agent-bolt/);
	const next = fixture({ v: 'b', cards: [card({ no: 2, status: 'progress', assignee: 'agent-bolt', updatedAt: old }), card({ no: 3, status: 'todo' }), card({ no: 4, status: 'backlog' })], comments: [comment({ id: 1, cardNo: 2, author: 'agent-atlas', to: 'agent-bolt', type: 'assign', createdAt: old }), comment({ id: 2, cardNo: 2, author: 'agent-bolt', to: 'agent-atlas', type: 'question', body: 'Which one?' })] });
	const r = run('lead', 'agent-atlas', next, 'lead.json');
	assert.match(r.out, /\[card\] new #3 "Fix login redirect" status=todo/);
	assert.doesNotMatch(r.out, /#4/);
	assert.match(r.out, /\[comment\] #2 \[2\] agent-bolt -> agent-atlas question: Which one\?/);
});

test('qa: a developer\'s review comment is a [review] line naming the pull request; the Lead\'s is not', () => {
	const one = fixture({ v: 'a', cards: [card({ no: 9, status: 'progress', assignee: 'agent-bolt' })], comments: [] });
	assert.match(run('qa', 'agent-check', one, 'qa.json').out, /baseline: 1 cards/);
	const two = fixture({ v: 'b', cards: [card({ no: 9, status: 'pr_review', assignee: 'agent-bolt' })], comments: [
		comment({ id: 1, cardNo: 9, author: 'agent-bolt', to: 'agent-atlas', type: 'review', body: 'Ready: https://github.com/acme-co/acme/pull/12 on branch agent-bolt/9-fix' }),
		comment({ id: 2, cardNo: 9, author: 'agent-atlas', to: 'agent-bolt', type: 'review', body: 'Lead review: ready to merge.' }),
	] });
	const r = run('qa', 'agent-check', two, 'qa.json');
	assert.match(r.out, /\[review\] #9 \[1\] agent-bolt submitted PR #12: Ready:/);
	assert.doesNotMatch(r.out, /\[2\]/);
	assert.equal(r.out.split('\n').filter(Boolean).length, 1);
});

test('--wake exits after the first event, printing it', () => {
	const one = fixture({ v: 'a', cards: [card({ no: 5, status: 'todo', assignee: 'agent-bolt' })], comments: [] });
	const args = [watch, '--as', 'agent-bolt', '--role', 'developer', '--wake', '--minutes', '1', '--config', config, '--cli', fake, '--state', join(dir, 'wake.json'), '--brief', '0'];
	const env = { ...process.env, FAKE_BOARD: one, BOARD_URL: 'https://board.invalid' };
	const first = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 20000 });
	assert.equal(first.status, 0);
	assert.match(first.stdout, /\[card\] \(waiting\) #5/);
	assert.doesNotMatch(first.stdout, /\| brief:/); // --brief 0
});

test('failures are readable: no identity, a bad role, no board address, an unreachable board', () => {
	const none = spawnSync(process.execPath, [watch, '--config', config, '--once'], { env: { ...process.env, BOARD_AS: '' }, encoding: 'utf8' });
	assert.equal(none.status, 2);
	assert.match(none.stderr, /say who you are/);
	const role = spawnSync(process.execPath, [watch, '--as', 'x', '--role', 'boss', '--config', config], { encoding: 'utf8' });
	assert.equal(role.status, 2);
	assert.match(role.stderr, /--role must be lead, developer or qa/);
	const url = spawnSync(process.execPath, [watch, '--as', 'agent-bolt', '--once', '--config', join(dir, 'nothing.json')], { env: { ...process.env, BOARD_URL: '' }, encoding: 'utf8' });
	assert.equal(url.status, 1);
	assert.doesNotMatch(url.stderr, /at .*\.mjs:\d+/); // no stack trace
	const bad = spawnSync(process.execPath, [watch, '--as', 'agent-bolt', '--once', '--config', config, '--cli', join(dir, 'missing.mjs'), '--state', join(dir, 'x.json')], { env: { ...process.env, BOARD_URL: 'https://board.invalid' }, encoding: 'utf8' });
	assert.equal(bad.status, 1);
	assert.match(bad.stdout, /\[watch\] board unreachable/);
});

test('--help prints the header', () => {
	const out = execFileSync(process.execPath, [watch, '--help'], { encoding: 'utf8' });
	assert.match(out, /The board listener for every agent/);
	assert.match(out, /--role lead\|developer\|qa/);
});
