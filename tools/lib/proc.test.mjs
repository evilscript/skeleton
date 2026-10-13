// Tests for tools/lib/proc.mjs, cli.mjs, board.mjs and worktree.mjs: node tools/lib/run-tests.mjs tools/lib
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmp.mjs';
import { errorOf, firstLine, sh } from './proc.mjs';
import { headerOf } from './cli.mjs';
import { boardEnv, boardProblem } from './board.mjs';
import { linkInto, memberDir, runLogged, stamp } from './worktree.mjs';

test('sh returns code, out and err and never throws', async () => {
	const ok = await sh(process.execPath, ['-e', 'console.log("hi"); console.error("warn")']);
	assert.deepEqual([ok.code, ok.out.trim(), ok.err.trim()], [0, 'hi', 'warn']);
	const bad = await sh(process.execPath, ['-e', 'process.exit(3)']);
	assert.equal(bad.code, 3);
	const missing = await sh('no-such-command-xyz', []);
	assert.equal(missing.code, 127);
	assert.match(missing.err, /cannot run "no-such-command-xyz".*PATH/);
});

test('sh stops a command that runs too long', async () => {
	const r = await sh(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 300 });
	assert.notEqual(r.code, 0);
	assert.match(r.err, /did not finish/);
});

test('errorOf picks the board\'s own line, or explains a network failure', () => {
	assert.equal(errorOf('noise\nboard: no key for agent-x\n'), 'board: no key for agent-x');
	const stack = 'TypeError: fetch failed\n    at x\n  [cause]: Error: getaddrinfo ENOTFOUND board.invalid\n';
	assert.match(errorOf(stack), /^board: cannot reach the board \(getaddrinfo ENOTFOUND board\.invalid\)/);
	assert.equal(errorOf('plain failure\nmore'), 'plain failure');
	assert.equal(firstLine('\n\n a \n b'), 'a');
});

test('headerOf returns the leading comment block without the shebang', () => {
	assert.equal(headerOf('#!/usr/bin/env node\n// One\n//   two\n//\n// three\nimport x from "y";\n// not part'), 'One\n  two\n\nthree');
	assert.equal(headerOf('// only\n'), 'only');
});

test('boardEnv fills BOARD_URL and BOARD_PROJECT from a real config, never from the example', () => {
	const config = { board: { url: 'https://board.example.org', defaultProject: 'main' } };
	const real = boardEnv({ config, isExample: false }, { as: 'agent-bolt', base: {} });
	assert.deepEqual(real, { BOARD_URL: 'https://board.example.org', BOARD_PROJECT: 'main', BOARD_AS: 'agent-bolt' });
	assert.deepEqual(boardEnv({ config, isExample: true }, { base: {} }), {});
	const own = boardEnv({ config, isExample: false }, { base: { BOARD_URL: 'http://mine' } });
	assert.equal(own.BOARD_URL, 'http://mine');
});

test('boardProblem says what to set', () => {
	assert.match(boardProblem({}, { config: {} }), /No board address/);
	assert.equal(boardProblem({ BOARD_URL: 'https://x' }, { config: {} }), null);
	assert.match(boardProblem({ BOARD_URL: 'https://x' }, { config: { board: { enabled: false } } }), /switched off/);
});

test('memberDir: the member\'s folder above the checkout, below it, or a temporary one', () => {
	const root = tempDir('md-');
	const member = { folder: 'QA - Check' };
	assert.equal(memberDir(join(root, 'QA - Check', 'main'), member), join(root, 'QA - Check'));
	assert.equal(memberDir(root, member), join(root, 'QA - Check'));
	assert.equal(memberDir(root, null, 'acme'), join(tmpdir(), 'acme'));
	assert.match(stamp(new Date(2026, 9, 13, 14, 5, 9)), /^20261013-140509$/);
});

test('linkInto links only what exists in the checkout and not yet in the tree', () => {
	const repo = tempDir('li-repo-');
	const tree = tempDir('li-tree-');
	mkdirSync(join(repo, 'node_modules'));
	writeFileSync(join(repo, 'node_modules', 'x.txt'), 'x');
	assert.deepEqual(linkInto(repo, tree, ['node_modules', 'cache']), ['node_modules']);
	assert.equal(readFileSync(join(tree, 'node_modules', 'x.txt'), 'utf8'), 'x');
	assert.deepEqual(linkInto(repo, tree, ['node_modules']), []);
});

test('runLogged writes the log, keeps the tail and reports the exit code', async () => {
	const dir = tempDir('rl-');
	const log = join(dir, 'logs', 'run.log');
	const cmd = `"${process.execPath}" -e "console.log('a'); console.error('b'); process.exit(2)"`;
	const r = await runLogged(cmd, { cwd: dir, log });
	assert.equal(r.code, 2);
	assert.match(r.tail, /a/);
	assert.ok(existsSync(log));
	assert.match(readFileSync(log, 'utf8'), /b/);
	const slow = await runLogged(`"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, { cwd: dir, log, timeoutMs: 400 });
	assert.equal(slow.timedOut, true);
	assert.notEqual(slow.code, 0);
});
