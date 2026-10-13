// Argument parsing and --help for the scripts. Node built-ins only.
//
// A script's usage is the comment block at the top of its file; --help prints exactly that block, so the
// header and the help can never disagree.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// The leading comment block of a source text (after an optional shebang), without the slashes.
export function headerOf(source) {
	const lines = source.split('\n');
	if (lines[0].startsWith('#!')) lines.shift();
	const out = [];
	for (const l of lines) {
		if (!l.startsWith('//')) break;
		out.push(l.replace(/^\/\/ ?/, ''));
	}
	return out.join('\n');
}

// parseCli(import.meta.url, { name: { type: 'string' }, ... }, { positionals: true })
// Prints the header and exits 0 on --help; prints a one-line problem and exits 2 on a bad flag.
export function parseCli(metaUrl, options, { argv = process.argv.slice(2), positionals = true } = {}) {
	const file = fileURLToPath(metaUrl);
	const name = basename(file);
	const fail = (msg, code = 2) => {
		console.error(`${name}: ${msg}`);
		process.exit(code);
	};
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: positionals, strict: true });
	} catch (e) {
		fail(`${e.message.split('\n')[0].replace(/\. To specify.*$/, '')} (run with --help for the usage)`);
	}
	if (parsed.values.help) {
		console.log(headerOf(readFileSync(file, 'utf8')));
		process.exit(0);
	}
	return { values: parsed.values, positionals: parsed.positionals, name, fail };
}

// A whole number option: "30" -> 30. Anything else is a usage error.
export function whole(value, flag, fail, { min = 0 } = {}) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < min) fail(`--${flag} needs a whole number of at least ${min}, got "${value}"`);
	return n;
}
