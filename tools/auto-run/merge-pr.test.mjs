// Tests for merge-pr.mjs against a throw-away repository, a stand-in gh and a stand-in board: node tools/lib/run-tests.mjs tools/auto-run
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, supported } from '../lib/testkit.mjs';

const opts = { skip: !supported && 'needs a POSIX shell for the stand-in gh' };
const ready = (s, number, extra = {}) => {
	const pr = s.addPr(number, extra);
	s.addComment({ cardNo: pr.card, author: 'agent-atlas', type: 'review', body: 'Lead review: ready to merge.' });
	s.addComment({ cardNo: pr.card, author: 'agent-check', type: 'note', body: 'QA: pass' });
	return pr;
};
const passed = ['QA: pass'];

test('merge-pr: merges, checks, pushes, moves the card, comments and labels', opts, () => {
	const s = sandbox();
	const pr = ready(s, 12, { labels: passed });
	const r = s.run('merge-pr.mjs', ['12'], { as: 'agent-atlas' });
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(r.out, /gates: ok/);
	assert.match(r.out, /the checks passed/);
	assert.equal(s.originLog()[0], 'Merge PR #12: Fix login redirect (card #32)');
	assert.ok(s.originLog().includes('Work on card 32'));
	const log = s.boardLog();
	assert.ok(log.some((l) => l.args[0] === 'move' && l.args[1] === String(pr.card) && l.args[2] === 'on_main'));
	const merged = log.find((l) => l.args[0] === 'comment' && l.args.includes('merged'));
	assert.equal(merged.args[merged.args.indexOf('--to') + 1], 'owner');
	assert.match(merged.args[2], /#32 is merged into main \(PR #12, by Bolt, merge commit [0-9a-f]+\)/);
	assert.ok(s.ghLog().some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('Lead: merged')));
	// the main checkout is at origin's main, the scratch tree and branch are gone
	assert.equal(s.git(['rev-parse', 'HEAD']), s.git(['rev-parse', 'main'], s.origin));
	assert.equal(s.git(['branch', '--list', 'merge/*']), '');
	assert.equal(s.git(['worktree', 'list']).split('\n').length, 1);
});

test('merge-pr: --keep leaves the scratch tree with the merged files and the check command\'s output', opts, () => {
	const s = sandbox({ checkCommand: 'node -e "require(\'fs\').writeFileSync(\'checked.txt\', \'ran\')"' });
	ready(s, 12, { labels: passed });
	const r = s.run('merge-pr.mjs', ['12', '--dry-run', '--keep'], { as: 'agent-atlas' });
	assert.equal(r.code, 0, r.out + r.err);
	const dir = /kept: (.+?) \(merge\//.exec(r.out)[1];
	assert.ok(existsSync(join(dir, 'feature-12.txt')));
	assert.ok(existsSync(join(dir, 'checked.txt')));
	// a dry run pushes nothing and changes no card or label
	assert.deepEqual(s.originLog(), ['Initial']);
	assert.ok(!s.boardLog().some((l) => ['move', 'comment'].includes(l.args[0])));
	assert.ok(!s.ghLog().some((a) => a[1] === 'edit'));
});

test('merge-pr: refuses without the Lead\'s review after the last commit', opts, () => {
	const s = sandbox();
	s.addPr(12, { labels: passed });
	s.addComment({ cardNo: 32, author: 'agent-atlas', type: 'review', minutes: -60 }); // older than the commit
	const r = s.run('merge-pr.mjs', ['12'], { as: 'agent-atlas' });
	assert.equal(r.code, 1);
	assert.match(r.err, /no "agent-atlas" review comment on card #32 after its last commit/);
	assert.deepEqual(s.originLog(), ['Initial']);
});

test('merge-pr: refuses without the QA label, and with a QA result older than the last commit', opts, () => {
	const s = sandbox();
	s.addPr(12);
	s.addComment({ cardNo: 32, author: 'agent-atlas', type: 'review' });
	const noLabel = s.run('merge-pr.mjs', ['12'], { as: 'agent-atlas' });
	assert.equal(noLabel.code, 1);
	assert.match(noLabel.err, /needs the label "QA: pass"/);
	const s2 = sandbox();
	s2.addPr(12, { labels: passed });
	s2.addComment({ cardNo: 32, author: 'agent-atlas', type: 'review' });
	s2.addComment({ cardNo: 32, author: 'agent-check', type: 'note', minutes: -60 });
	const stale = s2.run('merge-pr.mjs', ['12'], { as: 'agent-atlas' });
	assert.equal(stale.code, 1);
	assert.match(stale.err, /QA has not written on card #32 since the last commit/);
	const skip = s2.run('merge-pr.mjs', ['12', '--skip-qa', '--dry-run'], { as: 'agent-atlas' });
	assert.equal(skip.code, 0, skip.out + skip.err);
});

test('merge-pr: a failing check command stops before anything is pushed (exit 4)', opts, () => {
	const s = sandbox({ checkCommand: 'node -e "console.log(\'broken test\'); process.exit(1)"' });
	ready(s, 12, { labels: passed });
	const r = s.run('merge-pr.mjs', ['12', '--keep'], { as: 'agent-atlas' });
	assert.equal(r.code, 4);
	assert.match(r.err, /did not pass \(exit 1\)/);
	assert.match(r.err, /broken test/);
	assert.match(r.err, /Nothing was pushed/);
	assert.deepEqual(s.originLog(), ['Initial']);
	assert.ok(!s.boardLog().some((l) => l.args[0] === 'move'));
	const ok = s.run('merge-pr.mjs', ['12', '--tests', 'none', '--dry-run'], { as: 'agent-atlas' });
	assert.equal(ok.code, 0, ok.out + ok.err);
	assert.match(ok.out, /checks: none \(asked for\)/);
});

test('merge-pr: a conflict stops with exit 3 and leaves the tree', opts, () => {
	const s = sandbox();
	ready(s, 12, { labels: passed, files: { 'app.txt': 'line one by the developer\nline two\n' } });
	s.pushToMain({ 'app.txt': 'line one by somebody else\nline two\n' });
	const r = s.run('merge-pr.mjs', ['12'], { as: 'agent-atlas' });
	assert.equal(r.code, 3, r.out + r.err);
	assert.match(r.err, /Conflicts in:\s+app\.txt/);
	assert.ok(!s.originLog().some((m) => m.startsWith('Merge PR')));
});

test('merge-pr: refuses a dirty main tree, a draft, a missing card line and a non-Lead', opts, () => {
	const s = sandbox();
	ready(s, 12, { labels: passed });
	writeDirty(s);
	assert.match(s.run('merge-pr.mjs', ['12'], { as: 'agent-atlas' }).err, /main working tree has changes/);
	const s2 = sandbox();
	s2.addPr(13, { draft: true });
	assert.match(s2.run('merge-pr.mjs', ['13'], { as: 'agent-atlas' }).err, /PR #13 is a draft/);
	s2.addPr(14, { body: 'no card line here', title: 'No number' });
	assert.match(s2.run('merge-pr.mjs', ['14'], { as: 'agent-atlas' }).err, /no "Card: #N" line/);
	assert.match(s2.run('merge-pr.mjs', ['14'], { as: 'agent-bolt' }).err, /Only the Lead merges/);
	assert.match(s2.run('merge-pr.mjs', ['99'], { as: 'agent-atlas' }).err, /gh could not read pull request #99/);
});

import { writeFileSync } from 'node:fs';
function writeDirty(s) {
	writeFileSync(join(s.work, 'app.txt'), 'dirty\n');
}
