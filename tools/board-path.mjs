// Where the board's command line (board/cli/board.mjs) is, from any checkout or worktree of this repository.
//
// In order: the BOARD_CLI environment variable; then, walking up from the folder given, the first folder that has
// board/cli/board.mjs inside it (the board lives in the same repository, so every checkout has its own copy).
// When nothing is found the answer is <start>/board/cli/board.mjs, so a missing file gives a readable
// "cannot find module" naming the place to look.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CLI = join('board', 'cli', 'board.mjs');

export function boardCli(startDir, env = process.env) {
	if (env.BOARD_CLI) return env.BOARD_CLI;
	let dir = resolve(startDir);
	for (;;) {
		const found = join(dir, CLI);
		if (existsSync(found)) return found;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return resolve(startDir, CLI);
}
