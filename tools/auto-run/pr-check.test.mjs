// Tests for pr-check.mjs against a throw-away repository, a stand-in gh and a stand-in board: node tools/lib/run-tests.mjs tools/auto-run
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, supported } from '../lib/testkit.mjs';

const opts = { skip: !supported && 'needs a POSIX shell for the stand-in gh' };
const edit = (s) => s.ghLog().filter((a) => a[0] === 'pr' && a[1] === 'edit');

test('pr-check: a passing run labels the pull request and notes the Lead on the card; it pushes nothing', opts, () => {
	const s = sandbox({ checkCommand: 'node -e "require(\'fs\').statSync(\'feature-12.txt\')"' });
	const pr = s.addPr(12);
	const r = s.run('pr-check.mjs', ['12'], { as: 'agent-check' });
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(r.out, /passed in/);
	assert.deepEqual(edit(s)[0].slice(0, 5), ['pr', 'edit', '12', '--repo', 'acme-co/acme']);
	assert.ok(edit(s)[0].includes('QA: pass'));
	assert.ok(s.ghLog().some((a) => a[0] === 'label' && a[1] === 'create' && a[2] === 'QA: pass'));
	const note = s.boardLog().find((l) => l.args[0] === 'comment');
	assert.deepEqual([note.args[1], note.args[note.args.indexOf('--to') + 1], note.args[note.args.indexOf('--type') + 1]], [String(pr.card), 'agent-atlas', 'note']);
	assert.match(note.body, new RegExp(`^QA: pass for PR #12 at ${pr.sha.slice(0, 7)}, merged onto main at`));
	assert.deepEqual(s.originLog(), ['Initial']); // nothing was pushed or merged
	assert.equal(s.git(['worktree', 'list']).split('\n').length, 1);
});

test('pr-check: a failing run is QA: fail with the last lines of the output (exit 4) and removes QA: pass', opts, () => {
	const s = sandbox({ checkCommand: 'node -e "console.log(\'FAIL login test\'); process.exit(1)"' });
	s.addPr(12, { labels: ['QA: pass'] });
	const r = s.run('pr-check.mjs', ['12'], { as: 'agent-check' });
	assert.equal(r.code, 4, r.out + r.err);
	const e = edit(s)[0];
	assert.equal(e[e.indexOf('--add-label') + 1], 'QA: fail');
	assert.equal(e[e.indexOf('--remove-label') + 1], 'QA: pass');
	const note = s.boardLog().find((l) => l.args[0] === 'comment');
	assert.match(note.body, /^QA: fail for PR #12/);
	assert.match(note.body, /It failed\./);
	assert.match(note.body, /FAIL login test/);
});

test('pr-check: a pull request that conflicts with main fails without running the command', opts, () => {
	const s = sandbox({ checkCommand: 'node -e "process.exit(0)"' });
	s.addPr(12, { files: { 'app.txt': 'line one by the developer\nline two\n' } });
	s.pushToMain({ 'app.txt': 'line one by somebody else\nline two\n' });
	const r = s.run('pr-check.mjs', ['12'], { as: 'agent-check' });
	assert.equal(r.code, 4, r.out + r.err);
	const note = s.boardLog().find((l) => l.args[0] === 'comment');
	assert.match(note.body, /does not merge cleanly into main\. Conflicts in: app\.txt/);
});

test('pr-check: --dry-run reads the pull request and changes nothing', opts, () => {
	const s = sandbox();
	s.addPr(12);
	const r = s.run('pr-check.mjs', ['12', '--dry-run'], { as: 'agent-check' });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /PR #12 "Fix login redirect"/);
	assert.match(r.out, /would: fetch the head, merge it onto origin\/main/);
	assert.match(r.out, /post a note on card #32 to agent-atlas/);
	assert.equal(edit(s).length, 0);
	assert.equal(s.boardLog().length, 0);
});

test('pr-check: readable refusals', opts, () => {
	const s = sandbox();
	s.addPr(12, { draft: true });
	assert.match(s.run('pr-check.mjs', ['12'], { as: 'agent-check' }).err, /is a draft/);
	assert.match(s.run('pr-check.mjs', ['12'], { as: 'agent-bolt' }).err, /a developer/);
	assert.match(s.run('pr-check.mjs', ['99'], { as: 'agent-check' }).err, /gh could not read pull request #99/);
	assert.match(s.run('pr-check.mjs', [], { as: 'agent-check' }).err, /usage:/);
	const none = s.run('pr-check.mjs', ['12'], { extraEnv: { BOARD_AS: '' } });
	assert.match(none.err, /set BOARD_AS/);
});
