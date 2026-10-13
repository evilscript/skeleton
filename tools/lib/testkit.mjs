// Test support for the script tests: a throw-away project on disk with a bare "origin", a checkout that holds a
// copy of tools/, a stand-in `gh` and a stand-in board CLI. Nothing here touches a network, a real board or a
// real GitHub; every call the scripts make is answered from files and recorded in a log.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.mjs';

const tools = join(dirname(fileURLToPath(import.meta.url)), '..');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH + '.log', JSON.stringify(a) + '\\n');
const opt = (name) => { const i = a.indexOf(name); return i < 0 ? '' : a[i + 1]; };
if (a[0] === 'pr' && a[1] === 'view') {
  const pr = state.prs[a[2]];
  if (!pr) { console.error('no pull request found for ' + a[2]); process.exit(1); }
  console.log(JSON.stringify(pr));
} else if (a[0] === 'pr' && a[1] === 'list') {
  console.log(JSON.stringify(opt('--state') === 'merged' ? [] : Object.values(state.prs).filter((p) => p.state === 'OPEN')));
} else if (a[0] === 'label' || (a[0] === 'pr' && a[1] === 'edit')) {
  process.exit(0);
} else { console.error('fake gh: unexpected ' + a.join(' ')); process.exit(1); }
`;

const FAKE_BOARD = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_BOARD;
const state = JSON.parse(readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
const opt = (name) => { const i = a.indexOf(name); return i < 0 ? '' : a[i + 1]; };
const log = { args: a };
if (opt('--body-file')) log.body = readFileSync(opt('--body-file'), 'utf8');
appendFileSync(file + '.log', JSON.stringify(log) + '\\n');
const [cmd, no] = a;
const save = () => writeFileSync(file, JSON.stringify(state));
if (cmd === 'show') console.log(JSON.stringify({ card: state.cards[no], files: [] }));
else if (cmd === 'thread') {
  const list = state.comments.filter((m) => String(m.cardNo) === no);
  console.log(a.includes('--json') ? JSON.stringify(list) : list.map((m) => '[' + m.id + '] ' + m.author + ' (' + m.type + ') ' + m.body).join('\\n'));
} else if (cmd === 'set') { state.cards[no].assignee = opt('--assignee'); save(); console.log('#' + no + ' updated'); }
else if (cmd === 'move') { state.cards[no].status = a[2]; save(); console.log('#' + no + ' -> ' + a[2]); }
else if (cmd === 'comment') {
  const body = opt('--body-file') ? log.body : a.slice(2).filter((x, i, all) => !x.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--'))).join(' ');
  const id = state.comments.length + 1;
  state.comments.push({ id, cardNo: Number(no), author: process.env.BOARD_AS, to: opt('--to') || null, type: opt('--type') || 'note', body, createdAt: new Date().toISOString() });
  save();
  console.log('#' + no + ' comment [' + id + ']');
} else if (cmd === 'version') console.log(JSON.stringify({ v: 'v' + state.comments.length, c: state.comments.length }));
else if (cmd === 'list') console.log(JSON.stringify(Object.values(state.cards)));
else if (cmd === 'feed') console.log(JSON.stringify(state.comments));
else if (cmd === 'agents') console.log('agent-atlas\\tAtlas\\nagent-bolt\\tBolt\\nagent-check\\tCheck\\nowner\\tJordan (the owner: assignee only)');
else { console.error('board: unknown command ' + cmd); process.exit(1); }
`;

export const supported = process.platform !== 'win32'; // the stand-in gh is a script with a shebang

export function sandbox({ checkCommand = 'node -e "process.exit(0)"' } = {}) {
	const box = tempDir('skel-');
	const p = (...x) => join(box, ...x);
	const env = {
		...process.env,
		HOME: p('home'), USERPROFILE: p('home'), PATH: `${p('bin')}${delimiter}${process.env.PATH}`,
		BOARD_URL: 'https://board.invalid', FAKE_GH: p('gh.json'), FAKE_BOARD: p('board.json'),
		GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost',
		GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: p('gitconfig'),
	};
	delete env.BOARD_KEY; delete env.BOARD_CLI;
	mkdirSync(p('home'), { recursive: true });
	mkdirSync(p('bin'), { recursive: true });
	writeFileSync(p('gitconfig'), '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
	writeFileSync(p('bin', 'gh'), FAKE_GH);
	chmodSync(p('bin', 'gh'), 0o755);
	writeFileSync(p('fake-board.mjs'), FAKE_BOARD);
	writeFileSync(p('gh.json'), JSON.stringify({ prs: {} }));
	writeFileSync(p('board.json'), JSON.stringify({ cards: {}, comments: [] }));

	const git = (args, cwd = p('work')) => {
		const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
		return r.stdout.trim();
	};
	git(['init', '-q', '--bare', p('origin.git')], box);
	git(['clone', '-q', p('origin.git'), p('work')], box);
	cpSync(tools, p('work', 'tools'), { recursive: true });
	writeFileSync(p('work', '.gitignore'), '/PM - */\n/QA - */\nnode_modules\n');
	const config = {
		version: 1,
		project: { name: 'Acme', slug: 'acme' },
		github: { owner: 'acme-co', repo: 'acme', defaultBranch: 'main' },
		owner: { name: 'Jordan', boardName: 'owner', timezone: 'UTC' },
		roles: [
			{ role: 'lead', name: 'Atlas', boardName: 'agent-atlas', folder: 'PM - Atlas' },
			{ role: 'developer', name: 'Bolt', boardName: 'agent-bolt', folder: 'Dev - Bolt', branchPrefix: 'agent-bolt/' },
			{ role: 'qa', name: 'Check', boardName: 'agent-check', folder: 'QA - Check', limited: true },
		],
		board: { enabled: true, url: 'https://board.invalid', defaultProject: 'main' },
		checks: { command: checkCommand, minimumScope: 'the tests of the files you touch', fullSuite: checkCommand },
		agentPolicy: { maxSubagents: 2 },
	};
	writeFileSync(p('work', 'skeleton.config.json'), JSON.stringify(config));
	writeFileSync(p('work', 'app.txt'), 'line one\nline two\n');
	git(['add', '-A']);
	git(['commit', '-q', '-m', 'Initial']);
	git(['push', '-q', 'origin', 'main']);
	git(['clone', '-q', p('origin.git'), p('dev')], box);

	const readLog = (file) => (existsSync(`${file}.log`) ? readFileSync(`${file}.log`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
	const api = {
		box, env, config, git,
		work: p('work'), origin: p('origin.git'),
		ghLog: () => readLog(p('gh.json')),
		boardLog: () => readLog(p('board.json')),
		boardState: () => JSON.parse(readFileSync(p('board.json'), 'utf8')),
		originLog: (ref = 'main') => git(['log', '--format=%s', ref], p('origin.git')).split('\n'),
		// A script of the checkout, run with the stand-in gh first on PATH.
		run(script, args, { as, extraEnv = {}, withCli = true } = {}) {
			const full = [p('work', 'tools', 'auto-run', script), ...args, ...(withCli ? ['--cli', p('fake-board.mjs')] : [])];
			const r = spawnSync(process.execPath, full, { cwd: p('work'), env: { ...env, ...(as ? { BOARD_AS: as } : {}), ...extraEnv }, encoding: 'utf8' });
			return { code: r.status, out: r.stdout, err: r.stderr };
		},
		setBoard(patch) {
			writeFileSync(p('board.json'), JSON.stringify({ ...api.boardState(), ...patch }));
		},
		// A card on the board and a pull request for it: a branch with one commit, pushed, with the refs GitHub would have.
		addPr(number, { card = number + 20, title = 'Fix login redirect', files = { [`feature-${number}.txt`]: 'new\n' }, labels = [], draft = false, body } = {}) {
			const branch = `agent-bolt/${card}-fix`;
			git(['checkout', '-q', '-B', branch, 'origin/main'], p('dev'));
			for (const [name, text] of Object.entries(files)) writeFileSync(p('dev', name), text);
			git(['add', '-A'], p('dev'));
			git(['commit', '-q', '-m', `Work on card ${card}`], p('dev'));
			git(['push', '-q', 'origin', branch], p('dev'));
			const sha = git(['rev-parse', 'HEAD'], p('dev'));
			git(['push', '-q', 'origin', `${sha}:refs/pull/${number}/head`], p('dev'));
			git(['checkout', '-q', 'main'], p('dev'));
			const gh = JSON.parse(readFileSync(p('gh.json'), 'utf8'));
			gh.prs[number] = { number, title, body: body ?? `Card: #${card}\n\n## Summary\nDone.\n`, headRefName: branch, headRefOid: sha, baseRefName: 'main', state: 'OPEN', isDraft: draft, labels: labels.map((name) => ({ name })), author: { login: 'bolt-bot' } };
			writeFileSync(p('gh.json'), JSON.stringify(gh));
			const board = api.boardState();
			board.cards[card] = { no: card, title, status: 'pr_review', assignee: 'agent-bolt', priority: 'major', updatedAt: new Date().toISOString(), updatedBy: 'agent-bolt', chips: [] };
			writeFileSync(p('board.json'), JSON.stringify(board));
			return { branch, sha, card };
		},
		// A comment on a card, dated `minutes` from now (positive: after the commits just made).
		addComment({ cardNo, author, type = 'note', to = null, body = 'text', minutes = 5 }) {
			const board = api.boardState();
			board.comments.push({ id: board.comments.length + 1, cardNo, author, to, type, body, createdAt: new Date(Date.now() + minutes * 60000).toISOString() });
			writeFileSync(p('board.json'), JSON.stringify(board));
		},
		// A commit on main of origin, made after the branches were cut (to make a conflict or move origin).
		pushToMain(files, message = 'Change main') {
			git(['checkout', '-q', 'main'], p('dev'));
			git(['pull', '-q', 'origin', 'main'], p('dev'));
			for (const [name, text] of Object.entries(files)) writeFileSync(p('dev', name), text);
			git(['add', '-A'], p('dev'));
			git(['commit', '-q', '-m', message], p('dev'));
			git(['push', '-q', 'origin', 'main'], p('dev'));
		},
	};
	return api;
}
