#!/usr/bin/env node
// Runs every *.test.mjs file under the given folders (default: all of tools/) with node --test.
// It exists because `node --test <folder>` means "recursive search" on Node 20 but "run this file" on newer
// Node, and a Windows shell does not expand globs; this works the same everywhere.
//
//   node tools/lib/run-tests.mjs [folder ...]
//
// Exit code: the one of node --test (0 when every test passed). Needs Node 20+.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log('usage: node tools/lib/run-tests.mjs [folder ...]\nRuns every *.test.mjs under the folders (default: tools/) with node --test.');
	process.exit(0);
}

const tools = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = process.argv.slice(2).length ? process.argv.slice(2).map((f) => resolve(f)) : [tools];

function collect(dir, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collect(path, found);
		else if (entry.name.endsWith('.test.mjs')) found.push(path);
	}
	return found;
}

let files = [];
try {
	for (const root of roots) files = files.concat(collect(root));
} catch (e) {
	console.error(`run-tests.mjs: cannot read ${e.path || 'a folder'}: ${e.message}. Give folders that exist.`);
	process.exit(1);
}
if (!files.length) {
	console.error('run-tests.mjs: no *.test.mjs files found in the folders given.');
	process.exit(1);
}
const child = spawn(process.execPath, ['--test', ...files.sort()], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
