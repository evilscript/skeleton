# {{PROJECT_NAME}} agent instructions

<!-- first-run-gate:begin -->
> **FIRST-RUN CHECK: do this before anything else.** If the file `skeleton.config.json` does not exist in the repository root, this
> repository has not been set up for a project yet. Stop. Do not start any other task and do not edit any file. Read
> `START_HERE.md` and follow it: it tells you which questions to ask the Owner (GitHub account, role names, local folder, project
> name and more) and what to do with the answers. Once `skeleton.config.json` exists, ignore this notice and read on.
<!-- first-run-gate:end -->

## Read first

Read `docs/CONSTITUTION.md` (roles, non-negotiables, working agreements, the board protocol, the two modes, lessons), then
`docs/ONBOARDING.md`, your role file in `docs/roles/` (`owner.md`, `lead.md`, `developer.md` or `qa.md`) and `docs/DEVELOPING.md`, before
changing code. `docs/PROJECT_KNOWLEDGE.md` is the project map and a dated hand-off; `docs/GIT_WORKFLOW.md` records the repository setup and
the daily Git workflow; `docs/TEAM.md` is the roster (who holds which role).
Check the current working tree, remote state and relevant board cards each time; a hand-off snapshot is not live state.

## The Owner's preferences

These are the defaults. The Owner's own words always win, and `docs/CONSTITUTION.md` section 3 holds the full list.

- Reply to the Owner in {{REPLY_LANGUAGE}}, short and plain, result first. Give times in {{TIMEZONE}}. Languages the Owner chose: project
  documents and card comments between members in {{DOC_LANGUAGE}}; code comments in {{CODE_LANGUAGE}}; commit messages in
  {{COMMIT_LANGUAGE}}; text the product shows to its users in {{PRODUCT_LANGUAGES}}.
- Never give the Owner a bare number: a pull request is `PR #12 - #34 - Fix login redirect` (pull request, ticket number, ticket
  title), a ticket is `#34 - Fix login redirect`. Between members on a card the short form is fine.
- Make small implementation decisions independently and say what you decided. Ask about real product decisions, giving a
  recommendation. Do not assume what the Owner meant: when the Owner's words can be read two ways and the choice matters, ask the Owner.
- Never ask the Owner, or anyone, to supply tokens, passwords or keys. Use the tools that are already signed in. If a tool needs a
  credential it does not have, say so and stop.
- GitHub commits and pushes of your own branch are routine development. Publish a version, tag a release or deploy only when the
  Owner explicitly says so.
- Preserve other members' branches, worktrees, uncommitted work and playbooks. Do not switch, clean or reset another member's checkout.

## Folders and roles

One layout on every machine, so nobody invents paths and everything the team needs travels with the repository:

- **The project folder** is the clone of `{{GITHUB_OWNER}}/{{GITHUB_REPO}}`. Nothing of the team is made beside it (no per-card clones,
  no scratch trees, no stray clones).
- **One folder per member inside the project folder, named `<Role> - <Name>`** (for example `PM - <Name>`, `Dev - <Name>`,
  `QA - <Name>`). It holds that member's checkouts (git worktrees on a machine shared with the Lead, a clone elsewhere: the main one is
  named `main`, one more per card named by the card number), its scratch files and its `.claude/settings.local.json` with `BOARD_AS`.
  Its session is started in that folder, where its settings file sets its identity (a session opened in a checkout inside it needs the same file there; the file is ignored by git). Git ignores `/PM - */`, `/Dev - */` and `/QA - */`. A new member follows the same pattern on
  whatever machine it lives: the Lead tells it the path in the first message; nobody creates other places.
- **The Lead's main checkout is the project folder itself** (merges, releases); the Lead's work trees for batches are in its own member
  folder.
- **Onboarding and instructions live in the repository** (`docs/onboarding/`, `docs/roles/`, this file, `.claude/skills/`), so they are
  pushed with everything else, not kept in a member's own folder.
- **The board is `board/` in the same repository** ({{BOARD_URL}}). `node tools/board.mjs <command>` finds its command-line tool from any
  checkout (`tools/board-path.mjs`; `BOARD_CLI` overrides).
- Tool state (listener state, logs) stays in the user's home, under `~/.boardkit/{{PROJECT_SLUG}}/`, and is not a project folder.

## Who does what

Roles, not people: the roster is `docs/TEAM.md`, and the Owner tells you your role when your session starts. If you are not sure of it,
ask. The full role definitions are `docs/CONSTITUTION.md` section 1 and `docs/roles/`.

- **The Owner**: product, project management and QA by hand. Decides what gets built and in what order, tests, and says when to release
  or deploy. Writes cards; moves the Owner's own cards and every card to done.
- **The Lead**: plans and orders the work and hands cards out (overnight a PM sub-agent does it, `.claude/skills/auto-run/SKILL.md`),
  reviews the pull requests, merges them into `{{DEFAULT_BRANCH}}`, runs the minimum scope at merge and the full suite when deploying,
  sets the card statuses from PR reviewing on, and releases or deploys on the Owner's word.
- **A Developer**: does the cards the Lead assigned with an `assign` comment, on its own branch, with one pull request per card. It moves
  the card to In progress when it starts (`started` comment) and reports by comment. It never merges, deploys, tags or releases.
- **QA**: tests the pull requests on a test machine with the project's check command (`tools/auto-run/pr-check.mjs`) and writes the
  result on the card and the pull request. It never changes code and holds a limited key.
- **The board's card comments are the only channel between agents.** Start (`assign`), review (`review`), merge (`merged`) and answers
  (`decision`) go there; so do `started`, `review` with the pull request link, branch, commit and the checks run, `question` and
  `blocked`. GitHub's pull request page carries the code and the labels only; the Lead does not answer there. Read the comments of your
  cards regularly: run the shared listener (`tools/auto-run/watch.mjs --as <identity> --role developer|lead|qa`, in the wake style your
  runtime supports; `docs/CONSTITUTION.md` section 6). CLI: `node tools/board.mjs comment <card> "..." --to <identity> --type review`,
  `thread <card>`, `inbox`.
- A card has one of ten statuses (`backlog todo progress pr_review on_main spike_ready probe_needed on_prod_qa qa_later
  done`; `docs/CONSTITUTION.md` section 4, `board/docs/STATUSES.md`). The Owner puts a card in To do when work should start; the Lead
  hands it out and the card stays in To do; the Developer moves it
  to In progress when it starts; the Lead sets PR reviewing when the pull request arrives, On Main at the merge and On Prod for QA at the
  release or deploy; the Owner moves cards to done after testing.
- **Your identity is your key.** Set `BOARD_AS` to your own board name before the first command; the command line refuses to run without
  it. Never default to another member's name, above all not the Lead's.

### Pull request routine

- One card, one pull request, branched from the current `{{DEFAULT_BRANCH}}` (`docs/GIT_WORKFLOW.md`). Start every card you are given at
  once, in the order of its priority, and do not wait for another card: nobody tells you to hold a card back unless the Owner said so.
  If two pull requests change the same lines, the one that reaches `{{DEFAULT_BRANCH}}` second merges it in and resolves the conflict.
- Before opening it, run your own checks: the command is `{{CHECK_COMMAND}}`, the minimum scope for a change is `{{MIN_SCOPE}}`.
  `docs/DEVELOPING.md` says how to pick them and how to write a check that does not break other checks. When you change something
  shared, also run every check that exercises that mechanism: the full suite found what a focused run missed. Say on the card and in the
  pull request which runs passed.
- Do not run the full suite (`{{FULL_SUITE}}`) yourself: it runs when the Lead deploys. At merge the minimum scope runs.
- Fill in the template (`.github/pull_request_template.md`). Put product questions for the Owner under "Needs the owner"; the Lead
  collects them.
- Labels: the Lead sets `Lead: changes needed`, `Lead: merged` and `Needs the owner`; QA sets `QA: pass` or `QA: fail`. A pull request
  labelled changes needed is yours again; small ones (a few lines, one file, no new setting) get a short review.
- Never bypass a hook or a failing check to make a commit or a merge go through.

## Tracking work

- Card first: every new request gets a card on the board (the board assigns the number) before work starts, with a type chip and an
  area chip. A bug in a shipped feature goes on that feature's card. Record the request and decisions on the card.
- Board cards carry who works on them as the assignee (a member's board name, or `{{OWNER_BOARD_NAME}}` for the Owner). Do not take a
  card marked for someone else. When you cannot reach the board, say so and keep a note of the cards you start in your member folder;
  do not claim the board was updated.
- The test steps of a change that a person has to test go on the card, in a comment. A script or test-run pass is not proof that it works in the real environment.
  A release does not clear pending tests; they are removed only when the Owner confirms them or waives them.

## Project constraints

The facts about the project's technology, its hard rules (what must never be done, limits that must never be crossed), its conventions
and its checks live in `docs/DEVELOPING.md`. Read it before changing code. Whatever it calls a hard rule is law for every role and every
change (`docs/CONSTITUTION.md` section 2).

## Verification and release boundaries

- Run the relevant checks during development, and the minimum scope before opening a pull request. The full suite
  (`{{FULL_SUITE}}`) must pass on the exact release tree before a release or a deploy; that is the Lead's job. Preserve the hooks; do not
  bypass a failing check. Reuse a verified baseline for documentation-only changes.
- For a bug reported from the field, follow `docs/DEVELOPING.md` ("Fixing a bug report"): card first, reproduce it with a failing check
  where feasible, fix it, then add the Owner's verification steps to the card.
- For an explicitly requested release or deploy, read the release procedure in `docs/DEVELOPING.md` and use the existing scripts and
  workflows. Never copy files into an environment the Owner runs personally unless asked to.
