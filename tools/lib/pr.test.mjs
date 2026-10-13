// Tests for tools/lib/pr.mjs and tools/lib/comments.mjs: node tools/lib/run-tests.mjs tools/lib
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABELS, cardOfPr, kindOfPath, prNumbersIn, sectionsOf, tailText, templateReport } from './pr.mjs';
import { assignComment, assignMarker, mergedComment, qaNote } from './comments.mjs';

test('cardOfPr reads "Card: #N" from the body first, then a "#N" in the title', () => {
	assert.equal(cardOfPr('Fix login redirect', 'Some text\n\nCard: #34\n'), 34);
	assert.equal(cardOfPr('Fix login redirect', '- Card: #35'), 35);
	assert.equal(cardOfPr('Fix #36 login redirect', 'no card line'), 36);
	assert.equal(cardOfPr('Fix #36', 'Card: #37'), 37);
	assert.equal(cardOfPr('Fix login redirect', ''), null);
	assert.equal(cardOfPr(undefined, undefined), null);
});

test('prNumbersIn finds the pull requests of one repository, once each', () => {
	const text = 'See https://github.com/acme-co/acme/pull/12 and https://github.com/acme-co/acme/pull/12 and https://github.com/other/x/pull/9 and https://github.com/acme-co/acme/pull/14.';
	assert.deepEqual(prNumbersIn(text, 'acme-co/acme'), ['12', '14']);
	assert.deepEqual(prNumbersIn(text), ['12', '9', '14']);
	assert.deepEqual(prNumbersIn('', 'acme-co/acme'), []);
});

test('tailText keeps the last lines and respects the byte budget', () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
	assert.equal(tailText(lines, { lines: 3 }), 'line 97\nline 98\nline 99');
	const long = 'x'.repeat(5000);
	const t = tailText(`first\n${long}`, { bytes: 1000 });
	assert.ok(Buffer.byteLength(t) <= 1010);
	assert.ok(t.startsWith('...'));
});

test('sectionsOf and templateReport', () => {
	const template = '## Summary\n<!-- what -->\n## Testing\n<!-- how -->\n## Needs the owner\n';
	const body = 'Card: #1\n\n## Summary\nFixes the redirect.\n\n## Testing\n<!-- how -->\n\n## Needs the owner\nnone\n';
	assert.deepEqual(Object.keys(sectionsOf(body)), ['Summary', 'Testing', 'Needs the owner']);
	assert.deepEqual(templateReport(template, body), [
		{ heading: 'Summary', filled: true },
		{ heading: 'Testing', filled: false },
		{ heading: 'Needs the owner', filled: true },
	]);
	assert.deepEqual(templateReport('', body), []);
});

test('kindOfPath', () => {
	assert.equal(kindOfPath('src/login.ts'), 'code');
	assert.equal(kindOfPath('src/login.test.ts'), 'tests');
	assert.equal(kindOfPath('tests/login.py'), 'tests');
	assert.equal(kindOfPath('pkg/login_test.go'), 'tests');
	assert.equal(kindOfPath('docs/DEVELOPING.md'), 'docs');
	assert.equal(kindOfPath('README.md'), 'docs');
	assert.equal(kindOfPath('.github/pull_request_template.md'), 'docs');
});

test('the labels match the ones the documents name', () => {
	assert.deepEqual(Object.values(LABELS).map((l) => l.name), ['Lead: changes needed', 'Lead: merged', 'Needs the owner', 'QA: pass', 'QA: fail']);
});

test('assignComment: the start of a card', () => {
	const text = assignComment({ card: 34, priority: 'major', leadName: 'Atlas', repo: 'acme-co/acme', branch: 'agent-bolt/34-<short-name>', defaultBranch: 'main', hint: 'login.ts is the page', checks: { command: 'npm test', minimumScope: 'the tests of the files you touch', fullSuite: 'npm test' }, maxSubagents: 3 });
	assert.ok(text.startsWith(assignMarker('Atlas')));
	assert.match(text, /#34 is yours, priority Major/);
	assert.match(text, /board brief 34/);
	assert.match(text, /Repository acme-co\/acme, branch agent-bolt\/34-<short-name>, from the latest main, one pull request\./);
	assert.match(text, /Where to look \(signposts, not requirements\): login\.ts is the page/);
	assert.match(text, /run the minimum scope \(the tests of the files you touch\) with `npm test`/);
	assert.match(text, /Sub-agents: at most 3/);
	assert.ok(Buffer.byteLength(text) < 2000);
	const docs = assignComment({ card: 35, leadName: 'Atlas', branch: 'b/35', defaultBranch: 'main', docs: true, checks: { command: 'npm test' } });
	assert.match(docs, /documentation only/);
	assert.match(docs, /no code checks are needed/);
	assert.doesNotMatch(docs, /priority/);
});

test('mergedComment and qaNote', () => {
	const m = mergedComment({ leadName: 'Atlas', time: '14:05 America/New_York', card: 34, pr: 12, who: 'Bolt', branch: 'main', merge: 'abc1234', tested: 'No tests were run (asked for).' });
	assert.match(m, /^Atlas \(14:05 America\/New_York\): #34 is merged into main \(PR #12, by Bolt, merge commit abc1234\)\./);
	const pass = qaNote({ pass: true, pr: 12, sha: 'abcdef1234', base: 'main', baseSha: '1234567890', command: 'npm test', seconds: 125, log: '/logs/x.log' });
	assert.match(pass, /^QA: pass for PR #12 at abcdef1, merged onto main at 1234567\./);
	assert.match(pass, /Exit 0\. Took 2 min\./);
	assert.match(qaNote({ pass: true, pr: 1, sha: 'abcdef1234', base: 'main', command: 'x', seconds: 3 }), /Took 3 s\./);
	const bad = qaNote({ pass: false, pr: 12, sha: 'abcdef1234', base: 'main', command: 'npm test', seconds: 10, tail: 'FAIL login' });
	assert.match(bad, /It failed\./);
	assert.match(bad, /Last lines:\nFAIL login/);
	const conflict = qaNote({ pass: false, pr: 12, sha: 'abcdef1234', base: 'main', conflicts: ['a.ts', 'b.ts'] });
	assert.match(conflict, /does not merge cleanly into main\. Conflicts in: a\.ts, b\.ts\./);
});
