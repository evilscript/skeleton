---
name: auto-run
description: The Lead's two working modes. Auto-run mode (overnight, the Owner is away) hands the To do cards out as one priority queue through a PM sub-agent, reviews and merges the Developers' pull requests in batches at fixed ticks, and stops by itself. Duty mode (daytime, the Owner is around and writing cards) wakes the Lead on every board or pull request event through the shared listener, triages and hands out each new card at once, reviews pull requests on arrival, and never stops by itself. Use it when the Owner says the words for either mode (defaults "auto-run mode" and "duty mode"; AGENTS.md or docs/CONSTITUTION.md section 6 may list other words) and when the Owner says stop. Start at once without asking. Never releases.
---

# Auto-run mode and duty mode

Both modes use the same board protocol, the same review, the same merge script and the rules below. **Auto-run** is the overnight
one: a queue is handed out once, timers drive it, and it finishes by itself. **Duty mode** is the daytime one: events drive it and
it ends only on the Owner's word (see "Duty mode" further down). Pick by the Owner's word; if the Owner says neither, auto-run is for
"I am away", duty mode for "I am working with you". The Owner's word is the go-ahead: **start executing, ask nothing**. Reply to the
Owner in {{REPLY_LANGUAGE}}, short and plain, times in {{TIMEZONE}}, numbers always with titles.

Background to read first: `docs/CONSTITUTION.md` (sections 3 to 6 and the lessons in section 8), `docs/roles/lead.md`, `AGENTS.md`
("Pull request routine"), `docs/DEVELOPING.md`.

How it works: the Developers are reached **only through typed, addressed card comments on the board**
(`node tools/board.mjs comment <card> "..." --to <board name> --type assign|review|merged|decision|question`). Everything the Lead might
say in a pull request comment goes into the card; the pull request keeps only its labels. Two jobs run side by side in auto-run mode:
a **PM sub-agent** (`pm-agent.md`, a fresh one per pass) hands cards out and watches the cards; the Lead does the review and merge rounds
("Each tick"). Use the board name of the Lead as `BOARD_AS` for every command here; `docs/TEAM.md` lists who is who.

## Start of auto-run mode (all of it, in this order, no questions)

1. **Check.** `git status` clean on `{{DEFAULT_BRANCH}}`, `git fetch`, nothing of yours half-merged. Read the board:
   `node tools/board.mjs list --status todo` (the cards the Owner wants worked on; top to bottom is the Owner's order; **only these
   are handed out**: a new card lands in backlog and nobody starts work from backlog), `list --col progress` (in progress, PR reviewing,
   On Main), an unclear card is asked about, not guessed (`docs/CONSTITUTION.md` section 3 rule 17). Read each candidate card
   (`show`, `brief`).
2. **Build the queue.** The Owner leaves the size to the Lead (more than about fifteen cards a night only if they are small).
   - **In:** To do cards assigned to a Developer, and unassigned code requests (to the Developer with the fewest open cards, unless the
     Owner dedicated one). Cards for a Developer in a cloud session get their `assign` comment like the others (see "A Developer that is
     not listening").
   - **Out (the skip list, each with its reason):** the Owner's own cards (never touch or move them); the Lead's own cards; cards that need
     the Owner's data or decision; research without a scope; anything waiting on something only the Owner can produce.
   - **Order:** the Owner's **priority field first** (Blocker > Critical > Major > Minor, read the exact values from the board; the
     Owner's value is never changed; ties keep the To do column's order). For a card without one, decide a priority on the same scale
     (the Owner's freshest complaints high, small scattered cards in the middle, big or risky ones last) and say it in the `assign`
     comment, never in the Owner's field.
   - **Hint** for each card: 2 to 5 lines, where the code is, what is risky, what to ask first on a vague card, the result that counts.
     Signposts only, no requirements of your own.
3. **State files** (local, in your member folder, for example `reports/<date>-pm.md` and `reports/<date>-prs.md`; git ignores the member
   folder): the PM file holds the skip list with reasons, the queue table (priority, card, chips to add, status), the hints, an in-flight
   table and a log; the pull request file holds a table (pull request, card, head, your approach, the Developer's approach, differences,
   verdict, what you changed) and the sections "Questions for the Owner" and "Log".
4. **Schedule** (timers that live only while this session is open; they expire after some days):
   - **Review and merge round, at :00 and :30** (or the interval you chose, constitution section 3 rule 14), recurring, prompt:
     `Auto-run tick: follow .claude/skills/auto-run/SKILL.md, section "Each tick". The report file is <path>. Talk to the Developers only through board card comments. Do not release.`
   - **Board check every 15 minutes, off the :00/:30 marks** (for example minutes 5, 20, 35 and 50), plain command-line calls, no sub-agent
     unless needed. Prompt: `Board check: follow .claude/skills/auto-run/SKILL.md, section "Board check". State files: <paths>. Never look at GitHub in this job. If nothing needs doing, answer with nothing or one short line.`
   - The PM sub-agent has no timer: it runs when the board check (or the start) calls for it.
   - Run the **first PM pass at once**, without waiting for a timer: it hands the whole queue out in one go, and each Developer then works
     through it in priority order without idling.
5. Keep the machine awake (the runtime's keep-awake option), then tell the Owner in at most eight lines: the queue (priority list), what
   is skipped and why, the first tick time, that the timers live only while this session is open and the machine stays awake, and the
   word to stop.

`node tools/auto-run/report.mjs [--since 12h]` prints a status report in one go (merged, open, what waits for whom, what looks stuck,
the status audit): for the morning report and for "what is going on". Cards the Owner closed are not in it.

## Usage rule (auto-run mode; duty mode has its own guard)

Read GitHub **only** at the ticks, never in between (the Owner asking directly is the only exception). The PM passes read the board
only. Every tick merges **all** ready pull requests together as one batch with one run of the checks, so there are at most two runs an
hour.

## Board check (auto-run mode: every 15 minutes, command line only)

The Developers' updates (`started`, `review`, `question`, `blocked`) arrive **only as card comments on the board**. So the board is read
often and cheaply: `node tools/board.mjs version` (a one-row read), `inbox` and `feed --limit 15`, as the Lead. Never GitHub here.

1. Comments addressed to the Lead. A `question` or `blocked` is answered at once with a `decision` comment, short and concrete; a product
   question only the Owner can decide goes into the report under "Questions for the Owner", and the Developer gets "take the simplest
   reading, say so in the pull request". A `review` is logged (the pull request is reviewed at the next tick). A `started` is logged (the
   Developer moves its own card from To do to In progress; the Lead never does, and the Owner's cards are never moved).
2. **Call the PM sub-agent only when one of these holds**, with the reason in its prompt: a new card in To do that is neither in the queue
   nor on the skip list, or a changed priority; one of our `assign` comments has had no `started` for 30 minutes (first confirm with
   `board thread` that the comment exists); a card in progress whose Developer has been silent for three hours; the queue is not fully
   handed out.
3. Nothing to do: answer with nothing, or one short line. Update the report log only when something happened.
4. The same job decides the end: it feeds the "Finish" conditions.

## Each tick

1. `gh pr list --state open --json number,title,headRefName,headRefOid,updatedAt`. Skip pull requests whose head already has a verdict in
   the report. Nothing new: one line and stop.
2. Do not start a second merge while one of yours is still running (an unfinished run, a scratch branch checked out). The main checkout
   must be clean; do not touch the other members' work trees. Review now, merge next tick.
3. **Review each pull request.** First `node tools/auto-run/review-prep.mjs <pr>`: size, files by kind, whether it is documentation only,
   which template sections are filled, whether code changed without a test, and whether the card has your review after the last commit.
   It says where to look and decides nothing. Then read the card (`node tools/board.mjs show <card>`, `thread <card>`), decide how you
   would do it, and compare with the diff. Check: the project's hard rules and conventions (`docs/DEVELOPING.md` sections 4 and 5), tests
   and checks for the new code, the template filled, and **which other checks the change can reach** (a shared mechanism: run those
   before the merge run; it saves a failed batch). Write the review **on the card**, headed "Lead review": ready to merge, or changes
   needed (your own approach and how it differs); concrete and short, `--type review --to <developer>`. Label the pull request
   (`Lead: changes needed` and the card goes back to the Developer, `Needs the owner`; the product questions go to the report). Small
   problems (a few lines) are fixed while merging; say so in the comment. With a QA member, a pull request is ready only with
   `QA: pass` for its current head.
4. **Merge the ready pull requests together:** `node tools/auto-run/merge-pr.mjs <pr> [<pr>...]`, as a direct background command.
   It refuses a pull request without your `review` on its card after the last commit (and, with a QA member, without `QA: pass`), makes
   a scratch work tree off `origin/{{DEFAULT_BRANCH}}`, merges each pull request with `--no-ff`, runs the **minimum scope**
   (`checks.command`), fast-forwards and pushes `{{DEFAULT_BRANCH}}`, moves each card to On Main, posts the `merged` comment, labels the
   pull request `Lead: merged`, cleans up and runs the status audit. `--tests none` for a documentation-only batch (say so on the
   cards), `--dry-run` tries everything but the publishing. The full suite is not part of a merge: it runs when deploying
   (`docs/CONSTITUTION.md` section 3 rule 12). Never bypass a hook or a failing check.
   - Exit 3 (a merge conflict, the work tree is left): merge the independent pull requests, leave the conflicting one to its
     Developer ("merge `{{DEFAULT_BRANCH}}` in and resolve it", on the card).
   - Exit 4 (the checks failed): find whose failure it is: run the failing check on plain `{{DEFAULT_BRANCH}}` and on the batch. Fix small
     things yourself and say so on the card; otherwise drop the pull request from the batch, label it `Lead: changes needed`, and say why
     on the card.
   - Update any changelog or list of pending tests the project keeps (`docs/DEVELOPING.md` section 9) as part of the merge.
5. After the merge, the `merged` comment says what you changed and what to watch. When a pull request arrives, set its card to PR
   reviewing (`node tools/board.mjs move <card> pr_review`); at the release or deploy, every On Main card in it goes to On Prod for QA
   (read `board list --status on_main` first, L15). **Chips:** every card in progress or merged has one type and one area; add what is
   missing, never remove.
6. Append every pull request to the report. Keep the chat reply to one to four short lines; interrupt the Owner only when the Owner
   must decide something now.

## Rules learned

- Hand out the whole queue at once, in priority order, each `assign` comment with its place in the queue ("2 of 7", added with
  `assign.mjs --note-file`) and no "wait for card X": the Lead gives no instruction the Owner did not give; overlapping pull requests
  are settled at merge time.
- Background sub-agents die without a report when the Owner interrupts. Verify before saying "waiting" (the runtime's agent list, task
  status, log time); if one died, do its work yourself (L2).
- A failed run costs a whole extra run: before starting a batch, run the checks a pull request's change can reach (L3).
- The PM sub-agent costs a lot of tokens per pass: it runs on demand (the start, a new or re-prioritized card, a missing acknowledgement, a
  stuck card); the board check reads the comments for free in between (L5).
- A request to a Developer is a typed, addressed card comment, nothing else: a description edit or a pull request comment is never seen.
  After posting, check that `board thread <card>` shows it. A card with no answer for a pass: read the thread before blaming; two hours:
  tell the Owner (L1).
- Start background work as a direct background command, never a `( ... ) &` subshell (it is lost). Redirect stdin from `/dev/null` for
  anything that might read it. Check `git status` before touching a tree an interrupt may have left (L8).
- At the end of every run, add its lessons to `docs/CONSTITUTION.md` section 8.

## A Developer that is not listening

A Developer in a cloud session listens only while its listening is on (`.claude/skills/board-listen/SKILL.md`). No `started` within a pass
means the Owner has not switched it on or the session cannot reach the board: say so in the report, and do not hand the card to another
Developer. Its pull requests go through the same ticks as everyone else's.

## Pull requests that change the board (`board/`)

They are handled in the same round, whoever opened them. There is no product check command for them: the checks are the board's
(`board/README.md`): in `board/`, `npm run check && npm test`. Under the Owner's standing word for board deploys
(`docs/CONSTITUTION.md` section 3 rule 20) merge and deploy right after the review; without one, ask the Owner. A change with a migration:
test it on a copy of the production data first (L12), then `npm run backup`, `npm run db:remote`, and `npm run deploy` straight away
(`board/docs/MAINTENANCE.md`). The card goes to PR reviewing, On Main, then On Prod for QA after the deploy. This is not a release of the
product, which still waits for the Owner's word. One pipeline at a time: finish a deploy before starting the next.

## Duty mode (daytime)

The Owner is awake: writing cards, answering questions and testing. Nothing is queued in advance; **events drive it**, and the model is
called only when there is an event. A reviewed pull request is merged at once; the slot line is a reminder, not a gate.

### Start

1. The same checks as auto-run Start 1 (clean `{{DEFAULT_BRANCH}}`, `git fetch`, nothing half-merged, the board read). Cards already in To do
   for the Developers are triaged first, one by one, like new-card events.
2. Start the shared listener in stream style, with the runtime's background monitor:
   `node tools/auto-run/watch.mjs --as <the Lead's board name> --role lead`
   (`docs/CONSTITUTION.md` section 6; state in `~/.boardkit/{{PROJECT_SLUG}}/`). Monitors usually expire after about 30 minutes:
   **re-arm it on every expiry notice**, quietly; its state file remembers what was reported, so a re-arm reports only what is new, but
   a card that arrived while it was off is not reported afterwards, so list To do once by hand after each re-arm. It
   polls the board's one-row version every 30 seconds (cards and comments only when it changed) and GitHub's open pull requests every
   60 seconds, and costs no model tokens. The first run prints two `[watch] baseline` lines: check them, that proves it works. If the
   runtime has no background monitor use `--wake` or `--once` (`docs/CONSTITUTION.md` section 6) and tell the Owner. Keep the machine awake.
3. Write a log file (local, in your member folder, for example `reports/<date>-duty.md`): a table (time, event, what you did) and the
   list of pull requests with the head reviewed. Update it only when something happened.
4. Tell the Owner in at most five lines: duty mode is on, what it watches, the slot times, that it lives only while this session is
   open (the machine must stay awake) and the word to stop.

### What each event means and what the Lead does

Inline, one card at a time. Every line from the listener starts with a tag. Handle it, then wait for the next; answer the Owner with
nothing or one short line when something was handled.

- **`[status] ...`** (the Lead's own audit of statuses against the facts): **handle before anything else except the Owner's words.** Do
  the move it names (`node tools/board.mjs move` or `chip`), then `node tools/auto-run/watch.mjs --as <the Lead's board name> --role lead --audit`
  must print that statuses match the facts. A `(still)` prefix means it was said before and nobody fixed it. Never move a card the Owner
  moved last (the audit skips those).
- **`[card] new ...`, `moved ... -> todo`, `assignee ...`, `priority ...`** (a card in To do or In progress; a new card in backlog is
  silent: nobody starts it until the Owner moves it to To do): **triage at once.**
  - A card that is **not clear** (two readings with different results, no way to reproduce, a product choice): a `question` to the Owner
    on the card with your recommendation, tell the Owner in chat at once, and hand nothing out until he answers. A request that is
    really a setting or already works: answer on the card (`--to {{OWNER_BOARD_NAME}} --type note`, where to change it).
  - The Owner's own cards: ignore; never move them or comment-assign them. An unassigned card: code to a Developer by load, unless the
    Owner dedicated one; research, release and data to the Lead; what needs the Owner's data or decision stays with the Owner, with a
    `question`. A card the Owner assigned to a Developer himself: just start it by handing it out.
  - A card to hand out: priority is the Owner's field (never change it; when it is empty you decide one and say it in the `assign`
    comment). Chips: one type and one area, never remove. Write the hint (2 to 5 lines).
  - Hand out with one command: `node tools/auto-run/assign.mjs <card> <developer board name> [--hint "..."] [--docs] [--dry-run]`. It
    sets the assignee, posts the `assign` comment built from the card (branch name, priority, the checks to run, your hint) and checks that
    `board thread` shows it. **The card stays in To do; the Lead never moves it to In progress** (the Developer does when it starts).
  - A card too big for one pull request: split it yourself before handing out (`board new` with the Owner's words quoted in each, chips,
    the Owner's priority), list the smaller cards in a comment on the big card, and hand each out. No packages of one card.
  - A vague card, or one that needs the Owner's data or a product choice: do not hand it out; comment `--to {{OWNER_BOARD_NAME}} --type question`
    with a recommendation.
  - Several new cards at once (five or more, or the Owner asking for a whole plan): ordering them is a PM job, so one PM sub-agent
    pass (`pm-agent.md`) is worth its tokens then.
- **`[comment] ... -> <Lead> ...`**: `question` or `blocked`: answer at once with a `decision` (short, concrete); a product question
  only the Owner can decide goes to the Owner as a `question`, and the Developer gets "take the simplest reading, say so in the pull
  request". `review`: review the pull request now (below) and say so on the card. `started`: log it. A comment by the Owner: do what it
  says, on the card. A comment to someone else: read it, act only when it needs the Lead. A line saying a comment is under the Lead's
  name but signs as another member: that member's wrapper used the wrong identity (L18); tell it to set its own `BOARD_AS`.
- **`[pr] ... opened` / `new head`**: **review on arrival** (the "Each tick" step 3 checklist: read the card first, decide how you
  would do it, then read the diff, predict which checks it reaches). Write the "Lead review" on the card and set the pull request label.
  Record the head you reviewed in the log; a new head needs a new look. A pull request you reviewed as ready is merged at once with
  `node tools/auto-run/merge-pr.mjs <pr>` (with a QA member, once it has `QA: pass` for that head).
- **`[slot] HH:MM: N pull request(s) open`**: a reminder. Take the pull requests that are reviewed as ready at their current head and not
  merged yet (waiting for QA's pass or for a busy merge slot), at most five, oldest first, and merge them as one batch with
  `merge-pr.mjs`. If an earlier batch is still running or a scratch branch is checked out, skip this slot and say so in the log. A pull
  request not reviewed yet gets reviewed now.
- **`[no-ack] ...`**: `board thread <card>` first. The `assign` comment is missing from the thread: post it again (the error is ours).
  It is there and the Developer is silent: tell the Owner after two hours, not before. A cloud Developer may simply have its listening
  off: say that, and do not hand the card to another Developer.
- **`[stuck] ...`**: read the thread, ask the Developer a `question` (what is blocking, what is left); tell the Owner one line.
- **`[watch] ... unreachable`**: check `node tools/board.mjs version` and `gh auth status`. Back within ten minutes: nothing to say.
  Longer: tell the Owner the cause (the error text, not a guess).

### Usage guard

At every other slot (about hourly) check the usage limits with the runtime's own report. The Owner sets the percentages; the defaults
are **85 %** of the 5-hour or the weekly limit: batch mode, meaning only the Owner's comments and `blocked` at once, everything else at
the slots, no PM sub-agent; tell the Owner once. **95 %**: stop the listener, finish a merge that is running, tell the Owner and wait
for the word.

### Rules specific to duty mode

- One merge pipeline at a time, never two scratch branches. The Owner's own edits to the main checkout: check `git status` before
  touching it.
- Do not read GitHub between events (the listener does), and do not poll the board by hand either.
- **No automatic finish.** It ends when the Owner says to stop: stop the listener, finish a merge that is running first, and report in the
  chat: merged (with pull request and card, titles included), in review, stuck, waiting for the Owner, failed runs and why, usage, and that
  nothing was released.
- The mode is bound to this session. When the context passes about 90 %, write the state into memory before it compacts (L13); after a
  compaction re-arm the listener and read its log.
- Everything in "Rules learned", "Pull requests that change the board" and "Never" applies unchanged.

## Finish (auto-run mode)

The mode ends **by itself** when all of this holds for two ticks in a row: the queue is out, no pull request is open, no Developer card
waits in To do for its start (an `assign` with no `started`: list it in the report as "no response"), none is in progress except ones
whose Developer has been silent for three hours (list those as stuck), and nothing was merged. Then: delete both timers, make sure
no background task of yours is left running (a batch, a monitor), and give the report in the chat, short: what merged (pull request and
card), what was sent back and why, what is stuck, what waits for the Owner ("Questions for the Owner"), what each failed run was and how
it was fixed, the usage, and that nothing was released. Add the run's lessons to `docs/CONSTITUTION.md` section 8.

The Owner can stop it earlier with the word to stop: the same steps, finishing a merge that is already running first.

## Optional last job under a standing word

If the Owner granted a standing word for it (`docs/CONSTITUTION.md` section 3 rule 20: all on `{{DEFAULT_BRANCH}}`, then the full suite,
then deploy, while the Owner sleeps), check on every listener event and every re-arm: no card In progress or PR reviewing, no open pull
request, `{{DEFAULT_BRANCH}}` clean and not behind. Then, before the Owner is up, run the full suite on the release tree
(`{{FULL_SUITE}}`) and follow the release procedure in `docs/DEVELOPING.md`; a failing suite means no deploy, bisect by check name and
say so in the morning. Never while a card is being worked on, never forced. Without that standing word nothing is released.

## Never

- Release, tag, publish or deploy the product (only on the Owner's word in chat; a board deploy only under the standing word).
- Handle tokens, passwords or keys.
- Close pull requests or repositories, delete published things, or reply publicly for the project (the Owner decides).
- Touch the Owner's cards, add requirements or conditions the Owner did not give, skip the checks to save time, or talk to a
  Developer anywhere but the card.
