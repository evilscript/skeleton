// Tests for assign.mjs against stand-ins for the board: node tools/lib/run-tests.mjs tools/auto-run
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, supported } from '../lib/testkit.mjs';

const opts = { skip: !supported && 'needs a POSIX shell for the stand-in gh' };

test('assign: dry run prints the comment and changes nothing', opts, () => {
	const s = sandbox();
	s.setBoard({ cards: { 34: { no: 34, title: 'Fix login redirect', status: 'todo', assignee: null, priority: 'major' } } });
	const r = s.run('assign.mjs', ['34', 'agent-bolt', '--hint', 'login.ts is the page', '--dry-run'], { as: 'agent-atlas' });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /#34 -> agent-bolt \(Fix login redirect\)/);
	assert.match(r.out, /Start \(Atlas, Lead\): #34 is yours, priority Major/);
	assert.match(r.out, /branch agent-bolt\/34-<short-name>/);
	assert.match(r.out, /Repository acme-co\/acme/);
	assert.match(r.out, /Sub-agents: at most 2/);
	assert.deepEqual(s.boardLog().map((l) => l.args[0]), ['show']);
});

test('assign: sets the assignee and posts a typed, addressed comment the thread shows', opts, () => {
	const s = sandbox();
	s.setBoard({ cards: { 34: { no: 34, title: 'Fix login redirect', status: 'todo', assignee: null, priority: null } } });
	const r = s.run('assign.mjs', ['34', 'agent-bolt', '--docs'], { as: 'agent-atlas' });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /the thread shows it/);
	const log = s.boardLog();
	const set = log.find((l) => l.args[0] === 'set');
	assert.deepEqual(set.args.slice(1), ['34', '--assignee', 'agent-bolt']);
	const comment = log.find((l) => l.args[0] === 'comment');
	assert.deepEqual([comment.args[comment.args.indexOf('--to') + 1], comment.args[comment.args.indexOf('--type') + 1]], ['agent-bolt', 'assign']);
	assert.match(comment.body, /documentation only/);
	assert.equal(s.boardState().cards[34].assignee, 'agent-bolt');
});

test('assign: refuses a name that is not a developer, a non-Lead and a missing identity', opts, () => {
	const s = sandbox();
	s.setBoard({ cards: { 34: { no: 34, title: 't', status: 'todo' } } });
	const wrong = s.run('assign.mjs', ['34', 'agent-check'], { as: 'agent-atlas' });
	assert.equal(wrong.code, 1);
	assert.match(wrong.err, /"agent-check" is not a developer/);
	const dev = s.run('assign.mjs', ['34', 'agent-bolt'], { as: 'agent-bolt' });
	assert.equal(dev.code, 1);
	assert.match(dev.err, /Only the Lead hands out cards/);
	const none = s.run('assign.mjs', ['34', 'agent-bolt'], { extraEnv: { BOARD_AS: '' } });
	assert.equal(none.code, 1);
	assert.match(none.err, /set BOARD_AS/);
	assert.doesNotMatch(none.err, /\.mjs:\d+/);
});
