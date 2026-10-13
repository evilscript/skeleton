# Moving cards: the status and condition rules

`docs/CONSTITUTION.md` section 4 lists the statuses and what each one means. This document says **how a card moves**: who may make each
move, on which fact, what else must happen in the same minute, and which **conditions** a card can be in inside one status. If this
document and the Owner's words disagree, the Owner's words win and the Lead corrects the document.

## 1. Rules for every move

1. **A status follows a fact, in the same minute.** The move is part of the action that made it true, in the same command batch (the
   Lead moves the card while it merges, not later).
2. **Only the role named in the table moves a card.** The Owner (`{{OWNER_BOARD_NAME}}`) may move any card anywhere at any time, and the
   Owner's last move stands: nobody moves back a card the Owner moved last, and the Lead's status audit leaves it alone.
3. **Every move leaves its trace.** The table names the comment that goes with it, so the thread shows why the card is where it is. The
   Owner's own moves need no comment.
4. **One step at a time.** The only shortcuts are the ones marked ★. Nobody skips a status because it looks like a formality.
5. **Backwards only by the listed events** (moves 6 and 14). Nobody moves a card back to tidy up.
6. **Done is the Owner's alone.** No agent moves a card to `done`, reopens a done card or reminds the Owner about one.
7. **Check after you move:** `node tools/board.mjs show <card>` and `thread <card>` must show the status and the comment.

## 2. The moves

| # | From | To | Who | The fact | Also, in the same minute |
|---|---|---|---|---|---|
| 1 | (new) | `backlog` | anyone | a request exists | the card is made first (`board new`); the Owner's words are its description |
| 2 | `backlog` | `todo` | the Owner | the Owner wants work to start | the Owner sets the priority; the Lead's listener hears it (the trigger) |
| 3 | `todo` | `todo` (handed out) | the Lead | the card is clear | not a move: `board set <card> --assignee <identity>` and an `assign` comment; one type chip and one area chip are added |
| 4 | `todo` | `progress` | the assigned Developer | it starts the work | its `started` comment first. The Lead never sets `progress` |
| 5 | `progress` | `pr_review` | the Lead | a `review` comment with a pull request link arrived and the pull request is open | the Lead reviews now and answers with a "Lead review" comment and a label on the pull request |
| 6 | `pr_review` | `progress` | the Developer | it takes the card up again after "Lead review: changes needed" or `QA: fail` | a short `note` on what it changes; the `Sent back` chip is removed (section 4) |
| 7 | `pr_review` | `on_main` | the Lead | the pull request is merged into `{{DEFAULT_BRANCH}}` | a `merged` comment; the label `Lead: merged` |
| 8 ★ | `pr_review` | `on_prod_qa` | the Lead | a board change merged and deployed at once under a standing word (constitution section 3, rule 20) | the `merged` comment says it is live |
| 9 | `on_main` | `on_prod_qa` | the Lead | the release is tagged or the deploy is done | read `board list --status on_main` first and move **every** card that is in it; test steps are on each card (rule 16) |
| 10 | `on_main`, `pr_review` | `probe_needed` | the Lead | the check can only be run by the Owner by hand and the thing is in a build or deploy the Owner has | numbered steps in a comment; the Owner pastes the short result |
| 11 | `progress` | `spike_ready` | the Lead | a research card's report is pushed to `{{DEFAULT_BRANCH}}` | a comment with the report's path |
| 12 | `spike_ready`, `probe_needed` | `done` | the Owner | the Owner read the report and made the cards for what to build, or pasted the probe's result | none |
| 13 | `on_prod_qa` | `done` or `qa_later` | the Owner | tested (`done`), or cannot test yet (`qa_later`) | none. `qa_later` goes back to `on_prod_qa` or on to `done` by the Owner only |
| 14 | `on_prod_qa` | `progress` | the Owner, or the Lead on the Owner's comment | the Owner's test failed | the Owner's comment says what to change; the Lead reads it, adds the `Sent back` chip and posts a new `assign` comment to the same Developer (constitution section 3, rule 18); the loop restarts at move 4 |
| 15 | any | `done` or any status | the Owner | the Owner decides | none |

## 3. Moves nobody makes

- The Lead never sets `progress`, `done` or `qa_later`, never moves the Owner's own cards, and never starts work from `backlog`.
- A Developer never sets `pr_review`, `on_main`, `on_prod_qa`, `probe_needed`, `spike_ready` or `done`.
- QA moves no card at all (its key is limited); its result is a `note` on the card and a label on the pull request.
- No card goes to `on_main` without a merged pull request, and none to `on_prod_qa` that is not in a release or deploy.

## 4. Conditions inside a status

A **condition** is a fact about a card that decides what happens next although the status does not change. The fact itself always lives
in the thread (the last typed comment and who it is addressed to), the assignee and the labels on the pull request. Three conditions are
also shown as **condition chips**, so that anyone looking at the board sees them: `Blocked`, `Waiting for the Owner` and `Sent back`.
They are the only chips that are ever removed (the type and area chips never are). `board chip <card> +Blocked` adds one,
`board chip <card> -Blocked` removes it; the chip appears on its own the first time it is used.

| Status | Condition | The fact | Recorded by | What happens next |
|---|---|---|---|---|
| `todo` | not handed out | no assignee, or no `assign` comment | nobody (it is the default) | the Lead hands it out at once if the card is clear |
| `todo` | handed out | assignee and `assign` comment, no `started` yet | the Lead's `assign` | the Developer starts; no `started` in one pass (30 minutes): read the thread; two hours: tell the Owner |
| `todo`, `backlog` | **Waiting for the Owner** | the last comment is a `question` to the Owner | whoever asks adds the chip | the Lead hands nothing out; when the Owner answers on the card, the Lead removes the chip |
| `progress` | working | `started`, no `review` yet | the Developer's `started` | the Developer finishes and posts `review` |
| `progress` | **Blocked** | the last comment is a `blocked` or `question` from the assignee, addressed to the Lead | the Developer adds the chip | the Lead answers with a `decision` within one pass and removes the chip |
| `progress` | **Sent back** | the card came back from move 6 or move 14 | the Lead adds the chip when it sends the card back | the Developer works on it and removes the chip with its new `review` |
| `pr_review` | waiting for the Lead's review | `review` arrived, no "Lead review" after it | nobody | the Lead reviews on arrival |
| `pr_review` | changes needed | "Lead review: changes needed" and the label `Lead: changes needed` | the Lead | move 6 when the Developer takes it up |
| `pr_review` | ready to merge | "Lead review: ready to merge" | the Lead | merged in the next merge batch (move 7) |
| `pr_review` | QA passed or failed | the label `QA: pass` or `QA: fail` and QA's `note` | QA | pass: nothing changes; fail: the card is changes needed |
| `pr_review` | needs the Owner | the label `Needs the owner` and a `question` to the Owner | the Lead | the Owner answers on the card; **Waiting for the Owner** applies |
| `on_main` | waiting for a release or deploy | merged, not released | nobody | move 9 |
| `on_prod_qa` | waiting for the Owner's test | released or deployed, steps on the card | nobody | move 13, or move 14 on a failure |
| `probe_needed` | waiting for the Owner's result | numbered steps on the card | nobody | move 12 |
| `spike_ready` | waiting for the Owner's decision | the report is pushed | nobody | move 12 |
| `qa_later` | waiting until the Owner can test | the Owner's move | the Owner | back to `on_prod_qa` or `done` (the Owner) |

Rules for conditions:

1. A condition is recorded in the same minute it becomes true or false, like a status. The one who makes it true adds the chip; the one
   who reads the answer removes it.
2. A card may carry `Blocked` and `Waiting for the Owner` together; `Sent back` ends at the next `review`.
3. The listener's status audit (`node tools/auto-run/watch.mjs --role lead --audit`) checks statuses against the pull requests and
   releases. It does **not** check the chips: before the Lead reports to the Owner it lists the cards with `Blocked` or `Waiting for the
   Owner` (`board list --chip Blocked`) and handles every one that has no action waiting on it.
4. Nothing here changes who decides what: a condition tells the next reader what to do, it never replaces a comment.

## 5. The commands

```bash
node tools/board.mjs move <card> <status>                      # a status move (the table in section 2)
node tools/board.mjs set <card> --assignee <identity>           # hand out; the status stays
node tools/board.mjs chip <card> +Blocked                       # a condition chip (and -Blocked to remove it)
node tools/board.mjs comment <card> "..." --to <identity> --type assign|started|review|merged|decision|question|blocked|note
node tools/board.mjs show <card>                                # status, assignee, chips
node tools/board.mjs thread <card>                              # the comments: every move needs its trace
node tools/board.mjs list --status on_main                      # before a release: every card that is in it
```
