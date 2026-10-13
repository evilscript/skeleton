# Onboarding: {{PROJECT_NAME}}

For an AI agent (or a person) joining this project. Read this first, then your role file in `docs/roles/` and `docs/DEVELOPING.md` (the
technical reference) before touching code. This file is the "how we work" part; `docs/DEVELOPING.md` is the "how the code works" part.

Project-wide instructions for every agent are in [`AGENTS.md`](../AGENTS.md), the rules in [`CONSTITUTION.md`](CONSTITUTION.md), the
dated project map in [`PROJECT_KNOWLEDGE.md`](PROJECT_KNOWLEDGE.md), the repository workflow in [`GIT_WORKFLOW.md`](GIT_WORKFLOW.md) and
the roster in [`TEAM.md`](TEAM.md).

## 1. What the project is

{{PROJECT_DESCRIPTION}}

The repository is `{{GITHUB_OWNER}}/{{GITHUB_REPO}}` (default branch `{{DEFAULT_BRANCH}}`). Its board is {{BOARD_URL}}. Details of the
product, the code and how to run it are in `docs/PROJECT_KNOWLEDGE.md` and `docs/DEVELOPING.md`.

## 2. The Owner and how to work with them

- {{OWNER_NAME}} is the Owner: the author, the product decision-maker and the main tester. The Owner decides what is built, in what order, and
  when to release.
- **Reply in {{REPLY_LANGUAGE}}**, in plain everyday words: short sentences, result first. Give times in {{TIMEZONE}}. Documents and card
  comments between members: {{DOC_LANGUAGE}}. Code comments: {{CODE_LANGUAGE}}. Commit messages: {{COMMIT_LANGUAGE}}. Text the product
  shows to its users: {{PRODUCT_LANGUAGES}}.
- **Card first.** Every new request (bug, feature, idea) first becomes a card on the board, with a type chip and an area chip, then work
  starts. Refer to cards by number and title (`#34 - Fix login redirect`); to the Owner never by a bare number.
- **Do not assume; ask on real decisions, decide small things yourself** and say what you decided. A recommendation is wanted, not a
  survey of options, and not many questions.
- **Never handle credentials or tokens.** Nobody types passwords or keys for the Owner, and nobody asks the Owner for them. If a command
  fails with an authentication error, tell the Owner and stop.

## 3. Your role

You are told your role (Lead, Developer or QA) by the Owner or the Lead in your first message, together with your name, your board name
(your identity) and the path of your member folder. **Do not infer your role from your name, your model or where you run; if you were not
told, ask.** Then read your role file: [`roles/lead.md`](roles/lead.md), [`roles/developer.md`](roles/developer.md) or
[`roles/qa.md`](roles/qa.md). The Owner's own file is [`roles/owner.md`](roles/owner.md). One onboarding document per role, with the
setup steps, is in `docs/onboarding/` (start at `docs/onboarding/README.md`).

## 4. Identity and board access

- Your identity is your board name. It is the value of the environment variable **`BOARD_AS`**: the board command line uses it to
  know who you are and refuses to run without it, so you cannot act as someone else by accident (above all not as the Lead). Check with
  `echo $BOARD_AS`; if it is empty, ask the person who started you for your board name and set it. When several members share one
  machine, each keeps `BOARD_AS` in its own folder's `.claude/settings.local.json`.
- Board commands: `node tools/board.mjs <command>` from any checkout of the repository. Useful ones: `whoami` (whose key the board sees),
  `agents` (the names the board knows), `inbox`, `list --assignee <identity>`, `show <card>`, `thread <card>`, `brief <card>` (the card
  in full: description, every comment, the screenshots), `comment <card> "..." --to <identity> --type <type>`, `move <card> <status>`.
  Long comments go in a file with `--body-file <file>`.
- Your key: on the machine where the board was set up it is already stored by the setup script (the macOS Keychain, service
  `{{KEYCHAIN_SERVICE}}` with one account per board name, or a key file in the tool state folder `~/.boardkit/{{PROJECT_SLUG}}/`), so
  there is nothing to do. On other machines it is in an environment variable that **the Owner sets in person**: `BOARD_KEY`, or `BOARD_KEY_<NAME>` (your board name in
  capitals, `-` as `_`) when several members share one machine; the specific variable is read first. A cloud session whose proxy adds the
  credential sets `BOARD_AUTH=proxy`. **You never ask for a key, write one in a file, print one or move one.** A 401 answer means the key
  is not set up: tell the Owner.
- The default board project is `{{BOARD_DEFAULT_PROJECT}}` (`BOARD_PROJECT` overrides it).
- Sign comments with your name and the time in {{TIMEZONE}}: `<Name> (HH:MM): ...`.

## 5. Your folder and your checkout

Inside the project folder you have your own folder `<Role> - <Name>`; all your checkouts and scratch files go there, and nowhere else
(`AGENTS.md`, "Folders and roles"). Do not change anything in another member's folder, and do not work in the Lead's main checkout (the
project folder itself) unless you are the Lead. Create your checkout as `docs/GIT_WORKFLOW.md` describes. Set up the project the way
`docs/DEVELOPING.md` says.

## 6. Listening

Run the shared listener the whole time you are on duty, in the wake style your runtime supports (`docs/CONSTITUTION.md` section 6):

```
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer|lead|qa
```

The first run lists what is already open for you (cards assigned to you that wait, comments addressed to you that you have not
answered). An event line is a nudge: read the card before you act. If your runtime can run none of the wake styles, run it with `--once`
at the start of every turn and tell the Owner.

## 7. Your first card

- Developer: a card in To do that is assigned to you and has the Lead's `assign` comment is yours. If there is none, wait for the Owner
  to put one in; do not start an existing card, and do not merge anyone's branch, unless the Owner or the Lead asks. Then follow
  `docs/roles/developer.md`.
- QA: wait for a `review` comment on a card, then follow `docs/roles/qa.md`.
- Lead: read `docs/roles/lead.md`, check the board and the open pull requests, then start the listener.

Setup alone is not a request to start work.

## 8. Where things are

| Path | What |
|---|---|
| `AGENTS.md` | instructions every agent loads |
| `docs/CONSTITUTION.md` | roles, non-negotiables, working agreements, board protocol, modes, lessons |
| `docs/DEVELOPING.md` | how to set up, run, test, code and release this project |
| `docs/PROJECT_KNOWLEDGE.md` | the project map and a dated hand-off |
| `docs/GIT_WORKFLOW.md` | repository setup and the daily Git workflow |
| `docs/TEAM.md` | the roster (generated) |
| `docs/roles/` | one file per role |
| `docs/onboarding/` | one onboarding document per role, and the Lead's checklist for adding a member |
| `.claude/skills/` | the playbooks: both modes and the board listener |
| `tools/auto-run/` | the listener and the Lead's and QA's scripts |
| `board/` | the board (web service, command line, rules) |
| `skeleton.config.json` | the project's configuration |
