// Tests for tools/setup/apply.mjs: run it on a throwaway copy of the repository.
//   node tools/lib/run-tests.mjs tools/setup
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['.git', 'node_modules', '.wrangler', '.skeleton']);

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'skeleton-apply-'));
  cpSync(REPO, dir, { recursive: true, filter: (src) => !relative(REPO, src).split('/').some((part) => SKIP.has(part) || /^(PM|Dev|QA) - /.test(part)) });
  return dir;
}
const example = () => JSON.parse(readFileSync(join(REPO, 'skeleton.config.example.json'), 'utf8'));
function apply(dir, ...args) {
  const r = spawnSync(process.execPath, [join(dir, 'tools', 'setup', 'apply.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function setup(config) {
  const dir = copyRepo();
  writeFileSync(join(dir, 'skeleton.config.json'), JSON.stringify(config, null, 2));
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('a config with problems is refused with every problem listed', () => {
  const c = example();
  c.project.slug = 'Bad Slug';
  c.roles[1].boardName = c.roles[0].boardName;
  c.roles.push({ role: 'lead', name: 'Second', boardName: 'agent-second', folder: 'PM - Second' });
  const dir = setup(c);
  try {
    const r = apply(dir, '--check');
    assert.equal(r.code, 2);
    assert.match(r.err, /project\.slug/);
    assert.match(r.err, /used twice/);
    assert.match(r.err, /exactly one member must have the role lead/);
  } finally { cleanup(dir); }
});

test('file storage and language answers are validated', () => {
  const c = example();
  c.board.fileStorage = 'dropbox';
  c.board.access = 'everyone';
  c.languages.boardPages = 'not a code';
  c.languages.code = 5;
  let dir = setup(c);
  try {
    const r = apply(dir, '--check');
    assert.equal(r.code, 2);
    assert.match(r.err, /board\.fileStorage must be one of none, d1, r2/);
    assert.match(r.err, /board\.access must be one of open, view, private/);
    assert.match(r.err, /languages\.boardPages/);
    assert.match(r.err, /languages\.code must be text/);
  } finally { cleanup(dir); }
  const d = example();
  d.board.fileStorage = 'r2';
  d.board.r2Bucket = '';
  dir = setup(d);
  try {
    const r = apply(dir, '--check');
    assert.equal(r.code, 2);
    assert.match(r.err, /needs board\.r2Bucket/);
  } finally { cleanup(dir); }
});

test('the language answers reach the documents and the board files', () => {
  const c = example();
  c.owner.replyLanguage = 'Spanish';
  c.languages = { documents: 'Portuguese', code: 'French', commits: 'German', product: 'Italian and Dutch', boardPages: 'es' };
  const dir = setup(c);
  try {
    const r = apply(dir);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /no language pack board\/public\/i18n\/es\.json yet/);
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    for (const word of ['Spanish', 'Portuguese', 'French', 'German', 'Italian and Dutch']) assert.ok(agents.includes(word), `AGENTS.md lacks ${word}`);
    for (const f of ['docs/CONSTITUTION.md', 'docs/ONBOARDING.md', 'docs/DEVELOPING.md', 'docs/GIT_WORKFLOW.md', 'docs/onboarding/onboarding-new-member-dev.md']) {
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(readFileSync(join(dir, f), 'utf8')), `${f} still has a token`);
    }
    assert.ok(!/Everything is English|are English\b/.test(readFileSync(join(dir, 'docs/GIT_WORKFLOW.md'), 'utf8') + readFileSync(join(dir, 'docs/ONBOARDING.md'), 'utf8')), 'no hardcoded English rule is left');
    assert.match(readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8'), /"BOARD_LANGUAGE": "es"/);
  } finally { cleanup(dir); }
});

test('a config without the languages block gets English defaults', () => {
  const c = example();
  delete c.languages;
  const dir = setup(c);
  try {
    assert.equal(apply(dir).code, 0);
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /project\s+documents and card comments between members in English/);
    assert.match(readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8'), /"BOARD_LANGUAGE": "en"/);
  } finally { cleanup(dir); }
});

test('a dry run writes nothing', () => {
  const dir = setup(example());
  try {
    const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const r = apply(dir, '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), before);
    assert.ok(!existsSync(join(dir, '.skeleton', 'applied.json')));
    assert.ok(!existsSync(join(dir, 'docs', 'TEAM.md')));
  } finally { cleanup(dir); }
});

test('the first run replaces tokens, generates files and refuses to run twice', () => {
  const c = example();
  c.board.d1Id = 'test-d1-id';
  c.board.cloudflareAccountId = 'test-account';
  c.board.url = 'https://board.example.com';
  c.board.fileStorage = 'r2';
  c.board.r2Bucket = 'acme-portal-board-files';
  const dir = setup(c);
  try {
    const r = apply(dir);
    assert.equal(r.code, 0, r.err + r.out);
    // no token is left in the documents
    for (const f of ['AGENTS.md', 'docs/CONSTITUTION.md', 'docs/GIT_WORKFLOW.md']) {
      const text = readFileSync(join(dir, f), 'utf8');
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), `${f} still has a token`);
    }
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /# Acme Portal agent instructions/);
    assert.ok(!readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('first-run-gate'), 'the first-run gate is gone');
    // generated files
    const team = readFileSync(join(dir, 'docs', 'TEAM.md'), 'utf8');
    for (const name of ['Atlas', 'Bolt', 'Check', 'agent-bolt', 'Jordan']) assert.ok(team.includes(name), `TEAM.md lacks ${name}`);
    const agents = readFileSync(join(dir, 'board', 'src', 'agents.ts'), 'utf8');
    assert.match(agents, /name: "agent-atlas", label: "Atlas", limited: false/);
    assert.match(agents, /name: "agent-check", label: "Check", limited: true/);
    assert.match(agents, /OWNER_ASSIGNEE = \{ name: "owner", label: "Jordan" \}/);
    assert.ok(agents.includes('export const AGENT_NAMES'), 'the derived exports survive');
    const wrangler = readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8');
    assert.match(wrangler, /"name": "acme-portal-board"/);
    assert.match(wrangler, /"database_id": "test-d1-id"/);
    assert.match(wrangler, /"account_id": "test-account"/);
    assert.match(wrangler, /"pattern": "board\.example\.com"/);
    assert.match(wrangler, /"bucket_name": "acme-portal-board-files"/);
    assert.match(wrangler, /"FILE_STORAGE": "r2"/);
    assert.ok(!/\{\{/.test(wrangler));
    // member folders, .gitignore, README
    const boltSettings = JSON.parse(readFileSync(join(dir, 'Dev - Bolt', '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(boltSettings.env.BOARD_AS, 'agent-bolt');
    assert.ok(boltSettings.permissions.allow.includes('Bash(node tools/board.mjs *)'), 'the board command line is allowed in the member folder');
    assert.ok(boltSettings.permissions.allow.includes('Bash(node tools/auto-run/watch.mjs *)'), 'the listener is allowed in the member folder');
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.match(ignore, /\/PM - Atlas\//);
    assert.match(ignore, /\/QA - Check\//);
    assert.ok(existsSync(join(dir, 'docs', 'SKELETON_README.md')));
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /^# Acme Portal/);
    // a second first run is refused, a refresh is fine
    assert.equal(apply(dir).code, 3);
    // a member folder made before the permission list existed gets the list on a refresh and keeps what it had
    const old = join(dir, 'Dev - Bolt', '.claude', 'settings.local.json');
    writeFileSync(old, JSON.stringify({ env: { BOARD_AS: 'agent-bolt', MINE: '1' } }));
    const again = apply(dir, '--refresh');
    assert.equal(again.code, 0, again.err);
    const upgraded = JSON.parse(readFileSync(old, 'utf8'));
    assert.equal(upgraded.env.MINE, '1', 'what the folder already had is kept');
    assert.ok(upgraded.permissions.allow.includes('Bash(node tools/board.mjs *)'), 'the permission list is added on a refresh');
    assert.equal(apply(dir, '--refresh').code, 0);
    assert.deepEqual(JSON.parse(readFileSync(old, 'utf8')).permissions.allow, upgraded.permissions.allow, 'a second refresh adds nothing twice');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').match(/\/PM - Atlas\//g).length, 1, 'the member block is replaced, not repeated');
  } finally { cleanup(dir); }
});

test('a workers.dev address drops the custom-domain route, a missing account id and a non-R2 storage mode drop their lines', () => {
  const c = example();
  const dir = setup(c);
  try {
    assert.equal(apply(dir, '--board-only').code, 0);
    const wrangler = readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8');
    assert.match(wrangler, /"FILE_STORAGE": "d1"/);
    // wrangler names the account's free address after the board's package, so that carries the project's name
    assert.equal(JSON.parse(readFileSync(join(dir, 'board', 'package.json'), 'utf8')).name, 'acme-portal');
    const lock = JSON.parse(readFileSync(join(dir, 'board', 'package-lock.json'), 'utf8'));
    assert.equal(lock.name, 'acme-portal');
    assert.equal(lock.packages[''].name, 'acme-portal');
    assert.ok(!wrangler.includes('"routes"'));
    assert.match(wrangler, /"workers_dev": true/);
    assert.ok(!wrangler.includes('"account_id"'));
    assert.ok(!wrangler.includes('r2_buckets'), 'd1 storage: no R2 binding');
  } finally { cleanup(dir); }
});

test('the real address is set after the first deploy: documents, config and board files follow', () => {
  const c = example();
  c.board.url = 'https://acme-portal-board.setup-pending.workers.dev';
  const dir = setup(c);
  try {
    assert.equal(apply(dir).code, 0);
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8') + readFileSync(join(dir, 'README.md'), 'utf8') + readFileSync(join(dir, 'docs', 'CONSTITUTION.md'), 'utf8'), /setup-pending/);
    const r = apply(dir, '--set-board-url', 'https://acme-portal-board.acme.workers.dev/');
    assert.equal(r.code, 0, r.err + r.out);
    for (const f of ['AGENTS.md', 'README.md', 'docs/CONSTITUTION.md', 'docs/ONBOARDING.md']) {
      const text = readFileSync(join(dir, f), 'utf8');
      assert.ok(!text.includes('setup-pending'), `${f} still has the placeholder address`);
    }
    assert.equal(JSON.parse(readFileSync(join(dir, 'skeleton.config.json'), 'utf8')).board.url, 'https://acme-portal-board.acme.workers.dev');
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /acme-portal-board\.acme\.workers\.dev/);
    assert.match(readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8'), /"workers_dev": true/);
    // a bad address is refused and changes nothing
    assert.equal(apply(dir, '--set-board-url', 'http://nope').code, 2);
    // a different name for the account's free address is one config field and a board-only run
    const cfg = JSON.parse(readFileSync(join(dir, 'skeleton.config.json'), 'utf8'));
    cfg.board.workersDevName = 'acme-portal-x7k2';
    writeFileSync(join(dir, 'skeleton.config.json'), JSON.stringify(cfg, null, 2));
    assert.equal(apply(dir, '--board-only').code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'board', 'package.json'), 'utf8')).name, 'acme-portal-x7k2');
  } finally { cleanup(dir); }
});

test('a custom domain leaves the board package name alone', () => {
  const c = example();
  c.board.url = 'https://board.example.com';
  const dir = setup(c);
  try {
    assert.equal(apply(dir, '--board-only').code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'board', 'package.json'), 'utf8')).name, 'board');
  } finally { cleanup(dir); }
});

test('an older config with only an R2 bucket name means R2 storage, and none means none', () => {
  const c = example();
  delete c.board.fileStorage;
  c.board.r2Bucket = 'legacy-files';
  let dir = setup(c);
  try {
    assert.equal(apply(dir, '--board-only').code, 0);
    const wrangler = readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8');
    assert.match(wrangler, /"FILE_STORAGE": "r2"/);
    assert.match(wrangler, /"bucket_name": "legacy-files"/);
  } finally { cleanup(dir); }
  const d = example();
  delete d.board.fileStorage;
  dir = setup(d);
  try {
    assert.equal(apply(dir, '--board-only').code, 0);
    const wrangler = readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8');
    assert.match(wrangler, /"FILE_STORAGE": "none"/);
    assert.ok(!wrangler.includes('r2_buckets'));
  } finally { cleanup(dir); }
});

test('a team without QA still produces a typed agent list', () => {
  const c = example();
  c.roles = c.roles.filter((r) => r.role !== 'qa');
  const dir = setup(c);
  try {
    assert.equal(apply(dir, '--board-only').code, 0);
    const agents = readFileSync(join(dir, 'board', 'src', 'agents.ts'), 'utf8');
    assert.ok(!agents.includes('limited: true'));
    assert.match(agents, /limited: false/);
  } finally { cleanup(dir); }
});

test('with the board switched off the board files are left alone', () => {
  const c = example();
  c.board.enabled = false;
  const dir = setup(c);
  try {
    const before = readFileSync(join(dir, 'board', 'src', 'agents.ts'), 'utf8');
    assert.equal(apply(dir).code, 0);
    assert.equal(readFileSync(join(dir, 'board', 'src', 'agents.ts'), 'utf8'), before);
    assert.ok(!existsSync(join(dir, 'board', 'wrangler.jsonc')));
  } finally { cleanup(dir); }
});

test('board access: the kit starts open, and view or private is one setting away', () => {
  for (const [value, expected] of [[undefined, 'open'], ['open', 'open'], ['view', 'view'], ['private', 'private']]) {
    const c = example();
    if (value === undefined) delete c.board.access; else c.board.access = value;
    const dir = setup(c);
    try {
      const r = apply(dir, '--board-only');
      assert.equal(r.code, 0, r.err);
      assert.match(readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8'), new RegExp(`"BOARD_ACCESS": "${expected}"`));
      // The open mode says what it means (once, in the output); the other two stay quiet.
      assert.equal(/board access is "open"/.test(r.out), expected === 'open');
    } finally { cleanup(dir); }
  }
});
