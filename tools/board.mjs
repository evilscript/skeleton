#!/usr/bin/env node
// The board's command line from any checkout of this repository, whatever the folder layout:
//   node tools/board.mjs whoami
//   node tools/board.mjs thread 34
//   node tools/board.mjs --help
// It finds board/cli/board.mjs (tools/board-path.mjs; BOARD_CLI overrides) and runs it with the same
// arguments and your environment: BOARD_AS says who you are, BOARD_URL and BOARD_PROJECT override
// skeleton.config.json, and the key comes from BOARD_KEY_<NAME>, BOARD_KEY or the key store (board/README.md).
// Needs Node 20+.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCli } from './board-path.mjs';
import { headerOf } from './lib/cli.mjs';

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const help = args[0] === '--help' || args[0] === '-h';

const cli = boardCli(resolve(dirname(self), '..'));
if (!existsSync(cli)) {
	console.error(`board.mjs: cannot find the board's command line (looked for ${cli}). Run this from a checkout of the repository, or set BOARD_CLI to the path of board/cli/board.mjs.`);
	process.exit(1);
}
if (help) console.log(`${headerOf(readFileSync(self, 'utf8'))}\n\nThe board's own commands:\n`);

const child = spawn(process.execPath, [cli, ...(help ? [] : args)], { stdio: 'inherit' });
child.on('error', (e) => { console.error(`board.mjs: could not start ${cli}: ${e.message}`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
