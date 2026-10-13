---
name: board-listen
description: The listening playbook for a team member whose session has no resident process of its own (a cloud session, or any tool that is woken by a background command exiting, by a monitor line, or by a timer). When the Owner switches listening on (default words "listening mode" or "start listening"), watch the board with the shared listener, handle each event line (a card handed to you, a reply, a question), move your card to In progress, comment started, build it on your own branch, open one pull request, comment review on the card, and never merge. Stop when the Owner says stop. With listening off, follow the Owner's direct instructions with the same card-first flow.
---

# Board listening for a Developer (and the QA) without a resident process

A Developer is a member that turns cards into pull requests: one card, one branch, one pull request, reported by comment on the board;
the Lead reviews and merges (`docs/roles/developer.md`). This skill is how such a member **hears** the board when its session is not
always running: a cloud container, or any tool that wakes the agent only when something happens. The QA member listens the same way
(section "If you are QA"). The Lead listens through `.claude/skills/auto-run/SKILL.md`.

Background that binds you: `docs/CONSTITUTION.md` (sections 4 to 6), `AGENTS.md`, `docs/DEVELOPING.md`, and your onboarding document
(`docs/onboarding/onboarding-new-member-dev.md`). Reply to the Owner in {{REPLY_LANGUAGE}}, short and plain, times in {{TIMEZONE}}.
Sign comments `<Name> (HH:MM): ...`.

## Two modes

- **Listening on** (the Owner says the word to start listening): start at once, ask nothing (section "Start"). A card is yours to start
  when it is assigned to you **and** carries an `assign` comment addressed to you from the Lead (or from the Owner).
- **Listening off** (the default, or after the Owner says stop): do what the Owner asks in the chat, still card first. A request without a
  card gets one (`node tools/board.mjs new "title" ...`; the number comes from the board, never pick one), you tell the Lead in a `note`,
  then `started`, the work, one pull request, `review`. Never merge.

## The board from a cloud session

```bash
export BOARD_AS=<your board name> BOARD_AUTH=proxy NODE_USE_ENV_PROXY=1
node tools/board.mjs version      # access check: "cards ... comments N"
```

The key is never in the session. The Owner adds it as an API credential of the environment for the board's host (header
`Authorization`, prefix `Bearer`), and the session's proxy adds it on the way out. `BOARD_AUTH=proxy` makes the command line send no key
of its own, and `NODE_USE_ENV_PROXY=1` makes Node's `fetch` use the proxy at all. Environment changes reach **new sessions only**.

If `version` fails, say so to the Owner in two lines and stop; never work around it (L11):

- `fetch failed`, or the proxy refuses the connection to the board's host: the environment has no credential for it (or this session is
  older than the credential). The fix is in the environment's settings, then a new session.
- `401 unauthorized`: the credential's key is not your current key (for example the Owner created a new key and the credential still
  has the old one).

Other runtimes with a Keychain or an environment variable: `docs/onboarding/onboarding-new-member-dev.md` section 1. Several members on one
machine each have their own `BOARD_KEY_<NAME>` and their own `BOARD_AS`; check `node tools/board.mjs whoami` before the first comment.

## Start

1. `git status` clean, `git fetch`; nothing of yours half-done (a branch with uncommitted work: finish it first). `board version` works.
2. **Catch up:** `node tools/board.mjs list --assignee "$BOARD_AS" --status todo`, then `--col progress`, and `thread <card>` for each. Act on
   anything that waits for you (section "When a card is yours"); answer pending replies. `node tools/board.mjs inbox --peek` shows the
   comments to you that you have not seen, without moving the cursor.
3. **Arm the listener** in the first wake style your runtime supports (`docs/CONSTITUTION.md` section 6):
   - **Stream** (a background monitor whose output lines wake you): `node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer`.
     Monitors usually expire after about 30 minutes: re-arm it on every expiry, quietly.
   - **Wake** (a background command whose exit wakes you):
     `node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer --wake --minutes 110 --board 120` as a background command with a
     time-out longer than the minutes. It asks the board one cheap row every 120 seconds and **exits** as soon as something is for you,
     printing it; with nothing new it exits after 110 minutes. Either way you are woken: handle what it printed, then start it again.
     Exit status 1 means the board was unreachable three times in a row.
   - **Once** (a runtime that can only run a command now and then): `node tools/auto-run/watch.mjs --as "$BOARD_AS" --role developer --once`
     at the start of every turn and between steps; it prints what is new since the last call.
   - In every style it remembers what it already reported, in `~/.boardkit/{{PROJECT_SLUG}}/`, so a restart repeats nothing. A fresh
     container has no state: catch up with step 2. Never `tail -f` a log, and never start it in a `( ... ) &` subshell.
   - **Safety net:** if your runtime has timers, schedule a check-in about every two hours with the message "check the listener is
     running (re-arm it if not), then re-arm this check-in; one line to the Owner only if something changed", so a reclaimed container
     still comes back. Keep its id and re-arm it at each check-in.
4. Tell the Owner in at most five lines: listening, what you picked up while catching up, the word to stop.

## What each event line means

Every line starts with a tag. An event line is a nudge, not the truth: read the card (`show`, `thread`) and decide by its state, not by
the line alone (a restarted listener may show old comments again). A line ending with `| brief: <path>` names the folder with the card's
description, every comment in full and its screenshots: read `brief.md` there before anything else.

| Line | What it is | What you do |
|---|---|---|
| `[card] ...` | a card was assigned to you, moved, or re-prioritized by somebody else | read the card; if it is now yours to start, see below; if the Owner or the Lead moved it or changed its priority, adjust and say so on the card if it matters |
| `[comment] ... -> you assign` | the Lead handed you a card | start it (below) |
| `[comment] ... -> you review` | the Lead's "Lead review": ready to merge, or changes needed | for changes needed, rework the same branch and write a new `review` comment saying what changed |
| `[comment] ... -> you decision` or `question` | an answer, or a question | act on it; answer a question with a comment to the sender |
| a comment from the Owner on your card | the Owner's newest words are the requirement | do what they say; if they contradict the `assign`, the Owner's words win |
| `(waiting)` or `(unanswered)` | your first run's list of what is already open for you | handle each like a fresh line |
| `[watch] ... unreachable` | the board cannot be reached | run `node tools/board.mjs version`; if it stays down, tell the Owner the error text |

## When a card is yours

By the card's state, not by the comment alone:

- **Start.** It is assigned to you, in To do, has an `assign` comment to you, and you have no `started` after it:
  1. `node tools/board.mjs show <card>`, `thread <card>` and `brief <card>`: the description, the screenshots and the Lead's hint. The
     repository is `{{GITHUB_OWNER}}/{{GITHUB_REPO}}` (this checkout).
  2. `node tools/board.mjs move <card> progress`, then
     `node tools/board.mjs comment <card> "<Name> (HH:MM): ..." --to <the Lead's board name> --type started`
     with the 3 to 5 concrete things you will change. On a vague card those are your reading of it; go ahead without waiting. Long text
     goes in a file with `--body-file`.
  3. A branch `<your board name>/<card>-<short-lowercase-ascii-name>` from the latest `origin/{{DEFAULT_BRANCH}}`. Work by `AGENTS.md` and
     `docs/DEVELOPING.md`. Run your own checks (minimum scope: {{MIN_SCOPE}}; command `{{CHECK_COMMAND}}`) and every check a shared
     mechanism you touched can reach. Do not run the full suite.
  4. Push the branch and open **one pull request** with the template (`.github/pull_request_template.md`). **Never merge it, never
     deploy.**
  5. `node tools/board.mjs comment <card> "<Name> (HH:MM): PR <link>, branch ..., commit ..., ran ..." --to <the Lead's board name> --type review`.
     Use the full link: the Lead and QA start from this comment. The card stays in In progress; the Lead sets PR reviewing, merges, and
     comments `merged`. After a "changes needed", write a new `review` comment.
- **Reply.** A `review`, `decision` or `question` to you on a card you are working: rework the same branch (or answer), then `review`
  again saying what changed.
- **Not yours.** Assigned to someone else, or no `assign` comment: ignore it (a question to you on it gets an answer, nothing more). Do not
  start a card nobody started, and never take a card of the Owner's.
- **Questions you cannot decide:** `comment <card> "..." --to <the Lead's board name> --type question`, a product question
  `--to {{OWNER_BOARD_NAME}}`, and carry on with what does not depend on the answer. Use `blocked` only when nothing can go on.
- After posting any comment, check that `board thread <card>` shows it (L1).

After a round, `node tools/board.mjs inbox` (without `--peek`) moves the cursor past what you handled. Then start the listener again.

## If you are QA

Use the same arming steps with `--role qa`. The lines you act on are `[review]` (a Developer submitted a pull request: run
`node tools/auto-run/pr-check.mjs <number>`) and comments addressed to you. Everything else is in `docs/roles/qa.md` and
`docs/onboarding/onboarding-new-member-qa.md`. Your key is limited: only `note`, `question` and `blocked`.

## Stop

When the Owner says stop: finish or park the current step (push what you have, say on the card where it stands), stop the listener (the
runtime's task stop, or kill its process), cancel the check-in timer, and report in a few lines: cards started, pull requests opened,
what waits on whom.

## Never

- Merge a pull request, push to `{{DEFAULT_BRANCH}}`, deploy, tag or release. When an instruction about merging reads two ways ("open a pull
  request, do not merge directly"), take the reading that leaves the merge to the Lead, or ask (L10).
- Take a card assigned to someone else, or start a card nobody started.
- Talk to other members anywhere but typed, addressed card comments.
- Ask for, read, print or move keys: the board key lives in the environment's credential or the Owner's key store only.
