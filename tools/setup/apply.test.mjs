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
    assert.ok(!/\{\{/.test(wrangler));
    // member folders, .gitignore, README
    assert.equal(JSON.parse(readFileSync(join(dir, 'Dev - Bolt', '.claude', 'settings.local.json'), 'utf8')).env.BOARD_AS, 'agent-bolt');
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.match(ignore, /\/PM - Atlas\//);
    assert.match(ignore, /\/QA - Check\//);
    assert.ok(existsSync(join(dir, 'docs', 'SKELETON_README.md')));
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /^# Acme Portal/);
    // a second first run is refused, a refresh is fine
    assert.equal(apply(dir).code, 3);
    const again = apply(dir, '--refresh');
    assert.equal(again.code, 0, again.err);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').match(/\/PM - Atlas\//g).length, 1, 'the member block is replaced, not repeated');
  } finally { cleanup(dir); }
});

test('a workers.dev address drops the custom-domain route, a missing account id and a missing R2 bucket drop their lines', () => {
  const c = example();
  const dir = setup(c);
  try {
    assert.equal(apply(dir, '--board-only').code, 0);
    const wrangler = readFileSync(join(dir, 'board', 'wrangler.jsonc'), 'utf8');
    assert.ok(!wrangler.includes('"routes"'));
    assert.match(wrangler, /"workers_dev": true/);
    assert.ok(!wrangler.includes('"account_id"'));
    assert.ok(!wrangler.includes('r2_buckets'), 'no bucket configured: no R2 binding');
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
