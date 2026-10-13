// Tests for tools/lib/config.mjs: node tools/lib/run-tests.mjs tools/lib
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.mjs';
import {
	loadConfig, ConfigError, memberByBoardName, rolesOf, leadBoardName, ownerBoardName, githubRepo, defaultBranch,
	branchPrefixOf, timezoneOf, slugOf, stateDir, boardEnvName, validateConfig, CONFIG_FILE, EXAMPLE_FILE,
} from './config.mjs';

const sample = () => ({
	version: 1,
	project: { name: 'Acme Portal', slug: 'acme-portal' },
	github: { owner: 'acme-co', repo: 'acme-portal', defaultBranch: 'trunk' },
	owner: { name: 'Jordan', boardName: 'owner', timezone: 'America/New_York' },
	roles: [
		{ role: 'lead', name: 'Atlas', boardName: 'agent-atlas', folder: 'PM - Atlas' },
		{ role: 'developer', name: 'Bolt', boardName: 'agent-bolt', branchPrefix: 'bolt/' },
		{ role: 'developer', name: 'Cog', boardName: 'agent-cog' },
		{ role: 'qa', name: 'Check', boardName: 'agent-check', limited: true },
	],
	checks: { command: 'npm test' },
});

function tree() {
	const root = tempDir('cfg-');
	mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
	return root;
}

test('loadConfig finds the config in a parent folder', () => {
	const root = tree();
	writeFileSync(join(root, CONFIG_FILE), JSON.stringify(sample()));
	const r = loadConfig(join(root, 'a', 'b', 'c'));
	assert.equal(r.root, root);
	assert.equal(r.isExample, false);
	assert.equal(r.config.project.slug, 'acme-portal');
});

test('a real config wins over an example file in a nearer folder', () => {
	const root = tree();
	writeFileSync(join(root, CONFIG_FILE), JSON.stringify(sample()));
	writeFileSync(join(root, 'a', EXAMPLE_FILE), JSON.stringify({ project: { slug: 'example' } }));
	const r = loadConfig(join(root, 'a', 'b'));
	assert.equal(r.isExample, false);
	assert.equal(r.config.project.slug, 'acme-portal');
});

test('the example file is the fallback and is flagged', () => {
	const root = tree();
	writeFileSync(join(root, EXAMPLE_FILE), JSON.stringify(sample()));
	const r = loadConfig(join(root, 'a'));
	assert.equal(r.isExample, true);
	assert.equal(r.root, root);
});

test('a path to a config file is read as it is', () => {
	const root = tree();
	const file = join(root, 'a', 'mine.json');
	writeFileSync(file, JSON.stringify(sample()));
	const r = loadConfig(file);
	assert.equal(r.isExample, false);
	assert.equal(r.root, join(root, 'a'));
});

test('no config: throws a readable error, or returns null when optional', () => {
	const root = tree();
	assert.throws(() => loadConfig(root), (e) => e instanceof ConfigError && /START_HERE\.md/.test(e.message));
	assert.deepEqual(loadConfig(root, { optional: true }), { config: null, root: null, isExample: false });
});

test('invalid JSON is a ConfigError that names the file', () => {
	const root = tree();
	writeFileSync(join(root, CONFIG_FILE), '{ nope');
	assert.throws(() => loadConfig(root), (e) => e instanceof ConfigError && e.message.includes(CONFIG_FILE));
});

test('member and role helpers', () => {
	const c = sample();
	assert.equal(memberByBoardName(c, 'agent-bolt').name, 'Bolt');
	assert.equal(memberByBoardName(c, 'nobody'), null);
	assert.deepEqual(rolesOf(c, 'developer').map((r) => r.name), ['Bolt', 'Cog']);
	assert.deepEqual(rolesOf(c, 'qa').map((r) => r.boardName), ['agent-check']);
	assert.deepEqual(rolesOf({}, 'lead'), []);
	assert.equal(leadBoardName(c), 'agent-atlas');
	assert.equal(leadBoardName({}), '');
	assert.equal(ownerBoardName(c), 'owner');
	assert.equal(ownerBoardName({}), 'owner');
});

test('repository, branch and prefix helpers', () => {
	const c = sample();
	assert.equal(githubRepo(c), 'acme-co/acme-portal');
	assert.equal(githubRepo({}), '');
	assert.equal(defaultBranch(c), 'trunk');
	assert.equal(defaultBranch({}), 'main');
	assert.equal(branchPrefixOf(c, 'agent-bolt'), 'bolt/');
	assert.equal(branchPrefixOf(c, 'agent-cog'), 'agent-cog/');
});

test('timezoneOf falls back to UTC for a name Node does not know', () => {
	assert.equal(timezoneOf(sample()), 'America/New_York');
	assert.equal(timezoneOf({ owner: { timezone: 'Mars/Olympus' } }), 'UTC');
	assert.equal(timezoneOf({}), 'UTC');
});

test('stateDir is ~/.boardkit/<slug>, default without a config', () => {
	assert.equal(stateDir(sample(), '/home/x'), join('/home/x', '.boardkit', 'acme-portal'));
	assert.equal(stateDir(null, '/home/x'), join('/home/x', '.boardkit', 'default'));
	assert.equal(slugOf({ project: { slug: 'My Project!' } }), 'my-project');
});

test('boardEnvName spells BOARD_KEY_<NAME>', () => {
	assert.equal(boardEnvName('agent-bolt'), 'BOARD_KEY_AGENT_BOLT');
	assert.equal(boardEnvName('qa.one'), 'BOARD_KEY_QA_ONE');
});

test('validateConfig accepts a good config and names each problem', () => {
	assert.deepEqual(validateConfig(sample()), []);
	const c = sample();
	c.roles.push({ role: 'lead', name: 'Two', boardName: 'agent-two' });
	c.roles.push({ role: 'qa', name: 'Dup', boardName: 'agent-bolt' });
	c.checks = {};
	const bad = validateConfig(c).join('\n');
	assert.match(bad, /exactly one lead/);
	assert.match(bad, /used twice/);
	assert.match(bad, /checks\.command/);
	assert.ok(validateConfig(null).length > 0);
});
