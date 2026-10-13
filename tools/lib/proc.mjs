// Small process helpers shared by the scripts. Node built-ins only.
import { spawn } from 'node:child_process';

// Runs a command with no stdin and returns { code, out, err }. It never throws: a command that cannot be
// started (not installed) comes back as code 127 with a sentence that says what to do.
export function sh(cmd, args = [], { cwd, env, timeout = 0 } = {}) {
	return new Promise((done) => {
		let out = '';
		let err = '';
		let settled = false;
		let timer = null;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			done({ code, out, err });
		};
		let child;
		try {
			child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (e) {
			err = `cannot run "${cmd}": ${e.message}`;
			return finish(127);
		}
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { err += d; });
		child.on('error', (e) => {
			err += `cannot run "${cmd}": ${e.message}. Is it installed and on your PATH?`;
			finish(127);
		});
		child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
		if (timeout) {
			timer = setTimeout(() => {
				err += `\n${cmd} did not finish within ${Math.round(timeout / 1000)} s and was stopped.`;
				child.kill('SIGKILL');
			}, timeout);
		}
	});
}

// The first non-empty line of a text, for one-line error messages.
export const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// One readable line from a failed command's stderr: the tool's own "board: ..." / "fatal: ..." / "error: ..." line
// when it printed one, a plain sentence for a network failure (the board CLI may print a stack trace for it),
// else the first line.
export function errorOf(stderr) {
	const text = String(stderr || '');
	const own = text.split('\n').map((l) => l.trim()).find((l) => /^(board|fatal|error):/.test(l));
	if (own) return own;
	if (/fetch failed/.test(text)) {
		const cause = /\[cause\]:\s*(?:\w*Error:\s*)?(.+)/.exec(text);
		return `board: cannot reach the board${cause ? ` (${cause[1].trim()})` : ''}. Check BOARD_URL and the network.`;
	}
	return firstLine(text);
}

// "45 s" or "3 min" for a number of seconds.
export const duration = (seconds) => (seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);
