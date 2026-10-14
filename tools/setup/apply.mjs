#!/usr/bin/env node
// Applies the answers of the first-run interview (skeleton.config.json) to this repository.
//
//   node tools/setup/apply.mjs [--dry-run]      first run: replace the {{TOKENS}} in the documents, write the generated files,
//                                               create the member folders, replace README.md; refuses to run twice
//   node tools/setup/apply.mjs --refresh        any time: regenerate only the generated files from the config
//                                               (docs/TEAM.md, board/src/agents.ts, board/wrangler.jsonc, member folders,
//                                               the member block of .gitignore). Safe to repeat after editing the config.
//   node tools/setup/apply.mjs --board-only     regenerate only board/wrangler.jsonc, board/src/agents.ts and the board's package name
//   node tools/setup/apply.mjs --set-board-url <https-address>   the board's real address is known after the first deploy: store it in the
//                                               config, replace the placeholder address in the documents, regenerate the board files
//   node tools/setup/apply.mjs --check          validate the config and print what is wrong; changes nothing
//   options: --config <file> (default skeleton.config.json), --force (allow a second first-run), --help
//
// Node built-ins only. It never reads or writes a credential: the config holds only public identifiers.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.jsonc', '.ts', '.sh', '.yml', '.yaml', '.html', '.css', '.txt', '.tmpl', '.webmanifest']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', '.skeleton']);
// Files that describe the kit itself or hold the token names on purpose: never rewritten.
const SKIP_FILES = new Set(['START_HERE.md', 'README.md', 'LICENSE', 'skeleton.config.json', 'skeleton.config.example.json']);
const SKIP_PREFIXES = ['tools/setup/'];
const BOARD_TOKENS = ['WORKER_NAME', 'CLOUDFLARE_ACCOUNT_ID', 'BOARD_HOST', 'D1_NAME', 'D1_ID', 'R2_BUCKET', 'FILE_STORAGE', 'BOARD_LANGUAGE'];
const FILE_STORAGE_MODES = ['none', 'd1', 'r2'];

const out = (...a) => console.log(...a);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (flag('--help') || flag('-h')) {
  out(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const configPath = resolve(ROOT, opt('--config', 'skeleton.config.json'));
if (!existsSync(configPath)) {
  console.error(`No ${relative(ROOT, configPath)} yet. Run the first-run interview in START_HERE.md first, or copy skeleton.config.example.json and edit it.`);
  process.exit(2);
}
let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) { console.error(`${configPath} is not valid JSON: ${e.message}`); process.exit(2); }

// ------------------------------------------------------------------------------------------------ validation
// Where card attachments and screenshots are kept: nowhere ("none"), in the board's own database ("d1"), or in an R2 bucket ("r2").
// Older configs only had r2Bucket: a bucket name means r2, no name means none.
const fileStorageOf = (b) => b.fileStorage || (b.r2Bucket ? 'r2' : 'none');

function validate(c) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  need(c && c.version === 1, 'version must be 1');
  const p = c.project || {};
  need(str(p.name), 'project.name is required');
  need(str(p.slug) && /^[a-z0-9][a-z0-9-]{0,29}$/.test(p.slug), 'project.slug: lowercase letters, digits and hyphens, up to 30');
  const g = c.github || {};
  need(str(g.owner) && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(g.owner), 'github.owner is required (an account or organization name)');
  need(str(g.repo) && /^[A-Za-z0-9._-]+$/.test(g.repo), 'github.repo is required');
  const o = c.owner || {};
  need(str(o.name), 'owner.name is required');
  const ownerBoard = o.boardName || 'owner';
  need(/^[a-z][a-z0-9-]*$/.test(ownerBoard), 'owner.boardName: lowercase letters, digits and hyphens, starting with a letter');
  need(Array.isArray(c.roles) && c.roles.length > 0, 'roles must list at least the lead');
  const names = new Set([ownerBoard]);
  const folders = new Set();
  let leads = 0;
  for (const [i, r] of (c.roles || []).entries()) {
    const at = `roles[${i}]`;
    need(['lead', 'developer', 'qa'].includes(r.role), `${at}.role must be lead, developer or qa`);
    if (r.role === 'lead') leads++;
    need(str(r.name), `${at}.name is required`);
    need(str(r.boardName) && /^[a-z][a-z0-9-]*$/.test(r.boardName || ''), `${at}.boardName: lowercase letters, digits and hyphens, starting with a letter`);
    need(!names.has(r.boardName), `${at}.boardName "${r.boardName}" is used twice (or equals the owner's board name)`);
    names.add(r.boardName);
    need(str(r.folder) && !/[\\/]|\.\./.test(r.folder || ''), `${at}.folder must be a plain folder name such as "PM - Name"`);
    need(!folders.has(r.folder), `${at}.folder "${r.folder}" is used twice`);
    folders.add(r.folder);
  }
  need(leads === 1, `exactly one member must have the role lead (found ${leads})`);
  const b = c.board || {};
  if (b.enabled) {
    need(str(b.url) && /^https:\/\/[^/\s]+\/?$/.test(b.url), 'board.url must be an https address such as https://board.example.com');
    for (const k of ['workerName', 'd1Name', 'keychainService']) need(str(b[k]), `board.${k} is required when the board is enabled`);
    need(b.workersDevName === undefined || (typeof b.workersDevName === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(b.workersDevName)), 'board.workersDevName must be lowercase letters, digits and hyphens');
    if (b.fileStorage !== undefined) need(FILE_STORAGE_MODES.includes(b.fileStorage), `board.fileStorage must be one of ${FILE_STORAGE_MODES.join(', ')}`);
    need(fileStorageOf(b) !== 'r2' || str(b.r2Bucket), 'board.fileStorage "r2" needs board.r2Bucket (the bucket name)');
  }
  const l = c.languages || {};
  for (const k of ['documents', 'code', 'commits', 'product']) need(l[k] === undefined || typeof l[k] === 'string', `languages.${k} must be text`);
  need(l.boardPages === undefined || (typeof l.boardPages === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(l.boardPages)), 'languages.boardPages must be a language code such as en or zh-CN');
  return errors;
}

const errors = validate(config);
if (errors.length) {
  console.error('skeleton.config.json has problems:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(2);
}
if (flag('--check')) { out('skeleton.config.json is valid.'); process.exit(0); }

// ------------------------------------------------------------------------------------------------ values
const dryRun = flag('--dry-run');
const slug = config.project.slug;
const board = config.board || {};
const ownerBoard = config.owner.boardName || 'owner';
const checks = config.checks || {};
const languages = config.languages || {};
const fileStorage = fileStorageOf(board);
const boardLanguage = languages.boardPages || 'en';
const workersDevName = board.workersDevName || slug;
const host = board.enabled ? new URL(board.url).host : '';
const tokens = {
  PROJECT_NAME: config.project.name,
  PROJECT_SLUG: slug,
  PROJECT_DESCRIPTION: config.project.description || '',
  GITHUB_OWNER: config.github.owner,
  GITHUB_REPO: config.github.repo,
  DEFAULT_BRANCH: config.github.defaultBranch || 'main',
  OWNER_NAME: config.owner.name,
  OWNER_BOARD_NAME: ownerBoard,
  TIMEZONE: config.owner.timezone || 'UTC',
  REPLY_LANGUAGE: config.owner.replyLanguage || 'English',
  DOC_LANGUAGE: languages.documents || 'English',
  CODE_LANGUAGE: languages.code || 'English',
  COMMIT_LANGUAGE: languages.commits || 'English',
  PRODUCT_LANGUAGES: languages.product || '(not decided yet: ask the Owner when a feature shows text to users)',
  BOARD_URL: board.enabled ? board.url : '(no board yet)',
  BOARD_DEFAULT_PROJECT: board.defaultProject || 'main',
  KEYCHAIN_SERVICE: board.keychainService || `${slug}-board`,
  CHECK_COMMAND: checks.command || '(not set yet)',
  MIN_SCOPE: checks.minimumScope || '(not set yet)',
  FULL_SUITE: checks.fullSuite || checks.command || '(not set yet)',
};
const boardTokens = {
  WORKER_NAME: board.workerName || '',
  CLOUDFLARE_ACCOUNT_ID: board.cloudflareAccountId || '',
  BOARD_HOST: host,
  D1_NAME: board.d1Name || '',
  D1_ID: board.d1Id || '',
  R2_BUCKET: board.r2Bucket || '',
  FILE_STORAGE: fileStorage,
  BOARD_LANGUAGE: boardLanguage,
  PROJECT_NAME: config.project.name,
};

const written = [];
function write(path, content) {
  const rel = relative(ROOT, path);
  written.push(rel);
  if (dryRun) return out(`  would write ${rel}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function render(text, map, { json = false } = {}) {
  const unknown = new Set();
  const result = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    if (!(key in map)) { unknown.add(key); return m; }
    const v = String(map[key]);
    return json ? JSON.stringify(v).slice(1, -1) : v;
  });
  return { result, unknown };
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(full); }
    else yield full;
  }
}

// ------------------------------------------------------------------------------------------------ generated files
function boardFiles() {
  if (!board.enabled) return out('  board is not enabled: board/wrangler.jsonc and board/src/agents.ts are left alone');
  // wrangler.jsonc from its template
  const tmplPath = join(ROOT, 'board', 'wrangler.jsonc.tmpl');
  if (existsSync(tmplPath)) {
    const { result, unknown } = render(readFileSync(tmplPath, 'utf8'), boardTokens, { json: true });
    if (unknown.size) throw new Error(`board/wrangler.jsonc.tmpl uses unknown tokens: ${[...unknown].join(', ')}`);
    let text = result;
    // R2 is only one of three ways to keep files (it needs a payment card even on the free plan): no R2 mode, no binding
    if (fileStorage !== 'r2') text = text.split('\n').filter((l) => !/^\s*"r2_buckets":/.test(l)).join('\n');
    // without an account id wrangler uses the account it is logged in to
    if (!board.cloudflareAccountId) text = text.split('\n').filter((l) => !/^\s*"account_id":/.test(l)).join('\n');
    if (host.endsWith('.workers.dev')) {
      // a free workers.dev address needs no custom domain route
      text = text.split('\n').filter((l) => !/^\s*"routes":/.test(l)).join('\n').replace(/"workers_dev":\s*false/, '"workers_dev": true');
    }
    write(join(ROOT, 'board', 'wrangler.jsonc'), text);
    // Wrangler registers a free workers.dev name for a new account by itself when an AI agent runs the first deploy, and it takes the
    // name from the package name of the folder it runs in: so that package is named after the project, not "board".
    if (host.endsWith('.workers.dev')) setPackageName(workersDevName);
    if (fileStorage === 'none') out('  note: file storage is "none": card attachments and screenshots are switched off.');
    if (fileStorage === 'd1') out('  note: file storage is "d1": files are kept in the board database (small images only; no extra service).');
    if (!existsSync(join(ROOT, 'board', 'public', 'i18n', `${boardLanguage}.json`))) out(`  note: no language pack board/public/i18n/${boardLanguage}.json yet: copy en.json to it and translate the values (the pages fall back to English until then).`);
    if (!board.d1Id) out('  note: board.d1Id is empty. Create the database (npx wrangler d1 create <name>), put its id in the config and run this again with --board-only.');
  } else out('  (no board/wrangler.jsonc.tmpl here: skipped)');
  // agents.ts between its markers
  const agentsPath = join(ROOT, 'board', 'src', 'agents.ts');
  if (existsSync(agentsPath)) {
    const text = readFileSync(agentsPath, 'utf8');
    const begin = text.indexOf('// <agents:begin>');
    const end = text.indexOf('// <agents:end>');
    if (begin < 0 || end < 0 || end < begin) throw new Error('board/src/agents.ts has no // <agents:begin> ... // <agents:end> markers');
    const beginLineEnd = text.indexOf('\n', begin) + 1;
    const list = config.roles.map((r) => `  { name: ${JSON.stringify(r.boardName)}, label: ${JSON.stringify(r.name)}, limited: ${r.limited || r.role === 'qa' ? 'true' : 'false'} },`).join('\n');
    const body = `export const AGENT_LIST = [\n${list}\n] as const;\nexport const OWNER_ASSIGNEE = { name: ${JSON.stringify(ownerBoard)}, label: ${JSON.stringify(config.owner.name)} } as const;\n`;
    write(agentsPath, text.slice(0, beginLineEnd) + body + text.slice(end));
  }
}

// Renames the board's npm package in package.json and package-lock.json (line edits: the files keep their formatting).
function setPackageName(name) {
  for (const [file, times] of [['package.json', 1], ['package-lock.json', 2]]) {
    const path = join(ROOT, 'board', file);
    if (!existsSync(path)) continue;
    let n = 0;
    const text = readFileSync(path, 'utf8').replace(/^(\s*)"name": "[^"]*"/gm, (m, ws) => (++n <= times ? `${ws}"name": ${JSON.stringify(name)}` : m));
    write(path, text);
  }
}

function teamFile() {
  const roleName = { lead: 'Lead', developer: 'Developer', qa: 'QA' };
  const rows = config.roles.map((r) => `| ${roleName[r.role]} | ${r.name} | \`${r.boardName}\` | ${r.runtime || ''} | \`${r.folder}\` | ${r.branchPrefix ? '`' + r.branchPrefix + '`' : ''} |`);
  const text = `# Team

Generated by \`node tools/setup/apply.mjs --refresh\` from \`skeleton.config.json\`. Change the team in the config and refresh; do not edit this file by hand.

The **name** is what people call a member; the **board identity** is what the board, the scripts, branches and comments use (it never changes once cards exist). A role can be handed to another member by the Owner at any time (see \`docs/CONSTITUTION.md\`, section 0).

| Role | Name | Board identity | Runtime | Folder | Branch prefix |
|---|---|---|---|---|---|
| Owner | ${config.owner.name} | \`${ownerBoard}\` | the human | | |
${rows.join('\n')}

Each folder sits inside the project folder, is ignored by git, and holds that member's checkouts, scratch files and \`.claude/settings.local.json\` (the member's \`BOARD_AS\`).
`;
  write(join(ROOT, 'docs', 'TEAM.md'), text);
}

// The permissions the team's own channel needs (the board command line, the listener and the Lead's helpers), kept in the repository's
// .claude/settings.json. A session started inside a member folder reads that folder's settings, so each member folder gets the same list.
function teamPermissions() {
  try { return JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8')).permissions?.allow || []; } catch { return []; }
}

function memberFolders() {
  const allow = teamPermissions();
  for (const r of config.roles) {
    const dir = join(ROOT, r.folder);
    const settings = join(dir, '.claude', 'settings.local.json');
    let current = null;
    if (existsSync(settings)) {
      try { current = JSON.parse(readFileSync(settings, 'utf8')); } catch { out(`  keep ${r.folder}/.claude/settings.local.json (not valid JSON: left alone)`); continue; }
    }
    const have = Array.isArray(current?.permissions?.allow) ? current.permissions.allow : [];
    const missing = allow.filter((rule) => !have.includes(rule));
    if (current && !missing.length) { out(`  keep ${r.folder}/.claude/settings.local.json`); continue; }
    const next = current || { env: { BOARD_AS: r.boardName, BOARD_PROJECT: board.defaultProject || 'main' } };
    if (missing.length) next.permissions = { ...(next.permissions || {}), allow: [...have, ...missing] };
    write(settings, JSON.stringify(next, null, 2) + '\n');
  }
}

function gitignore() {
  const path = join(ROOT, '.gitignore');
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const block = ['# <skeleton:members> (generated by tools/setup/apply.mjs)', ...config.roles.map((r) => `/${r.folder}/`), 'skeleton.local.json', '# </skeleton:members>'].join('\n');
  const re = /# <skeleton:members>[\s\S]*?# <\/skeleton:members>/;
  write(path, re.test(old) ? old.replace(re, block) : old.replace(/\n*$/, '\n') + '\n' + block + '\n');
}

// ------------------------------------------------------------------------------------------------ run
const refresh = flag('--refresh');
const boardOnly = flag('--board-only');
const marker = join(ROOT, '.skeleton', 'applied.json');

const setBoardUrl = opt('--set-board-url', '');

if (setBoardUrl) {
  if (!/^https:\/\/[^/\s]+\/?$/.test(setBoardUrl)) { console.error('--set-board-url needs an https address such as https://acme-board.acme.workers.dev'); process.exit(2); }
  const next = setBoardUrl.replace(/\/$/, '');
  const old = (board.url || '').replace(/\/$/, '');
  if (!board.enabled) { console.error('The board is not enabled in the config.'); process.exit(2); }
  out(`Setting the board address to ${next}:`);
  if (old && old !== next) {
    let replaced = 0;
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const name = rel.split('/').pop();
      const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
      if (!TEXT_EXT.has(ext) || rel === 'skeleton.config.json' || rel === 'skeleton.config.example.json') continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes(old)) continue;
      replaced++;
      write(file, text.split(old).join(next));
    }
    out(`  address replaced in ${replaced} file(s)`);
  }
  config.board.url = next;
  write(configPath, JSON.stringify(config, null, 2) + '\n');
  if (!dryRun) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--board-only', '--config', configPath], { stdio: 'inherit' });
    if (r.status) process.exit(r.status);
  }
} else if (boardOnly) {
  out('Regenerating the board files:');
  boardFiles();
} else if (refresh) {
  out('Refreshing the generated files:');
  boardFiles(); teamFile(); memberFolders(); gitignore();
} else {
  if (existsSync(marker) && !flag('--force')) {
    console.error(`The first run was already applied (${relative(ROOT, marker)}). Use --refresh to regenerate the generated files, or --force to run the first-run replacement again.`);
    process.exit(3);
  }
  out(dryRun ? 'First run (dry run: nothing is written):' : 'First run:');
  // 1. tokens in the documents and scripts
  const unknownByFile = [];
  let replaced = 0;
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const name = rel.split('/').pop();
    const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
    if (!TEXT_EXT.has(ext) || SKIP_FILES.has(rel) || SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (rel === 'board/wrangler.jsonc.tmpl') continue; // rendered by boardFiles() with its own tokens
    const text = readFileSync(file, 'utf8');
    if (!text.includes('{{')) continue;
    const { result, unknown } = render(text, tokens, { json: ext === '.json' || ext === '.jsonc' });
    const real = [...unknown].filter((k) => !BOARD_TOKENS.includes(k));
    if (real.length) unknownByFile.push(`${rel}: ${real.join(', ')}`);
    if (result !== text) { replaced++; write(file, result); }
  }
  if (unknownByFile.length) console.error('Warning: tokens with no value were left as they are:\n' + unknownByFile.map((l) => '  - ' + l).join('\n'));
  out(`  tokens replaced in ${replaced} file(s)`);
  // 2. the first-run gate in AGENTS.md goes away
  const agents = join(ROOT, 'AGENTS.md');
  if (existsSync(agents)) {
    const text = readFileSync(agents, 'utf8');
    const stripped = text.replace(/<!-- first-run-gate:begin -->[\s\S]*?<!-- first-run-gate:end -->\n*/, '');
    if (stripped !== text) write(agents, stripped);
  }
  // 3. generated files, member folders, .gitignore
  boardFiles(); teamFile(); memberFolders(); gitignore();
  // 4. README: the kit's own README moves under docs/, the project gets its own
  const readme = join(ROOT, 'README.md');
  if (existsSync(readme) && readFileSync(readme, 'utf8').includes('<!-- skeleton-readme -->')) {
    if (!dryRun) renameSync(readme, join(ROOT, 'docs', 'SKELETON_README.md'));
    out('  README.md -> docs/SKELETON_README.md');
    write(readme, `# ${config.project.name}

${config.project.description || ''}

This project is run by one human Owner (${config.owner.name}) and a small team of AI agents, using the delivery kit in this repository: a board, a constitution, role definitions and listener scripts.

- Start with \`AGENTS.md\`, then \`docs/CONSTITUTION.md\`.
- The team: \`docs/TEAM.md\`. The board: ${board.enabled ? board.url : 'not set up yet'}.
- About the kit itself: \`docs/SKELETON_README.md\`.
`);
  }
  // 5. local, machine-specific facts (git-ignored)
  write(join(ROOT, 'skeleton.local.json'), JSON.stringify({ projectRoot: ROOT, appliedAt: new Date().toISOString() }, null, 2) + '\n');
  // 6. the marker
  const hash = createHash('sha256').update(readFileSync(configPath)).digest('hex').slice(0, 16);
  write(marker, JSON.stringify({ version: 1, appliedAt: new Date().toISOString(), configSha256: hash }, null, 2) + '\n');
}

out(dryRun ? `Dry run: ${written.length} file(s) would change.` : `Done: ${written.length} file(s) written.`);
if (!dryRun && !refresh && !boardOnly && !setBoardUrl) out('Next: fill the TODO(first-run) places (grep -rn "TODO(first-run)" docs AGENTS.md), then commit and push (START_HERE.md, steps 5 to 8).');
