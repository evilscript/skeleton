// Tests for tools/board-path.mjs: node tools/lib/run-tests.mjs tools/lib
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardCli, CLI } from '../board-path.mjs';
import { tempDir } from './tmp.mjs';

function checkout() {
	const root = tempDir('bp-');
	mkdirSync(join(root, 'board', 'cli'), { recursive: true });
	writeFileSync(join(root, CLI), '// board\n');
	mkdirSync(join(root, 'tools', 'auto-run'), { recursive: true });
	return root;
}

test('finds board/cli/board.mjs by walking up from a subfolder', () => {
	const root = checkout();
	assert.equal(boardCli(join(root, 'tools', 'auto-run'), {}), join(root, CLI));
	assert.equal(boardCli(root, {}), join(root, CLI));
});

test('a worktree inside another checkout finds its own copy first', () => {
	const outer = checkout();
	const inner = join(outer, 'PM - Atlas', 'batch-1');
	mkdirSync(join(inner, 'board', 'cli'), { recursive: true });
	writeFileSync(join(inner, CLI), '// board\n');
	assert.equal(boardCli(join(inner, 'tools'), {}), join(inner, CLI));
});

test('BOARD_CLI overrides the search', () => {
	const root = checkout();
	assert.equal(boardCli(root, { BOARD_CLI: '/somewhere/board.mjs' }), '/somewhere/board.mjs');
});

test('nothing found: the answer names the place to look', () => {
	const empty = tempDir('bp-empty-');
	assert.equal(boardCli(empty, {}), join(empty, CLI));
});
