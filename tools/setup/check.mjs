#!/usr/bin/env node
// What does this machine have? Read-only facts for the first-run interview (START_HERE.md): no questions asked, nothing changed.
//
//   node tools/setup/check.mjs            readable summary
//   node tools/setup/check.mjs --json     the same as JSON (what an agent should read)
//
// It runs only version and status commands (git, node, gh auth status, npx wrangler whoami) and never prints a token.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const json = process.argv.includes('--json');
if (process.argv.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

function run(cmd, cmdArgs, opts = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 20000 }).trim();
  } catch (e) {
    return opts.keepError ? `${e.stdout || ''}${e.stderr || ''}`.trim() : null;
  }
}

const nodeVersion = process.versions.node;
const [major, minor] = nodeVersion.split('.').map(Number);
const gitVersion = run('git', ['--version']);
const ghVersion = run('gh', ['--version'])?.split('\n')[0] || null;
const ghStatus = ghVersion ? run('gh', ['auth', 'status'], { keepError: true }) : null;
const ghLogin = ghVersion ? run('gh', ['api', 'user', '--jq', '.login']) : null;
const remote = run('git', ['remote', 'get-url', 'origin']);
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = run('git', ['status', '--porcelain']);
const hasWrangler = existsSync(join(ROOT, 'board', 'node_modules', '.bin', 'wrangler'));
let wranglerAccount = null;
if (hasWrangler) wranglerAccount = run(join(ROOT, 'board', 'node_modules', '.bin', 'wrangler'), ['whoami'], { keepError: true, timeout: 40000 });

const facts = {
  folder: ROOT,
  os: platform(),
  home: homedir(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  node: { version: nodeVersion, okForTools: major >= 20, okForBoard: major > 22 || (major === 22 && minor >= 14) },
  git: { installed: !!gitVersion, user: run('git', ['config', 'user.name']), remote, branch, hasUncommittedChanges: !!dirty },
  gh: { installed: !!ghVersion, loggedIn: !!ghLogin, login: ghLogin, status: ghStatus ? ghStatus.split('\n').slice(0, 4).join(' | ') : null },
  keychain: platform() === 'darwin' ? 'macOS Keychain available' : 'no Keychain: the board scripts use key files under ~/.boardkit',
  board: { dependenciesInstalled: hasWrangler, wranglerWhoami: wranglerAccount ? wranglerAccount.split('\n').filter((l) => !/token/i.test(l)).slice(0, 6).join(' | ') : null },
  setup: {
    configExists: existsSync(join(ROOT, 'skeleton.config.json')),
    firstRunApplied: existsSync(join(ROOT, '.skeleton', 'applied.json')),
    originIsTheKit: !!remote && /\/skeleton(\.git)?$/.test(remote),
  },
};
const blockers = [];
if (!facts.git.installed) blockers.push('git is not installed');
if (!facts.node.okForTools) blockers.push('Node 20 or newer is needed for the tools');
if (!facts.gh.installed) blockers.push('the GitHub CLI (gh) is not installed: https://cli.github.com');
else if (!facts.gh.loggedIn) blockers.push('gh is not logged in: the Owner runs `gh auth login` in their own terminal');
if (facts.setup.originIsTheKit) blockers.push('the "origin" remote still points at the kit repository: replace it before any push (START_HERE.md, step 5)');
facts.blockers = blockers;
facts.notes = [];
if (!facts.node.okForBoard) facts.notes.push('Node 22.14 or newer is needed to build and deploy the board');
if (facts.git.hasUncommittedChanges) facts.notes.push('the working tree has uncommitted changes');

if (json) console.log(JSON.stringify(facts, null, 2));
else {
  console.log(`Folder:   ${facts.folder}\nSystem:   ${facts.os}, time zone ${facts.timezone}\nNode:     ${nodeVersion} (tools ${facts.node.okForTools ? 'ok' : 'too old'}, board ${facts.node.okForBoard ? 'ok' : 'needs 22.14+'})`);
  console.log(`Git:      ${gitVersion || 'missing'}${facts.git.user ? `, user ${facts.git.user}` : ''}\nGitHub:   ${facts.gh.installed ? (facts.gh.loggedIn ? `logged in as ${facts.gh.login}` : 'gh installed, not logged in') : 'gh missing'}\nRemote:   ${remote || 'none'}`);
  console.log(`Keychain: ${facts.keychain}\nSetup:    config ${facts.setup.configExists ? 'exists' : 'missing'}, first run ${facts.setup.firstRunApplied ? 'applied' : 'not applied'}`);
  if (blockers.length) console.log('\nBlockers:\n' + blockers.map((b) => '  - ' + b).join('\n'));
  if (facts.notes.length) console.log('\nNotes:\n' + facts.notes.map((b) => '  - ' + b).join('\n'));
}
