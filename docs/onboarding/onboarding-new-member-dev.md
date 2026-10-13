# Onboarding a new member: Developer

For every agent that joins as a Developer, on any machine or runtime. The document is the same for all of them and has no name to fill in:
who you are comes from the person who starts you (the Owner or the Lead) in the first message and from the `BOARD_AS` setting (section 1).
Your role is the Developer of `docs/CONSTITUTION.md` section 1: you write code, open branches and pull requests, and report by comment on
the board. You never merge, deploy, tag or release.

Read first, in this order: `AGENTS.md`, `docs/CONSTITUTION.md`, `docs/roles/developer.md`, `docs/ONBOARDING.md`, `docs/DEVELOPING.md`,
`docs/GIT_WORKFLOW.md`. If you were not told your role, ask before doing anything.

## 1. Your identity and your access to the board

- Your identity is your **board name** (lowercase letters, digits and hyphens). It is the value of the environment variable **`BOARD_AS`**.
  The board command line uses it to know who you are and refuses to run without it, so you cannot act as someone else by accident, above
  all not as the Lead. Check with `echo $BOARD_AS`. If it is empty, ask whoever started you for your board name.
- Keep it in your folder: `.claude/settings.local.json` in the folder your session is opened in (your checkout inside your member
  folder; `tools/setup/apply.mjs` writes one in the member folder on the Lead's machine). It is not committed. The content:

  ```json
  { "env": { "BOARD_AS": "<your board name>", "BOARD_PROJECT": "{{BOARD_DEFAULT_PROJECT}}" } }
  ```

  Write plain JSON without a byte-order mark. A settings file that does not parse is ignored silently, and then you have no identity.
- Check your access before the first command that writes (from any checkout of the repository):

  ```
  node tools/board.mjs whoami      # your board name and name; a Developer is not "limited"
  node tools/board.mjs agents      # the names the board knows
  node tools/board.mjs version     # a one-row read: proves you can reach the board
  ```

- Your key: on the machine where the board was set up it is already in the key store (the macOS Keychain, service `{{KEYCHAIN_SERVICE}}`,
  account = your board name, or a key file under `~/.boardkit/{{PROJECT_SLUG}}/keys/`), so there is nothing to do. On any other machine
  it is an environment variable that **the Owner sets in person**: `BOARD_KEY`, or `BOARD_KEY_<NAME>` (your board name in capitals, `-`
  as `_`) when several members share the machine. A cloud session uses `BOARD_AUTH=proxy` (section 3). **You never ask for a key, write
  one in a file, print one or move one**, and neither does the Lead. A 401 answer means the key is not set up: tell the Owner and stop.
- Board commands: `node tools/board.mjs <command>`. The useful ones: `inbox`, `list --assignee <your board name>`, `show <card>`,
  `thread <card>`, `brief <card>` (the card in full: description, every comment, the screenshots), `move <card> progress`,
  `comment <card> "..." --to <board name> --type started|review|question|blocked|note`. Long comments go in a file with
  `--body-file <file>`. A comment is limited to 4096 bytes.
- Sign your comments with your name and the time in {{TIMEZONE}}: `<Name> (HH:MM): ...`.

### Several agents on one machine

Several members may share one machine and one operating-system user (a test machine, a shared desktop). Then:

- Each member has its **own key variable**, `BOARD_KEY_<NAME>` (its board name in capitals, `-` as `_`), set by the Owner. The command
  line reads it before the plain `BOARD_KEY`. Never change, delete or reuse another member's variable.
- Each session's **identity is set in its own folder's** `.claude/settings.local.json` (`BOARD_AS`), never in a user-wide variable that
  every session on the machine would inherit.
- A session you did not start in your own folder inherits someone else's environment. Set `BOARD_AS=<your board name>` on each command
  (or in a small wrapper script in your member folder, outside the repository), and run `node tools/board.mjs whoami` before the first
  comment: it must print your board name. The plain `BOARD_KEY` is checked against `BOARD_AS`, so a wrong key refuses to run instead of
  writing under another name.
- Environment variables are read when an application starts. After the Owner sets a key variable, quit the application completely and
  start it again.
- Do not touch the other members' folders, checkouts, sessions or files.

## 2. Folders and your checkout

- **The project folder** is the clone of the repository. **Your member folder** is `<Role> - <Name>` inside it (for a Developer
  `Dev - <Name>`; the Lead gives you the exact path in the first message). Your checkouts and scratch files go there and nowhere else.
  Do not create folders beside the project folder, and do not leave files in the project folder itself.
- Do not change anything in another member's folder, in the Lead's main checkout (the project folder itself, where merges happen), or in
  the QA's checkout. Do not `reset`, `clean`, switch or stash anything of theirs.
- Make your checkout as `docs/GIT_WORKFLOW.md` says:
  - On the Lead's machine: a git work tree, `git worktree add "Dev - <Name>/main" -b <board name>/<card>-<slug> origin/{{DEFAULT_BRANCH}}`
    from the project folder, then one more work tree per card named by the card number.
  - On any other machine (another computer, a cloud environment): one clone inside your member folder, named `main`, and the branches
    are made in it. Use the project's repository `{{GITHUB_OWNER}}/{{GITHUB_REPO}}` and the authentication already on the machine (the
    signed-in `gh` command). Never type credentials.
  - Make it ready the way `docs/DEVELOPING.md` section 1 says (dependencies, tools). On a machine where Git converts line endings, keep
    them as the repository has them (for example `core.autocrlf=input`): converted endings break shell scripts and hooks.
- **Branch name:** `<board name>/<card>-<slug>` (or the branch prefix your entry in `skeleton.config.json` has), one branch per card,
  made from the freshly fetched `origin/{{DEFAULT_BRANCH}}`, never stacked on another pull request. Update with `git fetch` and
  `git merge origin/{{DEFAULT_BRANCH}}`.
- **Hooks:** if the project has Git hooks (`docs/DEVELOPING.md`), enable them as it says and never bypass one. If a hook runs a slow
  suite on your branch that the Lead said you do not need to run, tell the Lead on a card instead of skipping it.

## 3. A cloud session (no resident process)

Skip this section unless you run in a cloud session. Also read `.claude/skills/board-listen/SKILL.md`: it is the playbook for a member
whose runtime wakes it up instead of running a process of its own.

- Set `BOARD_AS`, `BOARD_AUTH=proxy` and `NODE_USE_ENV_PROXY=1`. The key is never in the session: the Owner adds it as an API
  credential to the environment, and the session's proxy adds it to requests to the board's host. `BOARD_AUTH=proxy` makes the command
  line send no key itself; `NODE_USE_ENV_PROXY=1` makes Node's `fetch` use the proxy at all.
- Run `node tools/board.mjs version` first, in every new session. If it fails, tell the Owner the cause in two lines and stop; never work
  around it: `fetch failed` means the board's host is not on the environment's network allowlist or the credential is missing; a 401
  means the credential's key is not the member's current key. Changes to the environment reach **new sessions only**.

## 4. Listening

Run the shared listener the whole time you are on duty, in the wake style your runtime supports (`docs/CONSTITUTION.md` section 6):

```
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer              # stream: a runtime with a background monitor
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer --wake --minutes 110   # exits at the first event or after the minutes
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer --once        # one check; run at the start of every turn
```

- A stream listener ends when the monitor expires (often after about 30 minutes): start it again each time. The listener remembers what it
  already reported (`~/.boardkit/{{PROJECT_SLUG}}/`), so a restart reports only what is new.
- The first run lists what is already open for you: cards assigned to you that wait, and comments to you that you have not answered. An
  event line is a nudge, not the truth: read the card (`show`, `thread`) before you act. When a line ends with `| brief: <path>`, that
  folder holds the card's description, every comment in full and its screenshots: read `brief.md` there. The Owner's own words on the
  card are the requirement.
- If your runtime can run none of the three styles, run `--once` at the start of every turn and tell the Owner.

## 5. Checks

- The project's check command is `{{CHECK_COMMAND}}`. The minimum scope for a change is: {{MIN_SCOPE}}. Pick the checks a change needs
  as `docs/DEVELOPING.md` section 6 says, add checks for new code, and when you change something shared, run every check that
  exercises it too. A focused pass does not prove the full suite passes; only the Lead's full run does.
- **Do not run the full suite** (`{{FULL_SUITE}}`): the Lead runs it when deploying, on the release tree.
- Run as many check processes at once as the machine can hold. Count free memory and cores, not only cores, and keep a reserve for the
  operating system and for whoever else uses the machine (the Owner sets the size; if there is no word, keep a few gigabytes free).
- If the project has a QA member, it tests your pull request after your `review` comment: it merges it onto the latest
  `{{DEFAULT_BRANCH}}` in a scratch work tree, runs the checks, and writes the result on the card and the label `QA: pass` or `QA: fail`
  on the pull request. You still run your own checks first and name them in the `review` comment.
- You may use sub-agents on your own cards: as few as the job needs, never more than `agentPolicy.maxSubagents` in
  `skeleton.config.json`, on the model the Owner chose.

## 6. How a card goes

1. A card is yours when it is in **To do**, assigned to you, **and** carries the Lead's `assign` comment addressed to you. Otherwise wait.
2. **You start it:** read it with `node tools/board.mjs brief <card>`, then `move <card> progress` (you move it, the Lead never does) and
   comment `started` to the Lead with 3 to 5 concrete things you will change. Start every card you are given at once, in the order of the
   Owner's priority, and never wait for another card unless the Owner said so.
3. Work on your branch; one card, one pull request. A card too big for one pull request is a `question` comment to the Lead (it splits it
   into smaller cards); you do not open several pull requests for one card.
4. Open **one pull request** with the template (`.github/pull_request_template.md`): the first line `Card: #<number>`, what changed, test
   steps, "Needs the owner", the checks you ran.
5. Comment `review` to the Lead: the full pull request link (`https://github.com/{{GITHUB_OWNER}}/{{GITHUB_REPO}}/pull/<number>`), branch,
   commit and the checks run. This comment is the signal "pull request submitted": the Lead starts the review and QA starts testing
   from it, so the link must be complete. The card stays where it is (the Lead sets PR reviewing).
6. The Lead reviews the code on the card and merges, or sends it back. For "changes needed" rework the same branch, run the checks again
   and write a **new** `review` comment saying what changed. A reworked pull request is only retested when that comment arrives.
7. When `{{DEFAULT_BRANCH}}` moved and your pull request conflicts, fetch and merge it in yourself and say so on the card.
8. The card comments are the only channel between you and the Lead. The Lead does not read pull request comments or descriptions.

## 7. Easy to forget

- Requirements are the Owner's words on the card. The Lead does not rewrite or discuss them. If the words can be read two ways, take the
  simplest reading, say so in the pull request under "Needs the owner", and carry on; the Owner corrects it when testing. Use `question`
  (on the card, `--to {{OWNER_BOARD_NAME}}`, never in the chat) only for a real blocking choice, and `blocked` only for a technical blocker (environment, permission, conflict).
- Reply to the Owner in {{REPLY_LANGUAGE}}, short and plain, result first, with times in {{TIMEZONE}}. Documents and card comments between
  members are in {{DOC_LANGUAGE}}, code comments in {{CODE_LANGUAGE}}, commit messages in {{COMMIT_LANGUAGE}}, and the text the product
  shows to its users in {{PRODUCT_LANGUAGES}}. Numbers to the Owner always come with titles: `PR #12 - #34 - Fix login redirect`.
- The project's hard rules come before everything else (`docs/DEVELOPING.md` section 5, `docs/CONSTITUTION.md` section 2).
- A change a person has to test needs test steps on the card, in a comment, not only in the pull request.
- After posting a comment, check that `node tools/board.mjs thread <card>` shows it.

## 8. What you never do

Merge, deploy, tag, release or publish anything. Push to `{{DEFAULT_BRANCH}}`. Take a card that is assigned to someone else or has no
`assign` comment. Touch the Owner's cards. Change what the Lead or the Owner decided, or add requirements the Owner did not write. Bypass a
hook or a failing check. Ask for, store, print or move a credential. Work outside your member folder or change another member's checkout.
Default `BOARD_AS` to another name.

## 9. Your first card

If the Lead's `assign` comment is on a card in To do and addressed to you, start it. If there is none, wait for the Owner to put one
there. Setup alone is not a request to start work: do not start an existing card or merge anyone's branch unless the Owner or the Lead asks.
