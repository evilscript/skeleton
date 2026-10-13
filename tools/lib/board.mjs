// Calling the board's command line (board/cli/board.mjs) from the scripts. Node built-ins only.
//
// The agent's own environment always wins. The config only fills BOARD_URL and BOARD_PROJECT when they are
// missing, and only when it is the project's real skeleton.config.json (the example file is never used to reach
// a board). The key is never handled here: the board CLI finds it (BOARD_KEY_<NAME>, BOARD_KEY, key store).
import { errorOf, sh } from './proc.mjs';

export function boardEnv(loaded, { as = '', base = process.env } = {}) {
	const env = { ...base };
	const cfg = loaded?.config;
	if (cfg && !loaded.isExample) {
		if (!env.BOARD_URL && cfg.board?.url) env.BOARD_URL = cfg.board.url;
		if (!env.BOARD_PROJECT && cfg.board?.defaultProject) env.BOARD_PROJECT = cfg.board.defaultProject;
	}
	if (as) env.BOARD_AS = as;
	return env;
}

// null when the board can be called, else one sentence that says what to set.
export function boardProblem(env, loaded) {
	if (loaded?.config?.board?.enabled === false) return 'The board is switched off in skeleton.config.json (board.enabled is false).';
	if (!env.BOARD_URL) return 'No board address. Set BOARD_URL, or put board.url in skeleton.config.json (the example config is not used).';
	return null;
}

// board(['thread', '34', '--json']) -> { code, out, err }
export function makeBoard({ cli, env, timeout = 60000 }) {
	return (args) => sh('node', [cli, ...args], { env, timeout });
}

// The same call, parsed: returns the JSON or throws an Error whose message is the CLI's own.
export function makeBoardJson(board) {
	return async (args) => {
		const r = await board([...args, '--json']);
		if (r.code) {
			const e = new Error(errorOf(r.err) || `board exited with code ${r.code}`);
			e.stderr = r.err;
			throw e;
		}
		try {
			return JSON.parse(r.out);
		} catch {
			throw new Error(`board ${args[0]} did not return JSON: ${r.out.trim().slice(0, 120)}`);
		}
	};
}
