// Reads skeleton.config.json, the one file that says who the team is and how the project is built.
//
//   import { loadConfig } from './lib/config.mjs';
//   const { config, root, isExample } = loadConfig(import.meta.dirname);
//
// loadConfig walks up from a folder to the first skeleton.config.json. When there is none it falls back to
// skeleton.config.example.json (isExample: true) so read-only tools still work before the first run; a tool
// that writes anywhere must refuse to run on the example. Node 20+, no dependencies.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'skeleton.config.json';
export const EXAMPLE_FILE = 'skeleton.config.example.json';
export const ROLES = ['lead', 'developer', 'qa'];

export class ConfigError extends Error {}

function findUp(startDir, file) {
	let dir = resolve(startDir);
	for (;;) {
		const found = join(dir, file);
		if (existsSync(found)) return found;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

// startDir is a folder (searched upwards) or the path of a config file (read as it is).
// With { optional: true } a missing config returns { config: null, root: null, isExample: false } instead of throwing.
export function loadConfig(startDir = process.cwd(), { optional = false } = {}) {
	const start = resolve(startDir);
	let file = null;
	let isExample = false;
	if (existsSync(start) && statSync(start).isFile()) {
		file = start;
		isExample = basename(start) === EXAMPLE_FILE;
	} else {
		file = findUp(start, CONFIG_FILE);
		if (!file) {
			file = findUp(start, EXAMPLE_FILE);
			isExample = Boolean(file);
		}
	}
	if (!file) {
		if (optional) return { config: null, root: null, isExample: false };
		throw new ConfigError(`No ${CONFIG_FILE} found above ${start}. Run the first-run protocol in START_HERE.md, or copy ${EXAMPLE_FILE} to ${CONFIG_FILE} and edit it.`);
	}
	let config;
	try {
		config = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new ConfigError(`${file} is not valid JSON (${e.message}). Fix it, or restore it from ${EXAMPLE_FILE}.`);
	}
	if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError(`${file} must hold a JSON object.`);
	return { config, root: dirname(file), isExample };
}

const roles = (config) => (config && Array.isArray(config.roles) ? config.roles : []);

// The member (an entry of config.roles) whose board identity is `name`, or null.
export const memberByBoardName = (config, name) => roles(config).find((r) => r.boardName === name) || null;

// Every member holding `role` (lead, developer or qa).
export const rolesOf = (config, role) => roles(config).filter((r) => r.role === role);

// The first Lead's board name, or '' when the config names none.
export const leadBoardName = (config) => rolesOf(config, 'lead')[0]?.boardName || '';

// The Owner's identity on the board (assignee and comment target).
export const ownerBoardName = (config) => config?.owner?.boardName || 'owner';

// "owner/repo" of the project's GitHub repository, or '' when the config does not say.
export function githubRepo(config) {
	const g = config?.github;
	return g?.owner && g?.repo ? `${g.owner}/${g.repo}` : '';
}

export const defaultBranch = (config) => config?.github?.defaultBranch || 'main';

// The prefix of a developer's branches: roles[].branchPrefix, else "<boardName>/".
export function branchPrefixOf(config, boardName) {
	const m = memberByBoardName(config, boardName);
	return m?.branchPrefix || `${boardName}/`;
}

export const checkCommand = (config) => config?.checks?.command || '';

// The Owner's time zone as an IANA name that this Node knows; UTC otherwise.
export function timezoneOf(config) {
	const tz = config?.owner?.timezone || 'UTC';
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return tz;
	} catch {
		return 'UTC';
	}
}

export const slugOf = (config) => {
	const s = String(config?.project?.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	return s || 'default';
};

// Where the listener and the scripts keep their state (what was reported, logs, briefs): ~/.boardkit/<slug>/
export const stateDir = (config, home = homedir()) => join(home, '.boardkit', slugOf(config));

// The environment variable that holds one agent's board key on a machine several agents share:
// "agent-bolt" -> BOARD_KEY_AGENT_BOLT
export const boardEnvName = (boardName) => `BOARD_KEY_${String(boardName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

// Problems that make the file unusable, as readable sentences ([] when it is fine).
export function validateConfig(config) {
	const bad = [];
	if (!config || typeof config !== 'object') return ['The config is not an object.'];
	if (!config.project?.slug) bad.push('project.slug is missing.');
	if (!config.github?.owner || !config.github?.repo) bad.push('github.owner and github.repo are missing.');
	if (!config.owner?.boardName) bad.push('owner.boardName is missing (use "owner").');
	const list = roles(config);
	if (!list.length) bad.push('roles is empty: the team needs at least a lead.');
	const names = new Set();
	for (const r of list) {
		if (!ROLES.includes(r.role)) bad.push(`roles: "${r.role}" is not one of ${ROLES.join(', ')}.`);
		if (!r.boardName) bad.push(`roles: ${r.name || r.role} has no boardName.`);
		else if (names.has(r.boardName)) bad.push(`roles: boardName "${r.boardName}" is used twice.`);
		names.add(r.boardName);
	}
	if (list.length && rolesOf(config, 'lead').length !== 1) bad.push('roles: there must be exactly one lead.');
	if (config.owner?.boardName && names.has(config.owner.boardName)) bad.push('owner.boardName is also the boardName of a role.');
	if (!config.checks?.command) bad.push('checks.command is missing: say how the project runs its tests.');
	return bad;
}
