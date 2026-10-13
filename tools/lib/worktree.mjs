// Scratch work trees and logged command runs for the merge and QA scripts. Node built-ins only.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// "20261013-1405" in the local time of the machine: unique enough for a scratch folder name.
export function stamp(d = new Date()) {
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// The member's own folder: the nearest parent of `repo` with that name, else <repo>/<folder> (git ignores it).
// A member without a folder gets a folder in the system's temporary directory.
export function memberDir(repo, member, slug = 'project') {
	if (!member?.folder) return join(tmpdir(), slug);
	let dir = resolve(repo);
	for (;;) {
		if (basename(dir) === member.folder) return dir;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return join(resolve(repo), member.folder);
}

// Links untracked paths (node_modules, a build cache) of the main checkout into a scratch work tree.
export function linkInto(repo, dir, paths) {
	const linked = [];
	for (const p of paths) {
		const from = join(repo, p);
		const to = join(dir, p);
		if (!existsSync(from) || existsSync(to)) continue;
		mkdirSync(dirname(to), { recursive: true });
		symlinkSync(from, to, 'junction');
		linked.push(p);
	}
	return linked;
}

function killTree(child) {
	if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
	else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

// Runs a shell command in `cwd`, writes everything it prints to `log`, keeps the last lines for the report.
// Resolves { code, tail, seconds, timedOut }; never rejects. `onTick` is called every `tickMs` while it runs.
export function runLogged(command, { cwd, log, env = process.env, timeoutMs = 0, tickMs = 300000, onTick = () => {} }) {
	mkdirSync(dirname(log), { recursive: true });
	const out = createWriteStream(log);
	const started = Date.now();
	return new Promise((done) => {
		let tail = '';
		let timedOut = false;
		const keep = (d) => { tail = (tail + d).slice(-20000); };
		const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
		child.stdout.on('data', (d) => { out.write(d); keep(d); });
		child.stderr.on('data', (d) => { out.write(d); keep(d); });
		const tick = setInterval(() => onTick(Math.round((Date.now() - started) / 60000)), tickMs);
		const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
		// The command runs in its own process group, so Ctrl-C must be passed on to it by hand.
		const interrupted = () => { killTree(child); process.exit(130); };
		process.once('SIGINT', interrupted);
		process.once('SIGTERM', interrupted);
		const end = (code, note = '') => {
			clearInterval(tick);
			if (timer) clearTimeout(timer);
			process.off('SIGINT', interrupted);
			process.off('SIGTERM', interrupted);
			if (note) { out.write(`\n${note}\n`); tail += `\n${note}\n`; }
			out.end(() => done({ code, tail, seconds: Math.round((Date.now() - started) / 1000), timedOut }));
		};
		child.on('error', (e) => end(127, `could not start the command: ${e.message}`));
		child.on('close', (code, signal) => end(code ?? (signal ? 1 : 0), timedOut ? `stopped after ${Math.round(timeoutMs / 60000)} minutes` : ''));
	});
}
